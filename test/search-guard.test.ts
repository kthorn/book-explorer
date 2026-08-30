import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createStartupProbe,
  createTurnSession,
  type AgentRuntimeState,
} from "../src/agent-runtime.js";
import {
  ACTIVE_TOOL_NAMES,
  createCitationCapture,
  createSearchGuardFactory,
  captureWebSearchResult,
  type CitationCapture,
} from "../src/search-guard.js";

interface HandlerMap {
  tool_call?: (event: unknown, context: unknown) => Promise<unknown> | unknown;
  tool_result?: (event: unknown, context: unknown) => Promise<unknown> | unknown;
}

function stateFixture(overrides: Record<string, unknown> = {}): AgentRuntimeState {
  const directory = mkdtempSync(join(tmpdir(), "book-explorer-search-guard-"));
  const runtime = {
    getModel: (provider: string, id: string) => provider === "openai-codex" && id === "gpt-5.6-sol" ? { provider, id } : undefined,
    checkAuth: async () => ({ type: "oauth" as const }),
    refresh: async () => ({ aborted: false, errors: new Map() }),
  };
  return {
    runtime: runtime as never,
    model: { provider: "openai-codex", id: "gpt-5.6-sol" } as never,
    thinkingLevel: "medium",
    paths: {
      dataDir: directory,
      agentDir: join(directory, "agent"),
      cwd: join(directory, "cwd"),
      authPath: join(directory, "auth.json"),
      modelsPath: join(directory, "agent", "models.json"),
      modelsStorePath: join(directory, "agent", "models-store.json"),
      webSearchConfigPath: join(directory, "agent", "web-search.json"),
      webSearchCacheDir: join(directory, "agent", "web-search-cache"),
    },
    dependencies: {
      extensionPath: "/extension/pi-web-access.ts",
      loaderFactory: (options: Record<string, unknown>) => ({
        options,
        reload: async () => {},
      }) as never,
      sessionFactory: async () => ({ session: {} }) as never,
    },
    ...overrides,
  };
}

function handlersFor(state: AgentRuntimeState, capture: CitationCapture): HandlerMap {
  const handlers: HandlerMap = {};
  const pi = {
    on: (event: keyof HandlerMap, handler: HandlerMap[typeof event]) => {
      handlers[event] = handler;
    },
  };
  const extension = createSearchGuardFactory(state, capture);
  const factory = typeof extension === "function" ? extension : extension.factory;
  factory(pi as never);
  return handlers;
}

function toolCallInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { query: "find books", ...overrides };
}

function searchEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "custom",
    customType: "web-search-results",
    data: {
      id: "search-1",
      type: "search",
      timestamp: Date.now(),
      queries: [{
        query: "find books",
        answer: "A researched answer",
        provider: "openai",
        error: null,
        results: [{
          title: "A source",
          url: "https://example.com/source?z=2&a=1",
          snippet: "Supporting text",
        }],
      }],
      ...overrides,
    },
  };
}

function resultEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    toolName: "web_search",
    toolCallId: "call-1",
    input: toolCallInput(),
    content: [{ type: "text", text: "A researched answer" }],
    details: { searchId: "search-1", untouched: true },
    isError: false,
    ...overrides,
  };
}

function cleanup(state: AgentRuntimeState): void {
  rmSync(state.paths.dataDir, { recursive: true, force: true });
}

test("search guard permits only omitted or exact OpenAI/none arguments", async () => {
  const state = stateFixture();
  try {
    const handlers = handlersFor(state, createCitationCapture());
    const context = {};
    assert.deepEqual(await handlers.tool_call?.({ toolName: "web_search", input: toolCallInput() }, context), undefined);
    assert.deepEqual(await handlers.tool_call?.({ toolName: "web_search", input: toolCallInput({ provider: "openai", workflow: "none" }) }, context), undefined);
    for (const input of [
      toolCallInput({ provider: "brave" }),
      toolCallInput({ provider: ["openai"] }),
      toolCallInput({ workflow: "summary-review" }),
      toolCallInput({ includeContent: false }),
    ]) {
      const result = await handlers.tool_call?.({ toolName: "web_search", input }, context) as { block?: boolean; reason?: string };
      assert.equal(result?.block, true);
    }
  } finally {
    cleanup(state);
  }
});

test("guard requires the exact Codex model runtime and OAuth auth", async () => {
  for (const overrides of [
    { model: { provider: "openai", id: "gpt-5.6-sol" } },
    { runtime: { checkAuth: async () => ({ type: "api_key" as const }) } },
    { runtime: { checkAuth: async () => undefined } },
  ]) {
    const state = stateFixture(overrides);
    try {
      const handlers = handlersFor(state, createCitationCapture());
      const result = await handlers.tool_call?.({ toolName: "web_search", input: toolCallInput() }, {}) as { block?: boolean; reason?: string };
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", /OAuth|model|Codex/i);
    } finally {
      cleanup(state);
    }
  }
});

test("search result correlation preserves details and injects opaque request-local citation tokens", async () => {
  const state = stateFixture();
  try {
    const capture = createCitationCapture();
    const handlers = handlersFor(state, capture);
    const context = {
      sessionManager: { getEntries: () => [searchEntry()] },
    };
    const originalDetails = { searchId: "search-1", untouched: true };
    const result = await handlers.tool_result?.({ ...resultEvent({ details: originalDetails }) }, context) as {
      content: Array<{ type: string; text?: string }>;
      details: unknown;
      isError?: boolean;
    };
    assert.equal(result.details, originalDetails);
    assert.equal(result.isError, false);
    assert.equal(capture.size, 1);
    const token = [...capture.keys()][0];
    assert.match(token, /^citation_[0-9a-f-]+$/);
    assert.match(result.content.map((part) => part.text ?? "").join(""), new RegExp(token));
    assert.equal(capture.get(token)?.provider, "openai");
    assert.equal(capture.get(token)?.url, "https://example.com/source?a=1&z=2");
    assert.equal(capture.get(token)?.url.includes(token), false);
  } finally {
    cleanup(state);
  }
});

test("fallback-provider search outcomes become errors and do not capture citations", async () => {
  const state = stateFixture();
  try {
    const capture = createCitationCapture();
    const entries = [searchEntry({ queries: [{
      query: "find books",
      answer: "fallback answer",
      provider: "brave",
      error: null,
      results: [{ title: "Fallback", url: "https://example.com/fallback" }],
    }] })];
    const original = resultEvent();
    const result = await captureWebSearchResult(original, entries, capture, state) as {
      isError?: boolean;
      details?: unknown;
      content: Array<{ text?: string }>;
    };
    assert.equal(result.isError, true);
    assert.equal(result.details, original.details);
    assert.equal(capture.size, 0);
    assert.match(result.content[0]?.text ?? "", /unavailable|provider/i);
  } finally {
    cleanup(state);
  }
});

test("correlation failure is a visible error and unknown tokens are never invented", async () => {
  const state = stateFixture();
  try {
    const capture = createCitationCapture();
    const result = await captureWebSearchResult(resultEvent(), [], capture, state) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /correlat|search/i);
    assert.equal(capture.size, 0);
  } finally {
    cleanup(state);
  }
});

test("turn sessions use fresh loaders, dispose the startup probe, and enforce seven active tools", async () => {
  const state = stateFixture();
  let loaderCount = 0;
  let disposed = 0;
  try {
    state.dependencies = {
      ...state.dependencies,
      loaderFactory: (options: Record<string, unknown>) => {
        loaderCount += 1;
        return { options, reload: async () => {} } as never;
      },
      sessionFactory: async () => ({
        session: {
          agent: { state: { tools: ACTIVE_TOOL_NAMES.map((name: string) => ({ name })) } },
          dispose: () => { disposed += 1; },
        },
      }) as never,
    };
    const capture = createCitationCapture();
    const first = await createTurnSession(state, [], capture);
    const second = await createTurnSession(state, [], capture);
    assert.notEqual(first.loader, second.loader);
    assert.equal(loaderCount, 2);
    await createStartupProbe(state, [], capture);
    assert.equal(disposed, 1);
    first.session.dispose();
    second.session.dispose();
    assert.equal(disposed, 3);
  } finally {
    cleanup(state);
  }
});

test("unexpected active tools fail closed and the guarded path does not write fetch cache files", async () => {
  const state = stateFixture();
  try {
    state.dependencies = {
      ...state.dependencies,
      sessionFactory: async () => ({
        session: { agent: { state: { tools: [{ name: "web_search" }, { name: "bash" }] } }, dispose: () => {} },
      }) as never,
    };
    await assert.rejects(() => createTurnSession(state, [], new Map()), /tool|allowlist/i);
    assert.equal(existsSync(state.paths.webSearchCacheDir), true);
    assert.deepEqual(readdirSync(state.paths.webSearchCacheDir), []);
  } finally {
    cleanup(state);
  }
});
