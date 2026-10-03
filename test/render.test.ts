import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHttpServer } from "../src/http.js";
import { FakeDocument, type FakeNodeLike } from "./fake-dom.js";

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
  renderBookSummary(
    document: FakeDocument,
    book: { id: number; title: string; author: string; noteCount: number },
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

function findTag(
  node: FakeNodeLike,
  tagName: string,
): FakeNodeLike | undefined {
  if (node.tagName === tagName) return node;
  for (const child of node.children) {
    const match = findTag(child, tagName);
    if (match) return match;
  }
  return undefined;
}

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
    assert.match(shell.body, /Source_Sans_3_Variable/);
    assert.match(shell.body, /text-\[15px\]/);
    assert.match(css.body, /\.btn\{/);
    assert.match(css.body, /Inter Variable/);
    assert.match(css.body, /Source Sans 3 Variable/);
    assert.match(css.body, /Literata Variable/);
    assert.match(shell.body, /src="\/app\.bundle\.js"/);
    const script = await get(address.port, "/app.bundle.js");
    assert.equal(script.status, 200);
    assert.equal(script.contentType, "text/javascript; charset=utf-8");
    for (const font of ["inter", "source-sans-3", "literata"]) {
      const response = await get(address.port, `/fonts/${font}.woff2`);
      assert.equal(response.status, 200);
      assert.equal(response.contentType, "font/woff2");
      assert.ok(response.body.length > 0);
    }
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

test("book summaries indicate notes without exposing their contents", async () => {
  const { renderBookSummary } = await renderer;
  const withNotes = renderBookSummary(new FakeDocument(), {
    id: 1,
    title: "Book",
    author: "Author",
    noteCount: 2,
  });
  const withoutNotes = renderBookSummary(new FakeDocument(), {
    id: 2,
    title: "Other Book",
    author: "Other Author",
    noteCount: 0,
  });

  assert.match(withNotes.textContent, /Has notes/);
  assert.doesNotMatch(withNotes.textContent, /First note|Second note/);
  assert.doesNotMatch(withoutNotes.textContent, /Has notes/);
});

test("assistant Markdown renders formatting while keeping raw HTML inert", async () => {
  const { renderMessage } = await renderer;
  const document = new FakeDocument();
  const formatted = renderMessage(document, {
    role: "assistant",
    content: "Use **bold** and *italics*.",
  });
  const body = formatted.children[1];
  const paragraph = body.children[0];

  assert.equal(paragraph.tagName, "P");
  assert.deepEqual(
    paragraph.children.map((child) => child.tagName ?? "TEXT"),
    ["TEXT", "STRONG", "TEXT", "EM", "TEXT"],
  );
  assert.match(body.className ?? "", /Literata/);

  const unsafe = renderMessage(document, {
    role: "assistant",
    content:
      '<img src=x onerror="alert(1)"> **safe** [bad](javascript:alert(1))',
  });
  const unsafeParagraph = unsafe.children[1].children[0];
  assert.match(unsafe.textContent, /<img src=x onerror=/);
  assert.equal(unsafeParagraph.children[0].tagName, undefined);
  assert.equal(
    unsafeParagraph.children.some((child) => child.tagName === "A"),
    false,
  );
});

test("assistant Markdown safely renders partial tables, images, and headings", async () => {
  const { renderMessage } = await renderer;
  const document = new FakeDocument();
  const table = "| Title | Author |\n| --- | --- |\n| Dune | Frank Herbert |";

  for (let index = 1; index <= table.length; index += 1) {
    assert.doesNotThrow(() =>
      renderMessage(document, {
        role: "assistant",
        content: table.slice(0, index),
      }),
    );
  }
  const renderedTable = renderMessage(document, {
    role: "assistant",
    content: table,
  });
  assert.ok(findTag(renderedTable, "TABLE"));
  assert.match(renderedTable.textContent, /Frank Herbert/);

  const renderedImage = renderMessage(document, {
    role: "assistant",
    content: "![Cover](https://example.test/cover.jpg)",
  });
  const image = findTag(renderedImage, "IMG");
  assert.ok(image);
  assert.equal(image.attributes.src, "https://example.test/cover.jpg");
  assert.equal(image.attributes.referrerpolicy, "no-referrer");

  const renderedHeading = renderMessage(document, {
    role: "assistant",
    content: "## Recommendations",
  });
  assert.match(findTag(renderedHeading, "H2")?.className ?? "", /Inter/);
});

test("renderMessage keeps user Markdown and HTML as text", async () => {
  const { renderMessage } = await renderer;
  const node = renderMessage(new FakeDocument(), {
    role: "user",
    content: '<img src=x onerror="alert(1)"> **literal**',
  });

  assert.match(node.textContent, /<img src=x/);
  assert.match(node.textContent, /\*\*literal\*\*/);
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
