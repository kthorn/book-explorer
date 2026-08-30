import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { normalizeCitationUrl } from "./normalize.js";

export const CUSTOM_TOOL_NAMES = [
  "search_library",
  "get_book",
  "upsert_book",
  "upsert_series",
  "record_recommendation",
  "propose_change",
] as const;

export const ACTIVE_TOOL_NAMES = [
  ...CUSTOM_TOOL_NAMES,
  "web_search",
] as const;

export type ActiveToolName = (typeof ACTIVE_TOOL_NAMES)[number];

export interface CapturedCitation {
  url: string;
  title: string;
  snippet: string | null;
  provider: string;
}

export type CitationCapture = Map<string, CapturedCitation>;

export function createCitationCapture(): CitationCapture {
  return new Map();
}

export interface SearchGuardModel {
  provider: string;
  id: string;
}

export interface SearchGuardRuntime {
  getModel(provider: string, id: string): SearchGuardModel | undefined;
  checkAuth(provider: string): Promise<unknown>;
}

export interface SearchGuardState {
  runtime: SearchGuardRuntime;
  model?: SearchGuardModel;
  oauthReady?: boolean;
}

export interface SearchGuardToolResult {
  content: Array<TextContent | ImageContent>;
  details?: unknown;
  isError?: boolean;
}

export class ToolSurfaceError extends Error {
  readonly code = "invalid_tool_surface";

  constructor(message: string) {
    super(message);
    this.name = "ToolSurfaceError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stateFor(value: SearchGuardState | SearchGuardRuntime): SearchGuardState {
  const candidate = record(value);
  const nested = candidate?.runtime;
  if (nested && typeof nested === "object" && typeof (nested as SearchGuardRuntime).checkAuth === "function") {
    return value as SearchGuardState;
  }
  return { runtime: value as SearchGuardRuntime };
}

export function validateWebSearchArguments(input: unknown): string | null {
  const value = record(input);
  if (!value) return "Web search arguments must be an object";
  if (Object.hasOwn(value, "includeContent")) {
    return "Web search includeContent is disabled";
  }
  if (Object.hasOwn(value, "provider") && (value.provider !== "openai" || Array.isArray(value.provider))) {
    return "Web search provider must be omitted or exactly openai";
  }
  if (Object.hasOwn(value, "workflow") && value.workflow !== "none") {
    return "Web search workflow must be omitted or exactly none";
  }
  return null;
}

async function verifySearchRuntime(state: SearchGuardState): Promise<string | null> {
  if (state.oauthReady === false) return "OpenAI web search requires an OAuth Codex credential";
  const model = state.model ?? (typeof state.runtime.getModel === "function"
    ? state.runtime.getModel("openai-codex", "gpt-5.6-sol")
    : undefined);
  if (!model || model.provider !== "openai-codex" || model.id !== "gpt-5.6-sol") {
    return "OpenAI web search requires the pinned openai-codex/gpt-5.6-sol model";
  }
  let auth: unknown;
  try {
    auth = await state.runtime.checkAuth("openai-codex");
  } catch {
    return "OpenAI web search OAuth authentication is unavailable";
  }
  const authRecord = record(auth);
  if (!authRecord || authRecord.type !== "oauth") {
    return "OpenAI web search requires an OAuth Codex credential";
  }
  return null;
}

function errorResult(event: Record<string, unknown>, message: string): SearchGuardToolResult {
  return {
    content: [{ type: "text", text: `Web search unavailable: ${message}` }],
    details: event.details,
    isError: true,
  };
}

function entriesFrom(value: readonly unknown[] | { getEntries(): readonly unknown[] }): readonly unknown[] {
  if ("getEntries" in value) return value.getEntries();
  return value;
}

function searchDataFor(event: Record<string, unknown>, entries: readonly unknown[]): Record<string, unknown> | null {
  const details = record(event.details);
  const searchId = details?.searchId;
  if (typeof searchId !== "string" || searchId.length === 0) return null;
  for (const entry of entries) {
    const item = record(entry);
    if (item?.type !== "custom" || item.customType !== "web-search-results") continue;
    const data = record(item.data);
    if (data?.type === "search" && data.id === searchId) return data;
  }
  return null;
}

function queryProviderError(data: Record<string, unknown>): string | null {
  if (!Array.isArray(data.queries)) return "Web search returned no correlated query results";
  for (const query of data.queries) {
    const value = record(query);
    if (!value || value.provider !== "openai") {
      return "only OpenAI web search results are accepted";
    }
  }
  return null;
}

function capturedCitations(data: Record<string, unknown>): CapturedCitation[] {
  const citations = new Map<string, CapturedCitation>();
  if (!Array.isArray(data.queries)) return [];
  for (const query of data.queries) {
    const value = record(query);
    if (!value || value.error || !Array.isArray(value.results)) continue;
    for (const result of value.results) {
      const source = record(result);
      if (!source || typeof source.url !== "string" || typeof source.title !== "string") continue;
      let url: string;
      try {
        url = normalizeCitationUrl(source.url);
      } catch {
        continue;
      }
      const snippet = typeof source.snippet === "string" ? source.snippet : null;
      citations.set(url, {
        url,
        title: source.title,
        snippet,
        provider: "openai",
      });
    }
  }
  return [...citations.values()];
}

function appendTokens(
  content: unknown,
  tokens: readonly string[],
): Array<TextContent | ImageContent> {
  const original = Array.isArray(content)
    ? content.filter((part): part is TextContent | ImageContent => {
      const value = record(part);
      return value?.type === "text" && typeof value.text === "string" || value?.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";
    }).map((part) => ({ ...part }))
    : [];
  if (tokens.length === 0) return original;
  const suffix = `\n\nCitation tokens: ${tokens.join(" ")}`;
  const textIndex = original.findIndex((part) => part.type === "text");
  if (textIndex >= 0 && original[textIndex]?.type === "text") {
    original[textIndex] = {
      ...original[textIndex],
      text: `${original[textIndex].text}${suffix}`,
    };
  } else {
    original.push({ type: "text", text: suffix.trim() });
  }
  return original;
}

export async function captureWebSearchResult(
  rawEvent: unknown,
  sessionEntries: readonly unknown[] | { getEntries(): readonly unknown[] },
  citationCapture: CitationCapture,
  runtime: SearchGuardState | SearchGuardRuntime,
): Promise<SearchGuardToolResult | undefined> {
  const event = record(rawEvent);
  if (!event || event.toolName !== "web_search") return undefined;
  if (event.isError === true) return undefined;

  const runtimeError = await verifySearchRuntime(stateFor(runtime));
  if (runtimeError) return errorResult(event, runtimeError);

  const data = searchDataFor(event, entriesFrom(sessionEntries));
  if (!data) return errorResult(event, "the web-search result could not be correlated to its search entry");
  const providerError = queryProviderError(data);
  if (providerError) return errorResult(event, providerError);

  const tokens: string[] = [];
  for (const citation of capturedCitations(data)) {
    const token = `citation_${randomUUID()}`;
    citationCapture.set(token, citation);
    tokens.push(token);
  }

  return {
    content: appendTokens(event.content, tokens),
    details: event.details,
    isError: false,
  };
}

export function assertExactToolSurface(session: unknown): void {
  const value = record(session);
  const agent = record(value?.agent);
  const state = record(value?.state) ?? record(agent?.state);
  const tools = state?.tools;
  if (!Array.isArray(tools)) {
    throw new ToolSurfaceError("Agent session did not expose an active tool allowlist");
  }
  const names = tools.map((tool) => typeof tool === "string" ? tool : record(tool)?.name);
  if (names.some((name) => typeof name !== "string")) {
    throw new ToolSurfaceError("Agent session exposed an invalid active tool");
  }
  const actual = [...names as string[]].sort();
  const expected = [...ACTIVE_TOOL_NAMES].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new ToolSurfaceError(`Agent session active tools must be exactly ${ACTIVE_TOOL_NAMES.join(", ")}`);
  }
}

export function createSearchGuardFactory(
  runtime: SearchGuardState | SearchGuardRuntime,
  citationCapture: CitationCapture,
): InlineExtension {
  const state = stateFor(runtime);
  const factory = (pi: ExtensionAPI): void => {
    pi.on("tool_call", async (event) => {
      const value = event as { toolName?: unknown; input?: unknown };
      if (value.toolName !== "web_search") return;
      const argumentError = validateWebSearchArguments(value.input);
      if (argumentError) return { block: true, reason: argumentError, terminate: true };
      const runtimeError = await verifySearchRuntime(state);
      if (runtimeError) return { block: true, reason: runtimeError, terminate: true };
      return undefined;
    });

    pi.on("tool_result", async (event, context) => {
      const value = event as { toolName?: unknown };
      if (value.toolName !== "web_search") return undefined;
      return captureWebSearchResult(event, context.sessionManager, citationCapture, state);
    });
  };
  const callable = Object.assign(factory, { factory });
  // SAFETY: InlineExtension accepts either a factory function or a named wrapper; this callable carries both forms.
  return callable as unknown as InlineExtension;
}

export const createSearchGuard = createSearchGuardFactory;
export const createInlineSearchGuard = createSearchGuardFactory;
