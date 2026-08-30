import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHttpServer } from "../src/http.js";

interface FakeNodeLike {
  nodeType: "element" | "text";
  tagName?: string;
  textContent: string;
  children: FakeNodeLike[];
  attributes: Record<string, string>;
  className?: string;
  rel?: string;
  href?: string;
  src?: string;
  referrerPolicy?: string;
  appendChild(child: FakeNodeLike): FakeNodeLike;
  append(...children: FakeNodeLike[]): void;
  setAttribute(name: string, value: string): void;
}

class FakeNode implements FakeNodeLike {
  readonly children: FakeNodeLike[] = [];
  readonly attributes: Record<string, string> = {};
  className = "";
  rel = "";
  href = "";
  src = "";
  referrerPolicy = "";
  private text = "";

  constructor(
    readonly nodeType: "element" | "text",
    readonly tagName?: string,
  ) {}

  get textContent(): string {
    if (this.nodeType === "text") return this.text;
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.text = String(value);
    this.children.length = 0;
  }

  appendChild(child: FakeNodeLike): FakeNodeLike {
    this.children.push(child);
    return child;
  }

  append(...children: FakeNodeLike[]): void {
    for (const child of children) this.appendChild(child);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

class FakeDocument {
  createElement(tagName: string): FakeNode {
    return new FakeNode("element", tagName.toUpperCase());
  }

  createTextNode(value: string): FakeNode {
    const node = new FakeNode("text");
    node.textContent = value;
    return node;
  }
}

interface Renderers {
  renderMessage(
    document: FakeDocument,
    message: { role: string; content: unknown; incomplete?: boolean },
  ): FakeNodeLike;
  renderCitation(
    document: FakeDocument,
    citation: { url: string; title?: string; snippet?: string | null },
  ): FakeNodeLike | null;
  renderCover(
    document: FakeDocument,
    coverUrl: unknown,
    alt?: unknown,
  ): FakeNodeLike | null;
  renderAssistantMessage(
    document: FakeDocument,
    content: unknown,
    incomplete?: boolean,
  ): FakeNodeLike;
  createStreamContext(conversationId: number): {
    conversationId: number;
    assistantText: string;
    terminal: boolean;
  };
  recordToolStatus(
    context: unknown,
    status: { toolCallId: string; toolName: string; isError?: boolean },
  ): string;
  summarizeToolActivity(context: unknown): string;
  isCurrentStream(
    context: unknown,
    activeContext: unknown,
    conversationId: number,
  ): boolean;
  markStreamTerminal(
    context: { terminal: boolean },
    event: { type: string },
  ): boolean;
  streamNeedsIncomplete(context: { terminal: boolean }): boolean;
}

async function get(
  port: number,
  path: string,
): Promise<{
  status: number;
  contentType: string | undefined;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: response.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

const renderer = (async (): Promise<Renderers> => {
  const module = (await import(
    new URL("../../public/render.js", import.meta.url).href
  )) as unknown as Renderers;
  return module;
})();

test("static shell serves fixed assets with JSON CSRF data", async () => {
  const server = createHttpServer({
    library: { searchBooks: () => ({}) },
    registry: { list: () => [] },
    openLibrary: { lookup: () => ({}) },
    turns: {
      submit: async () => undefined,
      steer: () => false,
      cancel: () => false,
    },
  } as never);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const shell = await get(address.port, "/");
    assert.equal(shell.status, 200);
    assert.equal(shell.contentType, "text/html; charset=utf-8");
    assert.match(shell.body, new RegExp(JSON.stringify(server.csrfToken)));
    assert.equal(shell.body.includes("__BOOK_EXPLORER_CSRF_TOKEN__"), false);
    const css = await get(address.port, "/styles.css");
    assert.equal(css.status, 200);
    assert.equal(css.contentType, "text/css; charset=utf-8");
    assert.match(shell.body, /class="[^"]*btn btn-primary/);
    assert.match(shell.body, /<dialog\s+id="drawer"/);
    assert.match(shell.body, /id="open-drawer"/);
    assert.match(css.body, /\.btn\{/);
    const script = await get(address.port, "/app.js");
    assert.equal(script.status, 200);
    assert.equal(script.contentType, "text/javascript; charset=utf-8");
    const rendererScript = await get(address.port, "/render.js");
    assert.equal(rendererScript.status, 200);
    assert.equal(rendererScript.contentType, "text/javascript; charset=utf-8");
    const missing = await get(address.port, "/package.json");
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("static assets resolve relative to the module instead of the working directory", async () => {
  const originalCwd = process.cwd();
  const emptyCwd = mkdtempSync(join(tmpdir(), "book-explorer-static-"));
  let server: ReturnType<typeof createHttpServer> | undefined;
  try {
    process.chdir(emptyCwd);
    const module = (await import(
      new URL(`../src/http.js?static=${Date.now()}`, import.meta.url).href
    )) as typeof import("../src/http.js");
    server = module.createHttpServer({
      library: { searchBooks: () => ({}) },
      registry: { list: () => [] },
      openLibrary: { lookup: () => ({}) },
      turns: {
        submit: async () => undefined,
        steer: () => false,
        cancel: () => false,
      },
    } as never);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => {
        server!.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    assert.equal((await get(address.port, "/")).status, 200);
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    process.chdir(originalCwd);
    rmSync(emptyCwd, { recursive: true, force: true });
  }
});

test("renderMessage keeps malicious HTML as text", async () => {
  const { renderMessage } = await renderer;
  const node = renderMessage(new FakeDocument(), {
    role: "assistant",
    content: '<img src=x onerror="alert(1)">',
  });

  assert.match(node.textContent, /<img src=x/);
  assert.equal(
    node.children.some((child) => child.tagName === "IMG"),
    false,
  );
});

test("renderCitation omits unsafe and malformed URLs", async () => {
  const { renderCitation } = await renderer;
  const document = new FakeDocument();

  assert.equal(
    renderCitation(document, {
      url: "javascript:alert(1)",
      title: "unsafe",
    }),
    null,
  );
  assert.equal(
    renderCitation(document, { url: "%not-a-url", title: "malformed" }),
    null,
  );

  const link = renderCitation(document, {
    url: "https://example.test/books/1",
    title: "Safe source",
  });
  assert.ok(link);
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(link.href, "https://example.test/books/1");
  assert.equal(link.textContent, "Safe source");
});

test("renderCover rejects unsafe schemes and sets referrer policy", async () => {
  const { renderCover } = await renderer;
  const document = new FakeDocument();

  assert.equal(renderCover(document, "data:image/svg+xml,<svg></svg>"), null);
  const image = renderCover(
    document,
    "http://covers.example.test/book.jpg",
    "Book",
  );
  assert.ok(image);
  assert.equal(image.src, "http://covers.example.test/book.jpg");
  assert.equal(image.referrerPolicy, "no-referrer");
});

test("incomplete assistant output is marked", async () => {
  const { renderAssistantMessage } = await renderer;
  const node = renderAssistantMessage(new FakeDocument(), "partial", true);

  assert.match(node.className ?? "", /incomplete/);
  assert.match(node.textContent, /partial/);
  assert.match(node.textContent, /incomplete/i);
});

test("stale stream contexts are ignored after conversation switching", async () => {
  const { createStreamContext, isCurrentStream } = await renderer;
  const first = createStreamContext(1);
  const second = createStreamContext(2);

  assert.equal(isCurrentStream(first, first, 1), true);
  assert.equal(isCurrentStream(first, second, 2), false);
  assert.equal(isCurrentStream(first, first, 2), false);
});

test("tool activity stays compact and summarizes unique calls", async () => {
  const { createStreamContext, recordToolStatus, summarizeToolActivity } =
    await renderer;
  const context = createStreamContext(1);

  assert.equal(
    recordToolStatus(context, {
      toolCallId: "search-1",
      toolName: "web_search",
    }),
    "Using web_search…",
  );
  recordToolStatus(context, {
    toolCallId: "search-1",
    toolName: "web_search",
  });
  assert.equal(summarizeToolActivity(context), "✓ Used 1 tool");

  recordToolStatus(context, {
    toolCallId: "book-1",
    toolName: "get_book",
    isError: true,
  });
  assert.equal(summarizeToolActivity(context), "⚠ Used 2 tools · 1 failed");
});

test("stream terminal tracking distinguishes complete/error from abnormal EOF", async () => {
  const {
    createStreamContext,
    markStreamTerminal,
    streamNeedsIncomplete,
    renderAssistantMessage,
  } = await renderer;
  const document = new FakeDocument();
  const partial = createStreamContext(1);
  const partialNode = renderAssistantMessage(
    document,
    "partial",
    streamNeedsIncomplete(partial),
  );
  assert.match(partialNode.className ?? "", /incomplete/);

  assert.equal(markStreamTerminal(partial, { type: "complete" }), true);
  assert.equal(streamNeedsIncomplete(partial), false);
  const failed = createStreamContext(1);
  assert.equal(markStreamTerminal(failed, { type: "error" }), true);
  assert.equal(streamNeedsIncomplete(failed), false);
});
