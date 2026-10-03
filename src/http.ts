import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  AmbiguousBookError,
  type LibraryRepository,
  RecordNotFoundError,
  type BookUpdateInput,
  type CreateBookInput,
  type SearchBooksOptions,
  type SearchSeriesOptions,
} from "./library.js";
import {
  ConversationBusyError,
  ConversationCreateError,
  ConversationNotFoundError,
  type ConversationRegistry,
  type Conversation,
} from "./conversations.js";
import {
  acceptProposal,
  listPendingProposals,
  ProposalAlreadyDecidedError,
  ProposalNotFoundError,
  rejectProposal,
  type ProposalRegistry,
} from "./proposals.js";
import {
  OpenLibraryError,
  type OpenLibraryLookupInput,
  type OpenLibraryLookupOptions,
  type OpenLibraryResult,
} from "./open-library.js";
import {
  TurnBusyError,
  type BrowserStreamEmitter,
  type BrowserStreamEvent,
  type TurnCoordinator,
  type TurnSubmitInput,
} from "./turns.js";
import {
  READING_STATUSES,
  ValidationError,
  type ReadingStatus,
} from "./normalize.js";

const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const MAX_MESSAGE_LENGTH = 100_000;
const MAX_REQUEST_ID_LENGTH = 200;
const CSRF_HEADER = "x-csrf-token";
const CSRF_MARKER = "__BOOK_EXPLORER_CSRF_TOKEN__";
const PUBLIC_DIRECTORY = fileURLToPath(
  new URL("../../public/", import.meta.url),
);
const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/app.bundle.js": {
    file: "app.bundle.js",
    type: "text/javascript; charset=utf-8",
  },
  "/fonts/inter.woff2": { file: "fonts/inter.woff2", type: "font/woff2" },
  "/fonts/source-sans-3.woff2": {
    file: "fonts/source-sans-3.woff2",
    type: "font/woff2",
  },
  "/fonts/literata.woff2": {
    file: "fonts/literata.woff2",
    type: "font/woff2",
  },
};

export const MAX_JSON_BODY_BYTES = DEFAULT_MAX_JSON_BODY_BYTES;

export interface HttpTurnCoordinator {
  submit(
    input: TurnSubmitInput,
    emit: BrowserStreamEmitter,
  ): Promise<void> | void;
  steer(conversationId: number, text: string): Promise<boolean> | boolean;
  cancel(requestId: string): Promise<boolean> | boolean;
  readonly activeRequestId?: string;
}

export interface HttpOpenLibrary {
  lookup(
    input: OpenLibraryLookupInput,
    options?: OpenLibraryLookupOptions,
  ): Promise<OpenLibraryResult> | OpenLibraryResult;
}

export interface HttpDependencies {
  [key: string]: unknown;
  library?: LibraryRepository;
  libraryRepository?: LibraryRepository;
  registry?: ConversationRegistry;
  conversations?: ConversationRegistry;
  conversationRegistry?: ConversationRegistry;
  proposalRegistry?: ProposalRegistry;
  openLibrary?: HttpOpenLibrary;
  openLibraryClient?: HttpOpenLibrary;
  turns?: HttpTurnCoordinator | TurnCoordinator;
  turnCoordinator?: HttpTurnCoordinator | TurnCoordinator;
  coordinator?: HttpTurnCoordinator | TurnCoordinator;
  /** Exact HTTP Host value. By default it is derived from the listening loopback socket. */
  host?: string;
  expectedHost?: string;
  /** Exact same-origin Origin value. By default it is http://<expected Host>. */
  origin?: string;
  expectedOrigin?: string;
  maxJsonBodyBytes?: number;
}

export type HttpServer = Server & { readonly csrfToken: string };

interface ResolvedDependencies {
  library: LibraryRepository;
  registry: ConversationRegistry;
  proposalRegistry: ProposalRegistry;
  openLibrary: HttpOpenLibrary;
  turns: HttpTurnCoordinator | TurnCoordinator;
  host?: string;
  origin?: string;
  maxJsonBodyBytes: number;
}

interface ErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "RequestBodyTooLargeError";
  }
}

function resolveDependencies(deps: HttpDependencies): ResolvedDependencies {
  if (!deps || typeof deps !== "object")
    throw new TypeError("HTTP dependencies must be an object");
  const library = deps.library ?? deps.libraryRepository;
  const registry =
    deps.registry ?? deps.conversations ?? deps.conversationRegistry;
  const openLibrary = deps.openLibrary ?? deps.openLibraryClient;
  const turns = deps.turns ?? deps.turnCoordinator ?? deps.coordinator;
  if (!library || !registry || !openLibrary || !turns) {
    throw new TypeError(
      "HTTP dependencies must include library, registry, openLibrary, and turns",
    );
  }
  if (
    typeof (library as { searchBooks?: unknown }).searchBooks !== "function"
  ) {
    throw new TypeError("HTTP library dependency is invalid");
  }
  if (typeof (registry as { list?: unknown }).list !== "function") {
    throw new TypeError("HTTP conversation registry dependency is invalid");
  }
  if (typeof (openLibrary as { lookup?: unknown }).lookup !== "function") {
    throw new TypeError("HTTP Open Library dependency is invalid");
  }
  if (
    typeof (turns as { submit?: unknown }).submit !== "function" ||
    typeof (turns as { steer?: unknown }).steer !== "function" ||
    typeof (turns as { cancel?: unknown }).cancel !== "function"
  ) {
    throw new TypeError("HTTP turn coordinator dependency is invalid");
  }
  const maxJsonBodyBytes = deps.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  if (!Number.isSafeInteger(maxJsonBodyBytes) || maxJsonBodyBytes < 1) {
    throw new TypeError("HTTP JSON body limit must be a positive integer");
  }
  return {
    library,
    registry,
    proposalRegistry: deps.proposalRegistry ?? registry,
    openLibrary,
    turns,
    host: deps.host ?? deps.expectedHost,
    origin: deps.origin ?? deps.expectedOrigin,
    maxJsonBodyBytes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string")
    throw new ValidationError(`${label} must be a string`);
  const result = value.trim();
  if (!result) throw new ValidationError(`${label} must not be empty`);
  if (result.length > maximum)
    throw new ValidationError(`${label} must be at most ${maximum} characters`);
  return result;
}

function optionalText(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, label, maximum);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new ValidationError("Request body must be a JSON object");
  return value;
}

function allowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new ValidationError(`Unknown request property: ${key}`);
  }
}

function requiredBodyValue<T>(value: Record<string, unknown>, key: string): T {
  if (!Object.hasOwn(value, key))
    throw new ValidationError(`${key} is required`);
  return value[key] as T;
}

function validateIdentifiers(value: unknown): void {
  if (!Array.isArray(value))
    throw new ValidationError("Identifiers must be an array");
  if (value.length > 20)
    throw new ValidationError("At most 20 identifiers are allowed");
  for (const identifier of value) {
    const item = objectBody(identifier);
    allowedKeys(item, ["scheme", "value", "source"]);
    requiredBodyValue(item, "scheme");
    requiredBodyValue(item, "value");
    requiredBodyValue(item, "source");
  }
}

function validateBookCreateBody(body: unknown): CreateBookInput {
  const value = objectBody(body);
  allowedKeys(value, [
    "title",
    "author",
    "publicationYear",
    "coverUrl",
    "seriesId",
    "seriesPosition",
    "identifiers",
  ]);
  requiredBodyValue(value, "title");
  requiredBodyValue(value, "author");
  if (value.identifiers !== undefined) validateIdentifiers(value.identifiers);
  // SAFETY: allowedKeys and the repository's schema validate this object before use.
  return value as unknown as CreateBookInput;
}

function validateBookUpdateBody(body: unknown): BookUpdateInput {
  const value = objectBody(body);
  allowedKeys(value, [
    "title",
    "author",
    "publicationYear",
    "coverUrl",
    "seriesId",
    "seriesPosition",
    "status",
    "rating",
    "identifiers",
  ]);
  if (value.identifiers !== undefined) validateIdentifiers(value.identifiers);
  // SAFETY: allowedKeys and LibraryRepository.updateBook perform field validation.
  return value as unknown as BookUpdateInput;
}

function validateSeriesCreateBody(body: unknown): {
  name: string;
  note?: string;
} {
  const value = objectBody(body);
  allowedKeys(value, ["name", "note"]);
  requiredBodyValue(value, "name");
  return value as { name: string; note?: string };
}

function validateSeriesUpdateBody(body: unknown): {
  name?: string;
  note?: string | null;
} {
  const value = objectBody(body);
  allowedKeys(value, ["name", "note"]);
  return value as { name?: string; note?: string | null };
}

function validateArchiveBody(body: unknown): { archived: boolean } {
  const value = objectBody(body);
  allowedKeys(value, ["archived"]);
  const archived = requiredBodyValue<unknown>(value, "archived");
  if (typeof archived !== "boolean")
    throw new ValidationError("Archived must be a boolean");
  return { archived };
}

function validateMessageBody(body: unknown): {
  text: string;
  retryRequestId?: string;
} {
  const value = objectBody(body);
  allowedKeys(value, ["text", "retryRequestId"]);
  const text = requiredText(
    requiredBodyValue(value, "text"),
    "Text",
    MAX_MESSAGE_LENGTH,
  );
  const retryRequestId = optionalText(
    value.retryRequestId,
    "Retry request ID",
    MAX_REQUEST_ID_LENGTH,
  );
  return { text, retryRequestId };
}

function validateEmptyBody(body: unknown): Record<string, never> {
  const value = objectBody(body);
  allowedKeys(value, []);
  return {};
}

function validateNoteBody(body: unknown): { note: string } {
  const value = objectBody(body);
  allowedKeys(value, ["note"]);
  return { note: requiredText(requiredBodyValue(value, "note"), "Note", 4000) };
}

function validateLookupBody(body: unknown): {
  input: OpenLibraryLookupInput;
  refresh: boolean;
} {
  const value = objectBody(body);
  allowedKeys(value, ["workId", "isbn", "title", "author", "refresh"]);
  if (value.refresh !== undefined && typeof value.refresh !== "boolean") {
    throw new ValidationError("Refresh must be a boolean");
  }
  const hasWorkId = Object.hasOwn(value, "workId");
  const hasIsbn = Object.hasOwn(value, "isbn");
  const hasTitle = Object.hasOwn(value, "title");
  const hasAuthor = Object.hasOwn(value, "author");
  const count =
    Number(hasWorkId) + Number(hasIsbn) + Number(hasTitle) + Number(hasAuthor);
  if (hasWorkId && count === 1) {
    return {
      input: { workId: requiredText(value.workId, "Work ID", 200) },
      refresh: value.refresh === true,
    };
  }
  if (hasIsbn && count === 1) {
    return {
      input: { isbn: requiredText(value.isbn, "ISBN", 200) },
      refresh: value.refresh === true,
    };
  }
  if (hasTitle && hasAuthor && count === 2) {
    return {
      input: {
        title: requiredText(value.title, "Title", 300),
        author: requiredText(value.author, "Author", 300),
      },
      refresh: value.refresh === true,
    };
  }
  throw new ValidationError(
    "Provide exactly one work ID, ISBN, or title and author",
  );
}

function validateProposalAcceptBody(body: unknown): { value: unknown } {
  const value = objectBody(body);
  allowedKeys(value, ["value"]);
  return { value: requiredBodyValue(value, "value") };
}

function parseInteger(
  value: string | null,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value))
    throw new ValidationError(`${label} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new ValidationError(`${label} is out of range`);
  }
  return number;
}

function queryKeys(url: URL, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key))
      throw new ValidationError(`Unknown query property: ${key}`);
    if (seen.has(key))
      throw new ValidationError(`Duplicate query property: ${key}`);
    seen.add(key);
  }
}

function pageQuery(
  url: URL,
  allowed: readonly string[] = [],
): { limit: number; offset: number } {
  queryKeys(url, [...allowed, "limit", "offset"]);
  const limit =
    parseInteger(url.searchParams.get("limit"), "Limit", 1, MAX_PAGE_LIMIT) ??
    DEFAULT_PAGE_LIMIT;
  const offset = parseInteger(url.searchParams.get("offset"), "Offset", 0) ?? 0;
  return { limit, offset };
}

function bookSearchQuery(url: URL): SearchBooksOptions {
  const page = pageQuery(url, ["query", "status", "rating", "seriesId"]);
  const query = url.searchParams.get("query") ?? undefined;
  if (query !== undefined && query.length > 200)
    throw new ValidationError("Query must be at most 200 characters");
  const status = url.searchParams.get("status") ?? undefined;
  if (
    status !== undefined &&
    !(READING_STATUSES as readonly string[]).includes(status)
  ) {
    throw new ValidationError("Invalid reading status");
  }
  const rating = parseInteger(url.searchParams.get("rating"), "Rating", 1, 5);
  const seriesId = parseInteger(
    url.searchParams.get("seriesId"),
    "Series ID",
    1,
  );
  return {
    query,
    status: status as ReadingStatus | undefined,
    rating,
    seriesId,
    ...page,
  };
}

function seriesSearchQuery(url: URL): SearchSeriesOptions {
  const page = pageQuery(url, ["query"]);
  const query = url.searchParams.get("query") ?? undefined;
  if (query !== undefined && query.length > 200)
    throw new ValidationError("Query must be at most 200 characters");
  return { query, ...page };
}

function conversationListQuery(url: URL): {
  archived?: boolean;
  limit: number;
  offset: number;
} {
  const page = pageQuery(url, ["archived"]);
  const raw = url.searchParams.get("archived");
  if (raw === null) return page;
  if (raw !== "true" && raw !== "false")
    throw new ValidationError("Archived must be true or false");
  return { archived: raw === "true", ...page };
}

function positiveId(value: string, label: string): number {
  const parsed = parseInteger(value, label, 1);
  if (parsed === undefined) throw new ValidationError(`${label} is required`);
  return parsed;
}

function decodeSegment(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) throw new Error("empty");
    return decoded;
  } catch {
    throw new ValidationError(`Invalid ${label}`);
  }
}

function errorShape(error: unknown): {
  status: number;
  body: { error: ErrorShape };
} {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }
  if (error instanceof RequestBodyTooLargeError) {
    return {
      status: 413,
      body: {
        error: {
          code: "payload_too_large",
          message: error.message,
          retryable: false,
        },
      },
    };
  }
  if (error instanceof AmbiguousBookError) {
    return {
      status: 409,
      body: {
        error: {
          code: "ambiguous_book",
          message: error.message,
          retryable: false,
          details: { candidates: error.candidates },
        },
      },
    };
  }
  if (
    error instanceof ValidationError ||
    error instanceof TypeError ||
    error instanceof SyntaxError
  ) {
    return {
      status: 400,
      body: {
        error: {
          code: "invalid_input",
          message: error instanceof Error ? error.message : "Invalid input",
          retryable: false,
        },
      },
    };
  }
  if (
    error instanceof ConversationNotFoundError ||
    error instanceof RecordNotFoundError ||
    error instanceof ProposalNotFoundError
  ) {
    return {
      status: 404,
      body: {
        error: { code: "not_found", message: error.message, retryable: false },
      },
    };
  }
  if (error instanceof ConversationCreateError) {
    return {
      status: 409,
      body: {
        error: { code: error.code, message: error.message, retryable: false },
      },
    };
  }
  if (
    error instanceof ConversationBusyError ||
    error instanceof ProposalAlreadyDecidedError ||
    error instanceof TurnBusyError
  ) {
    const code = error instanceof TurnBusyError ? "global_busy" : error.code;
    const retryable = !(error instanceof ProposalAlreadyDecidedError);
    return {
      status: 409,
      body: { error: { code, message: error.message, retryable } },
    };
  }
  if (error instanceof OpenLibraryError) {
    let status = 500;
    if (error.code === "not_found") status = 404;
    else if (error.code === "rate_limited") status = 429;
    return {
      status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      },
    };
  }
  if (
    error instanceof Error &&
    /^SQLITE_CONSTRAINT/u.test(
      ((error as { code?: unknown }).code as string) ?? "",
    )
  ) {
    return {
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "The requested change conflicts with existing data",
          retryable: false,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "Internal server error",
        retryable: true,
      },
    },
  };
}

function serveStatic(
  path: string,
  response: ServerResponse,
  csrfToken: string,
): boolean {
  const file = STATIC_FILES[path];
  if (!file) return false;
  let payload = readFileSync(join(PUBLIC_DIRECTORY, file.file));
  if (file.file === "index.html") {
    const shell = payload.toString("utf8");
    if (!shell.includes(CSRF_MARKER)) {
      throw new Error("Static shell is missing its CSRF marker");
    }
    payload = Buffer.from(
      shell.replace(CSRF_MARKER, JSON.stringify(csrfToken)),
      "utf8",
    );
  }
  response.writeHead(200, {
    "content-type": file.type,
    "content-length": payload.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
  return true;
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function emptyResponse(response: ServerResponse): void {
  response.writeHead(204, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end();
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string") {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      request.resume();
      throw new RequestBodyTooLargeError();
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        request.resume();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    throw new HttpError(
      400,
      "invalid_input",
      "Unable to read request body",
      false,
    );
  }
  if (chunks.length === 0)
    throw new ValidationError("Request body is required");
  let text: string;
  try {
    text = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("Request body must contain valid JSON");
  }
}

function isJsonContentType(request: IncomingMessage): boolean {
  const value = request.headers["content-type"];
  if (typeof value !== "string") return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function addressHost(server: Server): string | undefined {
  const address = server.address();
  if (!address || typeof address === "string") return undefined;
  const host =
    address.address.includes(":") && !address.address.startsWith("[")
      ? `[${address.address}]`
      : address.address;
  return `${host}:${address.port}`;
}

function expectedHost(server: Server, configured?: string): string {
  const socketHost = addressHost(server);
  const host =
    configured === undefined
      ? (socketHost ?? "127.0.0.1")
      : socketHost && configured === "127.0.0.1"
        ? socketHost
        : configured;
  try {
    return new URL(`http://${host}`).host;
  } catch (cause) {
    throw new TypeError("Configured HTTP host is invalid", { cause });
  }
}

function expectedOrigin(deps: ResolvedDependencies, host: string): string {
  try {
    return new URL(deps.origin ?? `http://${host}`).origin;
  } catch (cause) {
    throw new TypeError("Configured HTTP origin is invalid", { cause });
  }
}

function isStateChangingMethod(method: string): boolean {
  return (
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
  );
}

// ponytail: aliasing applies only to loopback names; the app refuses non-loopback binds, so no other host ever gets an alias.
function loopbackAliases(hostOrOrigin: string): Array<string> {
  const schemeEnd = hostOrOrigin.indexOf("://");
  const prefix = schemeEnd === -1 ? "" : hostOrOrigin.slice(0, schemeEnd + 3);
  const authority = schemeEnd === -1 ? hostOrOrigin : hostOrOrigin.slice(schemeEnd + 3);
  const colon = authority.indexOf(":");
  const hostname = colon === -1 ? authority : authority.slice(0, colon);
  const suffix = colon === -1 ? "" : authority.slice(colon);
  const alias =
    hostname === "127.0.0.1"
      ? "localhost"
      : hostname === "localhost"
        ? "127.0.0.1"
        : undefined;
  return alias === undefined
    ? [hostOrOrigin]
    : [hostOrOrigin, `${prefix}${alias}${suffix}`];
}

function requireMutationSecurity(
  request: IncomingMessage,
  server: Server,
  deps: ResolvedDependencies,
  csrfToken: string,
): void {
  const host = expectedHost(server, deps.host);
  if (!loopbackAliases(host).includes(request.headers.host ?? "")) {
    throw new HttpError(
      403,
      "invalid_host",
      "Request Host is not allowed",
      false,
    );
  }
  if (
    !loopbackAliases(expectedOrigin(deps, host)).includes(
      request.headers.origin ?? "",
    )
  ) {
    throw new HttpError(
      403,
      "invalid_origin",
      "Request Origin is not allowed",
      false,
    );
  }
  if (request.headers[CSRF_HEADER] !== csrfToken) {
    throw new HttpError(403, "csrf_failed", "CSRF token is invalid", false);
  }
  if (request.method !== "DELETE" && !isJsonContentType(request)) {
    throw new HttpError(
      403,
      "invalid_content_type",
      "State-changing requests must use JSON",
      false,
    );
  }
}

function displayableTranscript(manager: {
  getBranch?: () => Array<{
    type: string;
    id: string;
    timestamp: string;
    message?: unknown;
  }>;
  getEntries?: () => Array<{
    type: string;
    id: string;
    timestamp: string;
    message?: unknown;
  }>;
}): Array<{
  id: string;
  timestamp: string;
  role: string;
  content: unknown;
  incomplete: boolean;
}> {
  const entries = manager.getBranch?.() ?? manager.getEntries?.() ?? [];
  return entries.flatMap((entry) => {
    if (entry.type !== "message" || !isRecord(entry.message)) return [];
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") return [];
    return [
      {
        id: entry.id,
        timestamp: entry.timestamp,
        role,
        content: entry.message.content,
        incomplete:
          role === "assistant" &&
          (entry.message.stopReason === "aborted" ||
            entry.message.stopReason === "error" ||
            entry.message.stopReason === "length"),
      },
    ];
  });
}

// ponytail: page through the existing registry API; add a count query only if conversation volume makes rescans measurable.
function allConversations(
  registry: ConversationRegistry,
  archived: boolean | undefined,
): Conversation[] {
  const result: Conversation[] = [];
  for (let offset = 0; ; offset += MAX_PAGE_LIMIT) {
    const batch = registry.list({
      ...(archived === undefined ? {} : { archived }),
      limit: MAX_PAGE_LIMIT,
      offset,
    });
    result.push(...batch);
    if (batch.length < MAX_PAGE_LIMIT) return result;
  }
}

function safeStreamMessage(error: unknown, fallback: string): string {
  const message =
    (error instanceof Error ? error.message : String(error)).trim() || fallback;
  return message
    .replace(
      /((?:(?:api[_ -]?key|authorization|token)\b\s*(?::|=)\s*(?:bearer\s+)?|bearer\s+))(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[redacted]",
    )
    .slice(0, 1000);
}

function safeStreamEvent(event: BrowserStreamEvent): BrowserStreamEvent {
  if (event.type !== "error") return event;
  return {
    ...event,
    message: safeStreamMessage(event.message, "Model turn failed"),
  };
}

function classifyStreamError(
  error: unknown,
  incomplete = false,
): BrowserStreamEvent {
  const incompleteEvent = incomplete ? { incomplete: true as const } : {};
  if (error instanceof TurnBusyError) {
    return {
      type: "error",
      code: "global_busy",
      message: safeStreamMessage(error, "Another model turn is active"),
      retryable: true,
      ...incompleteEvent,
    };
  }
  const value = isRecord(error) ? error : {};
  let status: number | undefined;
  if (typeof value.status === "number") status = value.status;
  else if (typeof value.statusCode === "number") status = value.statusCode;
  const code = typeof value.code === "string" ? value.code.toLowerCase() : "";
  const message = safeStreamMessage(error, "Model turn failed");
  const text = `${code} ${message}`.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    /(?:auth|oauth|credential|unauthori[sz]ed)/u.test(text)
  ) {
    return {
      type: "error",
      code: "authentication_error",
      message,
      retryable: false,
      ...incompleteEvent,
    };
  }
  if (
    status === 429 ||
    /(?:quota|rate[ -]?limit|too many requests)/u.test(text)
  ) {
    return {
      type: "error",
      code: "quota_error",
      message,
      retryable: true,
      ...incompleteEvent,
    };
  }
  if (/(?:concurren(?:cy|t)|already in use|busy)/u.test(text)) {
    return {
      type: "error",
      code: "concurrency_error",
      message,
      retryable: true,
      ...incompleteEvent,
    };
  }
  if (
    /(?:web[ _-]?search|search unavailable|search failed|citation)/u.test(text)
  ) {
    return {
      type: "error",
      code: "search_error",
      message,
      retryable: true,
      ...incompleteEvent,
    };
  }
  if (/(?:abort|cancel)/u.test(text)) {
    return {
      type: "error",
      code: "cancelled",
      message,
      retryable: true,
      ...incompleteEvent,
    };
  }
  return {
    type: "error",
    code: "internal_error",
    message: "Internal server error",
    retryable: true,
    ...incompleteEvent,
  };
}

function writeSse(
  response: ServerResponse,
  event: BrowserStreamEvent,
): Promise<void> {
  if (response.destroyed || response.writableEnded)
    return Promise.reject(new Error("SSE socket is closed"));
  const payload = `data: ${JSON.stringify(safeStreamEvent(event))}\n\n`;
  if (response.write(payload)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("SSE socket is closed"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

async function serveMessages(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ResolvedDependencies,
  conversationId: number,
  body: { text: string; retryRequestId?: string },
): Promise<void> {
  const conversation = deps.registry.get(conversationId);
  if (!conversation) throw new ConversationNotFoundError(conversationId);

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  const controller = new AbortController();
  let finished = false;
  const disconnect = (): void => {
    if (!finished) controller.abort();
  };
  request.once("aborted", disconnect);
  response.once("close", disconnect);
  let sawText = false;
  const emit: BrowserStreamEmitter = async (event) => {
    if (event.type === "text_delta") sawText = true;
    await writeSse(response, event);
  };
  try {
    await deps.turns.submit(
      {
        conversationId,
        text: body.text,
        ...(body.retryRequestId === undefined
          ? {}
          : { retryRequestId: body.retryRequestId }),
        signal: controller.signal,
      },
      emit,
    );
  } catch (error) {
    if (!response.destroyed && !response.writableEnded) {
      try {
        await emit(classifyStreamError(error, sawText));
      } catch {
        // The stream closed while reporting the failure.
      }
    }
  } finally {
    finished = true;
    request.off("aborted", disconnect);
    response.off("close", disconnect);
    if (!response.destroyed && !response.writableEnded) response.end();
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  server: Server,
  deps: ResolvedDependencies,
  csrfToken: string,
): Promise<void> {
  const method = request.method ?? "GET";
  if (isStateChangingMethod(method)) {
    requireMutationSecurity(request, server, deps, csrfToken);
  }
  const rawUrl = request.url ?? "/";
  let url: URL;
  try {
    url = new URL(rawUrl, `http://${expectedHost(server, deps.host)}`);
  } catch {
    throw new ValidationError("Invalid request URL");
  }

  const path = url.pathname;
  if (method === "GET" && serveStatic(path, response, csrfToken)) return;
  const body =
    method === "GET" || method === "DELETE"
      ? undefined
      : await readJson(request, deps.maxJsonBodyBytes);

  if (path === "/api/conversations") {
    if (method === "GET") {
      const query = conversationListQuery(url);
      const all = allConversations(deps.registry, query.archived);
      return jsonResponse(response, 200, {
        items: all.slice(query.offset, query.offset + query.limit),
        total: all.length,
        limit: query.limit,
        offset: query.offset,
      });
    }
    if (method === "POST") {
      const value = objectBody(body);
      allowedKeys(value, ["name"]);
      const name = requiredText(
        requiredBodyValue(value, "name"),
        "Conversation name",
        200,
      );
      return jsonResponse(response, 201, deps.registry.create(name));
    }
  }

  let match = /^\/api\/conversations\/([^/]+)\/steer$/u.exec(path);
  if (match) {
    if (method !== "POST")
      throw new HttpError(404, "not_found", "Route not found", false);
    const value = objectBody(body);
    allowedKeys(value, ["text"]);
    const conversationId = positiveId(
      decodeSegment(match[1]!, "conversation ID"),
      "Conversation ID",
    );
    const text = requiredText(
      requiredBodyValue(value, "text"),
      "Text",
      MAX_MESSAGE_LENGTH,
    );
    if (!(await deps.turns.steer(conversationId, text))) {
      throw new HttpError(
        409,
        "turn_not_active",
        "This conversation has no active model turn",
        true,
      );
    }
    return jsonResponse(response, 202, { steered: true });
  }

  match = /^\/api\/conversations\/([^/]+)\/messages$/u.exec(path);
  if (match) {
    if (method !== "POST")
      throw new HttpError(404, "not_found", "Route not found", false);
    return serveMessages(
      request,
      response,
      deps,
      positiveId(
        decodeSegment(match[1]!, "conversation ID"),
        "Conversation ID",
      ),
      validateMessageBody(body),
    );
  }

  match = /^\/api\/conversations\/([^/]+)\/archive$/u.exec(path);
  if (match) {
    if (method !== "POST")
      throw new HttpError(404, "not_found", "Route not found", false);
    const conversationId = positiveId(
      decodeSegment(match[1]!, "conversation ID"),
      "Conversation ID",
    );
    const archived = validateArchiveBody(body).archived;
    const result = deps.registry.archive(conversationId, archived);
    if (!result) throw new ConversationNotFoundError(conversationId);
    return jsonResponse(response, 200, result);
  }

  match =
    /^\/api\/conversations\/([^/]+)\/proposals\/([^/]+)\/(accept|reject)$/u.exec(
      path,
    );
  if (match) {
    if (method !== "POST")
      throw new HttpError(404, "not_found", "Route not found", false);
    const conversationId = positiveId(
      decodeSegment(match[1]!, "conversation ID"),
      "Conversation ID",
    );
    const proposalId = requiredText(
      decodeSegment(match[2]!, "proposal ID"),
      "Proposal ID",
      MAX_REQUEST_ID_LENGTH,
    );
    if (match[3] === "accept") {
      const value = validateProposalAcceptBody(body).value;
      return jsonResponse(
        response,
        200,
        await acceptProposal(
          deps.proposalRegistry,
          deps.library,
          conversationId,
          proposalId,
          value,
        ),
      );
    }
    validateEmptyBody(body);
    return jsonResponse(
      response,
      200,
      await rejectProposal(deps.proposalRegistry, conversationId, proposalId),
    );
  }

  match = /^\/api\/conversations\/([^/]+)\/proposals$/u.exec(path);
  if (match) {
    if (method !== "GET")
      throw new HttpError(404, "not_found", "Route not found", false);
    const conversationId = positiveId(
      decodeSegment(match[1]!, "conversation ID"),
      "Conversation ID",
    );
    return jsonResponse(
      response,
      200,
      await listPendingProposals(deps.proposalRegistry, conversationId),
    );
  }

  match = /^\/api\/conversations\/([^/]+)$/u.exec(path);
  if (match) {
    const conversationId = positiveId(
      decodeSegment(match[1]!, "conversation ID"),
      "Conversation ID",
    );
    if (method === "GET") {
      const result = await deps.registry.withConversation(
        conversationId,
        (manager, conversation) => {
          const metadata = conversation ?? deps.registry.get(conversationId);
          if (!metadata) throw new ConversationNotFoundError(conversationId);
          return { ...metadata, transcript: displayableTranscript(manager) };
        },
      );
      return jsonResponse(response, 200, result);
    }
    if (method === "PATCH") {
      const value = objectBody(body);
      allowedKeys(value, ["name"]);
      const name = requiredText(
        requiredBodyValue(value, "name"),
        "Conversation name",
        200,
      );
      const result = deps.registry.rename(conversationId, name);
      if (!result) throw new ConversationNotFoundError(conversationId);
      return jsonResponse(response, 200, result);
    }
    if (method === "DELETE") {
      if (!deps.registry.delete(conversationId))
        throw new ConversationNotFoundError(conversationId);
      return emptyResponse(response);
    }
  }

  match = /^\/api\/requests\/([^/]+)\/cancel$/u.exec(path);
  if (match) {
    if (method !== "POST")
      throw new HttpError(404, "not_found", "Route not found", false);
    validateEmptyBody(body);
    const requestId = requiredText(
      decodeSegment(match[1]!, "request ID"),
      "Request ID",
      MAX_REQUEST_ID_LENGTH,
    );
    if (
      deps.turns.activeRequestId !== requestId ||
      !(await deps.turns.cancel(requestId))
    ) {
      throw new HttpError(
        409,
        "request_not_active",
        "The request is no longer active",
        false,
      );
    }
    return jsonResponse(response, 202, { requestId, cancelled: true });
  }

  if (path === "/api/books") {
    if (method === "GET")
      return jsonResponse(
        response,
        200,
        deps.library.searchBooks(bookSearchQuery(url)),
      );
    if (method === "POST")
      return jsonResponse(
        response,
        201,
        deps.library.createOrFindBook(validateBookCreateBody(body)),
      );
  }

  match = /^\/api\/books\/([^/]+)\/notes\/([^/]+)$/u.exec(path);
  if (match) {
    const bookId = positiveId(decodeSegment(match[1]!, "book ID"), "Book ID");
    const noteId = positiveId(decodeSegment(match[2]!, "note ID"), "Note ID");
    if (method === "PATCH") {
      const note = deps.library.editNote(
        bookId,
        noteId,
        validateNoteBody(body).note,
      );
      if (!note) throw new RecordNotFoundError(`Note ${noteId} was not found`);
      return jsonResponse(response, 200, note);
    }
    if (method === "DELETE") {
      if (!deps.library.deleteNote(bookId, noteId))
        throw new RecordNotFoundError(`Note ${noteId} was not found`);
      return emptyResponse(response);
    }
  }

  match = /^\/api\/books\/([^/]+)\/recommendations$/u.exec(path);
  if (match) {
    if (method !== "GET")
      throw new HttpError(404, "not_found", "Route not found", false);
    const bookId = positiveId(decodeSegment(match[1]!, "book ID"), "Book ID");
    return jsonResponse(
      response,
      200,
      deps.library.listRecommendations(bookId, pageQuery(url)),
    );
  }

  match = /^\/api\/books\/([^/]+)$/u.exec(path);
  if (match) {
    const bookId = positiveId(decodeSegment(match[1]!, "book ID"), "Book ID");
    if (method === "GET") {
      const book = deps.library.getBook(bookId);
      if (!book) throw new RecordNotFoundError(`Book ${bookId} was not found`);
      return jsonResponse(response, 200, book);
    }
    if (method === "PATCH") {
      const book = deps.library.updateBook(
        bookId,
        validateBookUpdateBody(body),
        "user",
      );
      if (!book) throw new RecordNotFoundError(`Book ${bookId} was not found`);
      return jsonResponse(response, 200, book);
    }
    if (method === "DELETE") {
      if (!deps.library.deleteBook(bookId))
        throw new RecordNotFoundError(`Book ${bookId} was not found`);
      return emptyResponse(response);
    }
  }

  if (path === "/api/series") {
    if (method === "GET")
      return jsonResponse(
        response,
        200,
        deps.library.searchSeries(seriesSearchQuery(url)),
      );
    if (method === "POST")
      return jsonResponse(
        response,
        201,
        deps.library.createOrFindSeries(validateSeriesCreateBody(body)),
      );
  }

  match = /^\/api\/series\/([^/]+)$/u.exec(path);
  if (match) {
    const seriesId = positiveId(
      decodeSegment(match[1]!, "series ID"),
      "Series ID",
    );
    if (method === "PATCH") {
      const series = deps.library.updateSeries(
        seriesId,
        validateSeriesUpdateBody(body),
      );
      if (!series)
        throw new RecordNotFoundError(`Series ${seriesId} was not found`);
      return jsonResponse(response, 200, series);
    }
    if (method === "DELETE") {
      if (!deps.library.deleteSeries(seriesId))
        throw new RecordNotFoundError(`Series ${seriesId} was not found`);
      return emptyResponse(response);
    }
  }

  if (path === "/api/open-library/lookup") {
    if (method !== "POST")
      throw new HttpError(404, "not_found", "Route not found", false);
    const lookup = validateLookupBody(body);
    return jsonResponse(
      response,
      200,
      await deps.openLibrary.lookup(lookup.input, { refresh: lookup.refresh }),
    );
  }

  throw new HttpError(404, "not_found", "Route not found", false);
}

export function createHttpServer(depsInput: HttpDependencies): HttpServer {
  const deps = resolveDependencies(depsInput);
  const csrfToken = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    void route(request, response, server, deps, csrfToken).catch(
      (error: unknown) => {
        if (response.headersSent || response.destroyed) {
          if (!response.writableEnded) response.destroy();
          return;
        }
        const mapped = errorShape(error);
        jsonResponse(response, mapped.status, mapped.body);
      },
    );
  }) as HttpServer;
  Object.defineProperty(server, "csrfToken", {
    configurable: false,
    enumerable: true,
    value: csrfToken,
    writable: false,
  });
  return server;
}

export function getCsrfToken(server: HttpServer): string {
  return server.csrfToken;
}
