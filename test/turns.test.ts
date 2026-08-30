import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { closeDatabase, openDatabase, type Database } from "../src/db.js";
import { ConversationRegistry } from "../src/conversations.js";
import { LibraryRepository } from "../src/library.js";
import type { CitationCapture } from "../src/search-guard.js";
import { createBookExplorerTools } from "../src/tools.js";
import {
  TurnCoordinator,
  type AgentSessionLike,
  type BrowserStreamEvent,
  type TurnSessionLike,
} from "../src/turns.js";

interface Fixture {
  root: string;
  db: Database;
  registry: ConversationRegistry;
  library: LibraryRepository;
  conversations: [number, number];
}

interface Driver {
  prompt: (session: FakeSession, text: string) => Promise<void>;
  events: AgentSessionEvent[];
  promptTexts: string[];
  abortCount: number;
  disposeCount: number;
  lifecycle: string[];
  markerSeen?: boolean;
  tools?: readonly ToolDefinition[];
  releasePrompt?: () => void;
  lastSession?: FakeSession;
}

class FakeSession implements AgentSessionLike {
  readonly sessionManager: SessionManager;
  readonly driver: Driver;
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private disposed = false;

  constructor(sessionManager: SessionManager, driver: Driver) {
    this.sessionManager = sessionManager;
    this.driver = driver;
    driver.lastSession = this;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    this.driver.promptTexts.push(text);
    await this.driver.prompt(this, text);
  }

  emit(event: AgentSessionEvent): void {
    this.driver.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  async abort(): Promise<void> {
    this.driver.releasePrompt?.();
    this.driver.releasePrompt = undefined;
    this.driver.abortCount += 1;
    this.driver.lifecycle.push("abort-start");
    this.driver.lifecycle.push("abort-idle");
    this.driver.lifecycle.push("abort-end");
  }

  dispose(): void {
    assert.equal(this.disposed, false, "session disposed more than once");
    this.disposed = true;
    this.driver.disposeCount += 1;
    this.driver.lifecycle.push("dispose");
  }
}

function driverFixture(
  prompt: Driver["prompt"] = async (session) => {
    session.emit({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: {} as never,
      },
    });
    session.emit({ type: "agent_end", messages: [], willRetry: false });
  },
): Driver {
  return {
    prompt,
    events: [],
    promptTexts: [],
    abortCount: 0,
    disposeCount: 0,
    lifecycle: [],
  };
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "book-explorer-turns-"));
  const db = openDatabase(join(root, "library.sqlite"));
  const registry = new ConversationRegistry(db, {
    cwd: root,
    sessionDir: join(root, "sessions"),
  });
  return {
    root,
    db,
    registry,
    library: new LibraryRepository(db),
    conversations: [registry.create("First").id, registry.create("Second").id],
  };
}

function dispose(item: Fixture): void {
  item.registry.close();
  closeDatabase(item.db);
  rmSync(item.root, { recursive: true, force: true });
}

function runtimeFixture() {
  return {
    runtime: {} as never,
    model: { provider: "openai-codex", id: "gpt-5.6-sol" } as never,
    thinkingLevel: "medium" as const,
    paths: {
      dataDir: "/tmp/book-explorer-test",
      agentDir: "/tmp/book-explorer-test/agent",
      cwd: "/tmp/book-explorer-test",
      authPath: "/tmp/book-explorer-test/auth.json",
      modelsPath: "/tmp/book-explorer-test/agent/models.json",
      modelsStorePath: "/tmp/book-explorer-test/agent/models-store.json",
      webSearchConfigPath: "/tmp/book-explorer-test/agent/web-search.json",
      webSearchCacheDir: "/tmp/book-explorer-test/agent/web-search-cache",
    },
    dependencies: {},
  } as never;
}

function coordinator(
  item: Fixture,
  driver: Driver,
  requestIds: string[] = ["request-1", "request-2", "request-3"],
): TurnCoordinator {
  let index = 0;
  return new TurnCoordinator({
    registry: item.registry,
    library: item.library,
    runtime: runtimeFixture(),
    requestIdFactory: () => requestIds[index++] ?? `request-${index}`,
    sessionFactory: async (
      tools: readonly ToolDefinition[],
      _capture: CitationCapture,
      sessionManager: SessionManager,
    ): Promise<TurnSessionLike> => {
      driver.tools = tools;
      driver.markerSeen = sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "book-explorer-request",
        );
      return {
        session: new FakeSession(sessionManager, driver),
        loader: {} as never,
      };
    },
  });
}

async function collectSubmit(
  service: TurnCoordinator,
  conversationId: number,
  text = "hello",
  options: { retryRequestId?: string; signal?: AbortSignal } = {},
): Promise<BrowserStreamEvent[]> {
  const events: BrowserStreamEvent[] = [];
  await service.submit(
    { conversationId, text, ...options },
    async (event: BrowserStreamEvent) => {
      events.push(event);
    },
  );
  return events;
}

class PiCompactionSession implements AgentSessionLike {
  constructor(
    private readonly session: AgentSession,
    private readonly compactAfterPrompt: boolean,
  ) {}

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    return this.session.subscribe(listener);
  }

  async prompt(text: string): Promise<void> {
    await this.session.prompt(text);
    if (this.compactAfterPrompt) {
      await this.session.sendUserMessage("additional context");
      await this.session.compact();
    }
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  dispose(): void {
    this.session.dispose();
  }
}

async function createPublicPiTurnSession(
  manager: SessionManager,
  root: string,
  faux: ReturnType<typeof fauxProvider>,
): Promise<TurnSessionLike> {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Book Explorer test prompt",
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { keepRecentTokens: 1, reserveTokens: 100 },
  });
  await loader.reload();
  const model = faux.getModel();
  const runtime = {
    getModel: () => model,
    getAvailableSnapshot: () => [model],
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ type: "api_key" }),
    isUsingOAuth: () => false,
    getAuth: async () => ({ auth: { apiKey: "faux" } }),
    streamSimple: (
      requestModel: typeof model,
      context: never,
      options: never,
    ) => faux.provider.streamSimple(requestModel, context, options),
  } as never;
  const result = await createAgentSession({
    cwd: root,
    agentDir,
    model: model as never,
    thinkingLevel: "medium",
    modelRuntime: runtime,
    settingsManager,
    noTools: "all",
    tools: [],
    resourceLoader: loader,
    sessionManager: manager,
  });
  return {
    session: new PiCompactionSession(result.session, true),
    loader,
  };
}

function sessionContents(item: Fixture, conversationId: number): string {
  const conversation = item.registry.get(conversationId);
  assert.ok(conversation);
  return readFileSync(
    join(item.root, "sessions", conversation.sessionFilename),
    "utf8",
  );
}

test("turn request marker is durable before prompt and normal completion disposes before releasing gate", async () => {
  const item = fixture();
  const driver = driverFixture();
  try {
    const service = coordinator(item, driver);
    const events = await collectSubmit(service, item.conversations[0]);
    assert.deepEqual(events, [
      { type: "text_delta", delta: "hello" },
      { type: "complete", incomplete: false },
    ]);
    assert.deepEqual(driver.promptTexts, ["hello"]);
    assert.equal(driver.markerSeen, true);
    assert.deepEqual(
      driver.tools?.map((tool) => tool.name),
      [
        "search_library",
        "get_book",
        "upsert_book",
        "upsert_series",
        "record_recommendation",
        "propose_change",
      ],
    );
    const content = sessionContents(item, item.conversations[0]);
    assert.match(content, /book-explorer-request/);
    assert.equal(service.activeRequestId, undefined);
    assert.equal(driver.abortCount, 0);
    assert.equal(driver.disposeCount, 1);
  } finally {
    dispose(item);
  }
});

test("turn retry reuses the request UUID and committed recommendation survives model failure", async () => {
  const item = fixture();
  let attempt = 0;
  const driver = driverFixture(async (session) => {
    const tools = driver.tools;
    assert.ok(tools);
    const bookResult = await tools
      .find((tool) => tool.name === "upsert_book")!
      .execute(
        "book-call",
        { title: "A Book", author: "An Author" } as never,
        undefined,
        undefined,
        {} as never,
      );
    const book = (bookResult.details as { ok: true; data: { id: number } })
      .data;
    await tools
      .find((tool) => tool.name === "record_recommendation")!
      .execute(
        `recommendation-${attempt}`,
        { bookId: book.id, rationale: `Recommendation ${attempt}` } as never,
        undefined,
        undefined,
        {} as never,
      );
    if (attempt++ === 0) throw new Error("model stream failed");
    session.emit({ type: "agent_end", messages: [], willRetry: false });
  });
  try {
    const service = coordinator(item, driver, ["request-retry", "unused"]);
    const first = await collectSubmit(service, item.conversations[0]);
    assert.equal(first.at(-1)?.type, "error");
    const firstError = first.at(-1);
    assert.equal(firstError?.type, "error");
    if (firstError?.type === "error")
      assert.equal(firstError.code, "internal_error");

    const second = await collectSubmit(
      service,
      item.conversations[0],
      "retry",
      { retryRequestId: "request-retry" },
    );
    assert.deepEqual(second, [{ type: "complete", incomplete: false }]);
    assert.equal(item.library.getBook(1)?.recommendations.length, 1);
    const content = sessionContents(item, item.conversations[0]);
    assert.equal((content.match(/book-explorer-request/g) ?? []).length, 2);
    assert.equal((content.match(/book-explorer-retry/g) ?? []).length, 1);
    assert.match(content, /request-retry/);
  } finally {
    dispose(item);
  }
});

test("turn tool calls remain distinct and direct edits are visible after a network wait", async () => {
  const item = fixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const driver = driverFixture(async (session) => {
    await waiting;
    const tools = driver.tools;
    assert.ok(tools);
    await tools
      .find((tool) => tool.name === "upsert_book")!
      .execute(
        "one",
        { title: "One", author: "Author" } as never,
        undefined,
        undefined,
        {} as never,
      );
    await tools
      .find((tool) => tool.name === "upsert_book")!
      .execute(
        "two",
        { title: "Two", author: "Author" } as never,
        undefined,
        undefined,
        {} as never,
      );
    const firstBook = item.library.searchBooks({ query: "One" }).items[0];
    assert.ok(firstBook);
    const read = await tools
      .find((tool) => tool.name === "get_book")!
      .execute(
        "read",
        { bookId: firstBook.id } as never,
        undefined,
        undefined,
        {} as never,
      );
    assert.equal(
      (read.details as { ok: true; data: { status: string } }).data.status,
      "read",
    );
    session.emit({ type: "agent_end", messages: [], willRetry: false });
  });
  try {
    const service = coordinator(item, driver, ["request-tools"]);
    const pending = collectSubmit(service, item.conversations[0]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const book = item.library.createOrFindBook({
      title: "One",
      author: "Author",
    });
    item.library.updateBook(book.id, { status: "read" }, "user");
    release();
    await pending;
    assert.equal(item.library.searchBooks({}).total, 2);
  } finally {
    dispose(item);
  }
});

test("stream maps text, tool, and captured citation events in order", async () => {
  const item = fixture();
  const driver = driverFixture();
  let capture!: CitationCapture;
  driver.prompt = async (session) => {
    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "web_search",
      args: {},
    });
    session.emit({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "web_search",
      args: {},
      partialResult: {},
    });
    capture.set("citation-1", {
      url: "https://example.test/source",
      title: "Source",
      snippet: "Evidence",
      provider: "openai",
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "web_search",
      result: {},
      isError: false,
    });
    session.emit({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "answer",
        partial: {} as never,
      },
    });
    session.emit({ type: "agent_end", messages: [], willRetry: false });
  };
  try {
    const service = new TurnCoordinator({
      registry: item.registry,
      library: item.library,
      runtime: runtimeFixture(),
      requestIdFactory: () => "request-stream",
      toolsFactory: (context) => {
        capture = context.citationCapture;
        return createBookExplorerTools(context);
      },
      sessionFactory: async (_tools, _capture, sessionManager) => ({
        session: new FakeSession(sessionManager, driver),
        loader: {} as never,
      }),
    });
    const events = await collectSubmit(service, item.conversations[0]);
    assert.deepEqual(events, [
      {
        type: "tool_status",
        toolCallId: "call-1",
        toolName: "web_search",
        status: "started",
      },
      {
        type: "tool_status",
        toolCallId: "call-1",
        toolName: "web_search",
        status: "updated",
      },
      {
        type: "tool_status",
        toolCallId: "call-1",
        toolName: "web_search",
        status: "completed",
        isError: false,
      },
      {
        type: "citation",
        token: "citation-1",
        citation: {
          url: "https://example.test/source",
          title: "Source",
          snippet: "Evidence",
          provider: "openai",
        },
      },
      { type: "text_delta", delta: "answer" },
      { type: "complete", incomplete: false },
    ]);
  } finally {
    dispose(item);
  }
});

test("turn proposal tool appends through the active manager without deadlocking the conversation gate", async () => {
  const item = fixture();
  const book = item.library.createOrFindBook({
    title: "Proposal Book",
    author: "Author",
  });
  const driver = driverFixture(async (session) => {
    const tool = driver.tools?.find((candidate) => candidate.name === "propose_change");
    assert.ok(tool);
    const result = await tool.execute(
      "proposal-call",
      {
        bookId: book.id,
        kind: "status",
        value: "read",
        semanticSlot: "reading-status",
        explanation: "The user finished the book.",
      } as never,
      undefined,
      undefined,
      {} as never,
    );
    assert.equal((result.details as { ok: boolean }).ok, true);
    session.emit({ type: "agent_end", messages: [], willRetry: false });
  });
  try {
    const service = coordinator(item, driver, ["request-proposal"]);
    const events = await collectSubmit(service, item.conversations[0]);
    assert.deepEqual(events, [{ type: "complete", incomplete: false }]);
    assert.equal(item.library.getBook(book.id)?.status, "recommended");
    const content = sessionContents(item, item.conversations[0]);
    assert.match(content, /book-explorer-proposed-change/);
  } finally {
    dispose(item);
  }
});

test("global gate makes a second conversation visibly busy and releases only after cleanup", async () => {
  const item = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const driver = driverFixture(async (session) => {
    await wait;
    session.emit({ type: "agent_end", messages: [], willRetry: false });
  });
  try {
    const service = coordinator(item, driver, ["request-one", "request-two"]);
    const first = collectSubmit(service, item.conversations[0]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(service.activeRequestId, "request-one");
    const second = await collectSubmit(service, item.conversations[1]);
    assert.deepEqual(second, [
      {
        type: "error",
        code: "global_busy",
        message: "Another model turn is active",
        retryable: true,
      },
    ]);
    release();
    await first;
    assert.equal(service.activeRequestId, undefined);
    const third = await collectSubmit(service, item.conversations[1]);
    assert.deepEqual(third, [{ type: "complete", incomplete: false }]);
  } finally {
    dispose(item);
  }
});

test("cancellation and disconnect produce structured incomplete errors and await abort before dispose", async () => {
  const item = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const driver = driverFixture(async (session) => {
    await wait;
    session.emit({ type: "agent_end", messages: [], willRetry: false });
  });
  try {
    const service = coordinator(item, driver, [
      "request-cancel",
      "request-disconnect",
    ]);
    const firstEvents: BrowserStreamEvent[] = [];
    const first = service.submit(
      { conversationId: item.conversations[0], text: "cancel me" },
      async (event: BrowserStreamEvent) => {
        firstEvents.push(event);
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await service.cancel("request-cancel"), true);
    release();
    await first;
    assert.deepEqual(firstEvents, [
      {
        type: "error",
        code: "cancelled",
        message: "Model turn cancelled",
        retryable: true,
        incomplete: true,
      },
    ]);
    assert.deepEqual(driver.lifecycle, [
      "abort-start",
      "abort-idle",
      "abort-end",
      "dispose",
    ]);

    const disconnectDriver = driverFixture(async (session) => {
      session.emit({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "disconnect",
          partial: {} as never,
        },
      });
      await new Promise<void>((resolve) => {
        disconnectDriver.releasePrompt = resolve;
      });
    });
    const disconnectService = coordinator(item, disconnectDriver, [
      "request-disconnect",
    ]);
    const broken = disconnectService.submit(
      { conversationId: item.conversations[1], text: "disconnect" },
      async () => {
        throw new Error("socket disconnected");
      },
    );
    await assert.rejects(broken, /socket disconnected|disconnect/i);
    assert.equal(disconnectService.activeRequestId, undefined);
    assert.deepEqual(disconnectDriver.lifecycle, [
      "abort-start",
      "abort-idle",
      "abort-end",
      "dispose",
    ]);
  } finally {
    dispose(item);
  }
});

test("turn error classification distinguishes auth, quota, search, and internal failures", async () => {
  const item = fixture();
  try {
    for (const [message, code, retryable] of [
      ["401 unauthorized", "authentication_error", false],
      ["429 quota exceeded", "quota_error", true],
      ["web search unavailable", "search_error", true],
      ["unexpected failure", "internal_error", true],
    ] as const) {
      const driver = driverFixture(async () => {
        throw new Error(message);
      });
      const service = coordinator(item, driver, [`request-${code}`]);
      const events = await collectSubmit(service, item.conversations[0]);
      assert.deepEqual(events, [
        { type: "error", code, message, retryable, incomplete: false },
      ]);
    }
  } finally {
    dispose(item);
  }
});

test("turn length-limited output completes as incomplete without treating it as a full response", async () => {
  const item = fixture();
  const driver = driverFixture(async (session) => {
    session.emit({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "partial",
        partial: {} as never,
      },
    });
    session.emit({
      type: "agent_end",
      messages: [
        { role: "assistant", stopReason: "length", content: [] } as never,
      ],
      willRetry: false,
    });
  });
  try {
    const service = coordinator(item, driver);
    const events = await collectSubmit(service, item.conversations[0]);
    assert.deepEqual(events, [
      { type: "text_delta", delta: "partial" },
      { type: "complete", incomplete: true },
    ]);
  } finally {
    dispose(item);
  }
});

test("compaction uses public Pi APIs for reopen and a fresh loader in one process", async () => {
  const item = fixture();
  const faux = fauxProvider({ provider: "book-explorer-faux" });
  faux.setResponses([
    fauxAssistantMessage("first answer"),
    fauxAssistantMessage("additional first answer"),
    fauxAssistantMessage("first compaction"),
    fauxAssistantMessage("first split compaction"),
    fauxAssistantMessage("second answer"),
    fauxAssistantMessage("additional second answer"),
    fauxAssistantMessage("second compaction"),
    fauxAssistantMessage("second split compaction"),
  ]);
  const loaders: unknown[] = [];
  let registry = item.registry;
  try {
    const createCoordinator = (currentRegistry: ConversationRegistry) =>
      new TurnCoordinator({
        registry: currentRegistry,
        library: item.library,
        runtime: runtimeFixture(),
        requestIdFactory: () => `request-${loaders.length + 1}`,
        sessionFactory: async (_tools, _capture, manager) => {
          const turn = await createPublicPiTurnSession(
            manager,
            item.root,
            faux,
          );
          loaders.push(turn.loader);
          return turn;
        },
      });

    await collectSubmit(
      createCoordinator(registry),
      item.conversations[0],
      "first",
    );
    const firstCompactions = await registry.withConversation(
      item.conversations[0],
      (manager) =>
        manager.getEntries().filter((entry) => entry.type === "compaction"),
    );
    assert.equal(firstCompactions.length, 1);

    registry.close();
    registry = new ConversationRegistry(item.db, {
      cwd: item.root,
      sessionDir: join(item.root, "sessions"),
    });
    await collectSubmit(
      createCoordinator(registry),
      item.conversations[0],
      "second",
    );
    const entries = await registry.withConversation(
      item.conversations[0],
      (manager) => manager.getEntries(),
    );
    assert.equal(
      entries.filter((entry) => entry.type === "compaction").length,
      2,
    );
    assert.equal(
      entries.some(
        (entry) =>
          entry.type === "message" && entry.message.role === "assistant",
      ),
      true,
    );
    assert.equal(loaders.length, 2);
    assert.notEqual(loaders[0], loaders[1]);
  } finally {
    registry.close();
    closeDatabase(item.db);
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("stream awaits backpressure before completing", async () => {
  const item = fixture();
  const driver = driverFixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const service = coordinator(item, driver);
    let delivered = false;
    const pending = service.submit(
      { conversationId: item.conversations[0], text: "backpressure" },
      async (event: BrowserStreamEvent) => {
        if (event.type === "text_delta") {
          await blocked;
          delivered = true;
        }
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(delivered, false);
    assert.notEqual(service.activeRequestId, undefined);
    release();
    await pending;
    assert.equal(delivered, true);
  } finally {
    dispose(item);
  }
});

void SessionManager;
