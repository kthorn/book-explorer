import { createHash } from "node:crypto";

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  AmbiguousBookError,
  type LibraryRepository,
  RecordNotFoundError,
  type BookIdentifierInput,
  type CitationInput,
  type CreateBookInput,
  type SearchBooksOptions,
} from "./library.js";
import { ConversationNotFoundError } from "./conversations.js";
import {
  READING_STATUSES,
  ValidationError,
  type ReadingStatus,
} from "./normalize.js";
import {
  ProposalAlreadyDecidedError,
  ProposalNotFoundError,
  type ProposalRegistry,
} from "./proposals.js";
import type { CitationCapture } from "./search-guard.js";

export interface BookExplorerToolContext {
  library: LibraryRepository;
  proposalRegistry: ProposalRegistry;
  conversationId: number;
  requestId: string;
  citationCapture: CitationCapture;
}

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface ToolSuccess<T> {
  ok: true;
  data: T;
}

export interface ToolFailure {
  ok: false;
  error: ToolError;
}

export type ToolEnvelope<T> = ToolSuccess<T> | ToolFailure;

const HTTP_URL_PATTERN = "^[Hh][Tt][Tt][Pp][Ss]?://[^\\s]+$";
const TOOL_OBJECT_OPTIONS = { additionalProperties: false } as const;

function union<T extends ReturnType<typeof Type.Literal>[]>(types: [...T]) {
  return Type.Union(types);
}

const readingStatusSchema = union(
  READING_STATUSES.map((status) => Type.Literal(status)) as [
    ReturnType<typeof Type.Literal>,
    ...ReturnType<typeof Type.Literal>[],
  ],
);

const identifierSchema = Type.Object(
  {
    scheme: union([
      Type.Literal("openlibrary_work"),
      Type.Literal("isbn10"),
      Type.Literal("isbn13"),
    ]),
    value: Type.String({ minLength: 1, maxLength: 200 }),
    source: Type.String({ minLength: 1, maxLength: 200 }),
  },
  TOOL_OBJECT_OPTIONS,
);

const searchLibraryParameters = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 200 })),
    status: Type.Optional(readingStatusSchema),
    rating: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    seriesId: Type.Optional(
      Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 50, default: 20 }),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        default: 0,
      }),
    ),
  },
  TOOL_OBJECT_OPTIONS,
);

const getBookParameters = Type.Object(
  {
    bookId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  TOOL_OBJECT_OPTIONS,
);
const upsertBookParameters = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 300 }),
    author: Type.String({ minLength: 1, maxLength: 300 }),
    publicationYear: Type.Optional(Type.Integer({ minimum: 0, maximum: 9999 })),
    coverUrl: Type.Optional(Type.String({ pattern: HTTP_URL_PATTERN })),
    seriesId: Type.Optional(
      Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    seriesPosition: Type.Optional(Type.String({ maxLength: 40 })),
    identifiers: Type.Optional(Type.Array(identifierSchema, { maxItems: 20 })),
  },
  TOOL_OBJECT_OPTIONS,
);
const upsertSeriesParameters = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    note: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  TOOL_OBJECT_OPTIONS,
);
const recordRecommendationParameters = Type.Object(
  {
    bookId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    rationale: Type.String({ minLength: 1, maxLength: 4000 }),
    cautions: Type.Optional(Type.String({ maxLength: 2000 })),
    citationTokens: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
        maxItems: 20,
      }),
    ),
  },
  TOOL_OBJECT_OPTIONS,
);
const libraryUpdateSharedProperties = {
  bookId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};

const updateLibraryParameters = Type.Union([
  Type.Object(
    {
      ...libraryUpdateSharedProperties,
      kind: Type.Literal("status"),
      value: readingStatusSchema,
    },
    TOOL_OBJECT_OPTIONS,
  ),
  Type.Object(
    {
      ...libraryUpdateSharedProperties,
      kind: Type.Literal("rating"),
      value: Type.Integer({ minimum: 1, maximum: 5 }),
    },
    TOOL_OBJECT_OPTIONS,
  ),
  Type.Object(
    {
      ...libraryUpdateSharedProperties,
      kind: Type.Literal("note"),
      value: Type.String({ minLength: 1, maxLength: 4000 }),
    },
    TOOL_OBJECT_OPTIONS,
  ),
]);
function inputObject(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("Tool input must be an object");
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new ValidationError(`Unknown tool property: ${key}`);
  }
  return value;
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
  if (typeof value !== "string")
    throw new ValidationError(`${label} must be a string`);
  if (value.length > maximum)
    throw new ValidationError(`${label} must be at most ${maximum} characters`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum?: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    (maximum !== undefined && Number(value) > maximum)
  ) {
    const suffix =
      maximum === undefined
        ? `at least ${minimum}`
        : `from ${minimum} through ${maximum}`;
    throw new ValidationError(`${label} must be an integer ${suffix}`);
  }
  return Number(value);
}

function optionalBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum?: number,
): number | undefined {
  return value === undefined
    ? undefined
    : boundedInteger(value, label, minimum, maximum);
}

function optionalReadingStatus(value: unknown): ReadingStatus | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !(READING_STATUSES as readonly string[]).includes(value)
  ) {
    throw new ValidationError("Invalid reading status");
  }
  return value as ReadingStatus;
}

function validateHttpUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new ValidationError("Cover URL must be a string");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("Invalid cover URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("Cover URL must use HTTP(S)");
  }
  return value;
}

function validateIdentifier(value: unknown): BookIdentifierInput {
  const input = inputObject(value, ["scheme", "value", "source"]);
  if (
    input.scheme !== "openlibrary_work" &&
    input.scheme !== "isbn10" &&
    input.scheme !== "isbn13"
  ) {
    throw new ValidationError("Invalid identifier scheme");
  }
  return {
    scheme: input.scheme,
    value: requiredText(input.value, "Identifier value", 200),
    source: requiredText(input.source, "Identifier source", 200),
  } as BookIdentifierInput;
}

function validateSearchInput(input: unknown): SearchBooksOptions {
  const value = inputObject(input, [
    "query",
    "status",
    "rating",
    "seriesId",
    "limit",
    "offset",
  ]);
  const query =
    value.query === undefined
      ? undefined
      : optionalText(value.query, "Query", 200);
  return {
    query,
    status: optionalReadingStatus(value.status),
    rating: optionalBoundedInteger(value.rating, "Rating", 1, 5),
    seriesId:
      value.seriesId === undefined
        ? undefined
        : positiveInteger(value.seriesId, "Series ID"),
    limit:
      value.limit === undefined
        ? 20
        : boundedInteger(value.limit, "Limit", 1, 50),
    offset:
      value.offset === undefined
        ? 0
        : boundedInteger(value.offset, "Offset", 0),
  };
}

function validateGetBookInput(input: unknown): { bookId: number } {
  const value = inputObject(input, ["bookId"]);
  return { bookId: positiveInteger(value.bookId, "Book ID") };
}

function validateUpsertBookInput(input: unknown): CreateBookInput {
  const value = inputObject(input, [
    "title",
    "author",
    "publicationYear",
    "coverUrl",
    "seriesId",
    "seriesPosition",
    "identifiers",
  ]);
  let identifiers: BookIdentifierInput[] | undefined;
  if (value.identifiers !== undefined) {
    if (!Array.isArray(value.identifiers))
      throw new ValidationError("Identifiers must be an array");
    if (value.identifiers.length > 20)
      throw new ValidationError("At most 20 identifiers are allowed");
    identifiers = value.identifiers.map(validateIdentifier);
  }
  return {
    title: requiredText(value.title, "Title", 300),
    author: requiredText(value.author, "Author", 300),
    publicationYear: optionalBoundedInteger(
      value.publicationYear,
      "Publication year",
      0,
      9999,
    ),
    coverUrl: validateHttpUrl(value.coverUrl),
    seriesId:
      value.seriesId === undefined
        ? undefined
        : positiveInteger(value.seriesId, "Series ID"),
    seriesPosition: optionalText(value.seriesPosition, "Series position", 40),
    identifiers,
  };
}

function validateUpsertSeriesInput(input: unknown): {
  name: string;
  note?: string;
} {
  const value = inputObject(input, ["name", "note"]);
  return {
    name: requiredText(value.name, "Series name", 200),
    note: optionalText(value.note, "Series note", 2000),
  };
}

function citationInputs(
  value: unknown,
  capture: CitationCapture,
): CitationInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new ValidationError("Citation tokens must be an array");
  if (value.length > 20)
    throw new ValidationError("At most 20 citation tokens are allowed");
  const citations: CitationInput[] = [];
  for (const token of value) {
    const citationToken = requiredText(token, "Citation token", 200);
    const citation = capture.get(citationToken);
    if (!citation)
      throw new ValidationError(`Unknown citation token: ${citationToken}`);
    if (citation.provider !== "openai")
      throw new ValidationError(
        `Citation token has an invalid provider: ${citationToken}`,
      );
    citations.push(citation);
  }
  return citations;
}

function validateRecommendationInput(
  input: unknown,
  capture: CitationCapture,
): {
  bookId: number;
  rationale: string;
  cautions: string | null;
  citations: CitationInput[];
} {
  const value = inputObject(input, [
    "bookId",
    "rationale",
    "cautions",
    "citationTokens",
  ]);
  return {
    bookId: positiveInteger(value.bookId, "Book ID"),
    rationale: requiredText(value.rationale, "Rationale", 4000),
    cautions: optionalText(value.cautions, "Cautions", 2000) ?? null,
    citations: citationInputs(value.citationTokens, capture),
  };
}

function validateLibraryUpdate(input: unknown): {
  bookId: number;
  kind: "status" | "rating" | "note";
  value: ReadingStatus | number | string;
} {
  const value = inputObject(input, ["bookId", "kind", "value"]);
  const kind = value.kind;
  if (kind !== "status" && kind !== "rating" && kind !== "note") {
    throw new ValidationError(
      "Library update kind must be status, rating, or note",
    );
  }
  const updateValue =
    kind === "status"
      ? optionalReadingStatus(value.value)
      : kind === "rating"
        ? boundedInteger(value.value, "Rating", 1, 5)
        : requiredText(value.value, "Note", 4000);
  if (updateValue === undefined)
    throw new ValidationError("Status is required");
  return {
    bookId: positiveInteger(value.bookId, "Book ID"),
    kind,
    value: updateValue,
  };
}

function errorEnvelope(error: unknown): ToolFailure {
  if (error instanceof AmbiguousBookError) {
    return {
      ok: false,
      error: {
        code: "ambiguous_book",
        message: error.message,
        retryable: false,
        details: { candidates: error.candidates },
      },
    };
  }
  if (error instanceof ValidationError) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: error.message,
        retryable: false,
      },
    };
  }
  if (
    error instanceof RecordNotFoundError ||
    error instanceof ConversationNotFoundError ||
    error instanceof ProposalNotFoundError
  ) {
    return {
      ok: false,
      error: { code: "not_found", message: error.message, retryable: false },
    };
  }
  if (error instanceof ProposalAlreadyDecidedError) {
    return {
      ok: false,
      error: { code: error.code, message: error.message, retryable: false },
    };
  }
  const message =
    error instanceof Error ? error.message : "Tool execution failed";
  return {
    ok: false,
    error: { code: "internal_error", message, retryable: true },
  };
}

function toolResult<T>(envelope: ToolEnvelope<T>): {
  content: [{ type: "text"; text: string }];
  details: ToolEnvelope<T>;
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    details: envelope,
    isError: !envelope.ok,
  };
}

async function executeTool<T>(
  action: () => T | Promise<T>,
): Promise<ReturnType<typeof toolResult<T>>> {
  try {
    return toolResult({ ok: true, data: await action() });
  } catch (error) {
    return toolResult(errorEnvelope(error));
  }
}

export function createBookExplorerTools(
  context: BookExplorerToolContext,
): ToolDefinition[] {
  const { library, conversationId, requestId, citationCapture } = context;
  const searchLibrary = defineTool({
    name: "search_library",
    label: "Search library",
    description:
      "Search the local library by title, author, status, rating, or series.",
    parameters: searchLibraryParameters,
    async execute(_toolCallId, params) {
      return executeTool(() =>
        library.searchBooks(validateSearchInput(params)),
      );
    },
  });

  const getBook = defineTool({
    name: "get_book",
    label: "Get book",
    description: "Get the complete local library record for one book.",
    parameters: getBookParameters,
    async execute(_toolCallId, params) {
      return executeTool(() => {
        const input = validateGetBookInput(params);
        const book = library.getBook(input.bookId);
        if (!book)
          throw new RecordNotFoundError(`Book ${input.bookId} was not found`);
        return book;
      });
    },
  });

  const upsertBook = defineTool({
    name: "upsert_book",
    label: "Upsert book",
    description:
      "Create or find a book without changing user-owned status, rating, or notes.",
    parameters: upsertBookParameters,
    async execute(_toolCallId, params) {
      return executeTool(() =>
        library.createOrFindBook(validateUpsertBookInput(params)),
      );
    },
  });

  const upsertSeries = defineTool({
    name: "upsert_series",
    label: "Upsert series",
    description: "Create or find a series in the local library.",
    parameters: upsertSeriesParameters,
    async execute(_toolCallId, params) {
      return executeTool(() =>
        library.createOrFindSeries(validateUpsertSeriesInput(params)),
      );
    },
  });

  const recordRecommendation = defineTool({
    name: "record_recommendation",
    label: "Record recommendation",
    description:
      "Record an assistant recommendation and link captured web citations.",
    parameters: recordRecommendationParameters,
    async execute(_toolCallId, params) {
      return executeTool(() => {
        const input = validateRecommendationInput(params, citationCapture);
        return library.recordRecommendation(
          requestId,
          input.bookId,
          input.rationale,
          input.cautions,
          input.citations,
          conversationId,
        );
      });
    },
  });

  const updateLibrary = defineTool({
    name: "update_library",
    label: "Update library",
    description: "Directly update a book's status or rating, or add a note.",
    parameters: updateLibraryParameters,
    async execute(_toolCallId, params) {
      return executeTool(() => {
        const input = validateLibraryUpdate(params);
        if (input.kind === "note") {
          const book = library.getBook(input.bookId);
          if (!book)
            throw new RecordNotFoundError(`Book ${input.bookId} was not found`);
          const sourceId = `direct:${createHash("sha256")
            .update(JSON.stringify([requestId, input.bookId, input.value]))
            .digest("hex")}`;
          const note =
            book.notes.find(
              (candidate) => candidate.sourceProposalId === sourceId,
            ) ??
            library.addNote(
              input.bookId,
              input.value as string,
              conversationId,
              sourceId,
            );
          return {
            bookId: input.bookId,
            kind: input.kind,
            value: note.note,
            noteId: note.id,
          };
        }
        const book = library.updateBook(
          input.bookId,
          input.kind === "status"
            ? { status: input.value as ReadingStatus }
            : { rating: input.value as number },
          "agent",
        );
        if (!book)
          throw new RecordNotFoundError(`Book ${input.bookId} was not found`);
        return {
          bookId: input.bookId,
          kind: input.kind,
          value: input.kind === "status" ? book.status : book.rating,
        };
      });
    },
  });

  return [
    searchLibrary,
    getBook,
    upsertBook,
    upsertSeries,
    recordRecommendation,
    updateLibrary,
  ];
}
