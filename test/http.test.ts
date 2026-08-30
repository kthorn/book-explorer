import assert from "node:assert/strict";
import { request as httpRequest, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDatabase, openDatabase, type Database } from "../src/db.js";
import { ConversationRegistry } from "../src/conversations.js";
import { createProposal } from "../src/proposals.js";
import { LibraryRepository } from "../src/library.js";
import {
  createHttpServer,
  type HttpOpenLibrary,
  type HttpServer,
} from "../src/http.js";
import type { BrowserStreamEvent } from "../src/turns.js";

interface Fixture {
  root: string;
  db: Database;
  library: LibraryRepository;
  registry: ConversationRegistry;
  api: HttpServer;
  port: number;
  host: string;
  conversationId: number;
  turns: FakeTurns;
  openLibrary: TestOpenLibrary;
}

interface TestOpenLibrary extends HttpOpenLibrary {
  fail: boolean;
}

class FakeTurns {
  activeRequestId: string | undefined;
  submitted: Array<{
    conversationId: number;
    text: string;
    retryRequestId?: string;
    signal?: AbortSignal;
  }> = [];
  cancelled: string[] = [];
  steered: Array<{ conversationId: number; text: string }> = [];
  signals: AbortSignal[] = [];
  emit: ((event: BrowserStreamEvent) => Promise<void>) | undefined;
  nextRequestId = "request-http";
  busy = false;
  burst = false;
  hold = false;
  release?: () => void;
  firstEventReturned = false;
  rawError?: BrowserStreamEvent;

  async submit(
    input: {
      conversationId: number;
      text: string;
      retryRequestId?: string;
      signal?: AbortSignal;
    },
    emit: (event: BrowserStreamEvent) => Promise<void>,
  ): Promise<void> {
    if (input.signal) this.signals.push(input.signal);
    if (this.busy) {
      await emit({
        type: "error",
        code: "global_busy",
        message: "Another model turn is active",
        retryable: true,
      });
      return;
    }
    this.submitted.push(input);
    this.emit = emit;
    this.activeRequestId = this.nextRequestId;
    if (this.rawError) {
      await emit(this.rawError);
      this.firstEventReturned = true;
      this.activeRequestId = undefined;
      return;
    }
    if (this.burst) {
      for (let index = 0; index < 40; index += 1) {
        await emit({ type: "text_delta", delta: "x".repeat(20_000) });
      }
    } else {
      await emit({ type: "text_delta", delta: "hello" });
    }
    this.firstEventReturned = true;
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      this.release = undefined;
    }
    await emit({ type: "complete", incomplete: false });
    this.activeRequestId = undefined;
  }

  async cancel(requestId: string): Promise<boolean> {
    if (this.activeRequestId !== requestId) return false;
    this.cancelled.push(requestId);
    this.activeRequestId = undefined;
    return true;
  }

  async steer(conversationId: number, text: string): Promise<boolean> {
    if (!this.activeRequestId) return false;
    this.steered.push({ conversationId, text });
    return true;
  }
}

function fixture(options: { host?: string; origin?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "book-explorer-http-"));
  const db = openDatabase(join(root, "library.sqlite"));
  const registry = new ConversationRegistry(db, {
    cwd: root,
    sessionDir: join(root, "sessions"),
  });
  const library = new LibraryRepository(db);
  const turns = new FakeTurns();
  const openLibrary: TestOpenLibrary = {
    fail: false,
    async lookup() {
      if (openLibrary.fail) throw new Error("Open Library unavailable");
      return {
        metadata: {
          workId: "OL123W",
          title: "Lookup",
          author: "Author",
          publicationYear: 2026,
          coverUrl: null,
          seriesHints: [],
          identifiers: [
            {
              scheme: "openlibrary_work",
              value: "OL123W",
              source: "openlibrary",
            },
          ],
        },
      };
    },
  };
  const api = createHttpServer({
    library,
    registry,
    openLibrary,
    turns,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
  const conversationId = registry.create("HTTP").id;
  return {
    root,
    db,
    library,
    registry,
    api,
    port: 0,
    host: "",
    conversationId,
    turns,
    openLibrary,
  };
}

async function start(item: Fixture): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    item.api.once("error", reject);
    item.api.listen(0, "127.0.0.1", () => {
      item.api.off("error", reject);
      const address = item.api.address();
      assert.ok(address && typeof address === "object");
      item.port = address.port;
      item.host = `127.0.0.1:${item.port}`;
      resolve();
    });
  });
}

async function stop(item: Fixture): Promise<void> {
  await new Promise<void>((resolve) => item.api.close(() => resolve()));
  item.registry.close();
  closeDatabase(item.db);
  rmSync(item.root, { recursive: true, force: true });
}

async function call(
  item: Fixture,
  method: string,
  path: string,
  body?: unknown,
  options: {
    secure?: boolean;
    contentType?: string;
    host?: string;
    origin?: string;
    csrf?: string;
  } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  raw: string;
}> {
  const secure = options.secure !== false;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (payload !== undefined) {
    headers["content-length"] = Buffer.byteLength(payload).toString();
    headers["content-type"] = options.contentType ?? "application/json";
  }
  if (secure) {
    headers.host = options.host ?? item.host;
    headers.origin = options.origin ?? `http://${item.host}`;
    headers["x-csrf-token"] = options.csrf ?? item.api.csrfToken;
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: item.port,
        method,
        path,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = raw;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            // SSE and malformed bodies stay available as raw text.
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: parsed,
            raw,
          });
        });
      },
    );
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function parsedSse(raw: string): BrowserStreamEvent[] {
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const data = block
        .split("\n")
        .find((line) => line.startsWith("data: "));
      assert.ok(data);
      // SAFETY: the HTTP route emits only serialized BrowserStreamEvent values.
      return JSON.parse(data.slice("data: ".length)) as BrowserStreamEvent;
    });
}

function assertNoCors(headers: Record<string, string | string[] | undefined>): void {
  for (const name of Object.keys(headers)) {
    assert.equal(name.toLowerCase().startsWith("access-control-"), false);
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not observed");
}

test("HTTP route contract covers conversations, books, series, notes, and recommendations", async () => {
  const item = fixture();
  await start(item);
  try {
    const createdSeries = await call(item, "POST", "/api/series", {
      name: "Saga",
      note: "Note",
    });
    assert.equal(createdSeries.status, 201);
    assert.deepEqual(createdSeries.body, item.library.getSeries((createdSeries.body as { id: number }).id));
    assertNoCors(createdSeries.headers);
    const seriesId = (createdSeries.body as { id: number }).id;
    const seriesPage = await call(item, "GET", "/api/series?limit=20&offset=0");
    assert.equal(seriesPage.status, 200);
    assert.deepEqual(seriesPage.body, item.library.searchSeries({ limit: 20, offset: 0 }));
    assertNoCors(seriesPage.headers);
    const updatedSeries = await call(item, "PATCH", `/api/series/${seriesId}`, {
      name: "New Saga",
    });
    assert.equal(updatedSeries.status, 200);
    assert.deepEqual(updatedSeries.body, item.library.getSeries(seriesId));
    assertNoCors(updatedSeries.headers);

    const createdBook = await call(item, "POST", "/api/books", {
      title: "Book",
      author: "Author",
      seriesId,
      identifiers: [
        { scheme: "openlibrary_work", value: "OL123W", source: "test" },
      ],
    });
    assert.equal(createdBook.status, 201);
    const bookId = (createdBook.body as { id: number }).id;
    assert.deepEqual(createdBook.body, item.library.getBook(bookId));
    assertNoCors(createdBook.headers);
    const booksPage = await call(item, "GET", "/api/books");
    assert.equal(booksPage.status, 200);
    assert.deepEqual(booksPage.body, item.library.searchBooks({ limit: 20, offset: 0 }));
    assertNoCors(booksPage.headers);
    const fetchedBook = await call(item, "GET", `/api/books/${bookId}`);
    assert.equal(fetchedBook.status, 200);
    assert.deepEqual(fetchedBook.body, item.library.getBook(bookId));
    assertNoCors(fetchedBook.headers);
    const updatedBook = await call(item, "PATCH", `/api/books/${bookId}`, {
      status: "read",
      rating: 5,
    });
    assert.equal(updatedBook.status, 200);
    assert.deepEqual(updatedBook.body, item.library.getBook(bookId));
    assertNoCors(updatedBook.headers);
    const replacedIdentifiers = await call(item, "PATCH", `/api/books/${bookId}`, {
      identifiers: [
        { scheme: "isbn13", value: "978-0-306-40615-7", source: "edited" },
      ],
    });
    assert.equal(replacedIdentifiers.status, 200);
    assert.deepEqual(
      (replacedIdentifiers.body as { identifiers: unknown[] }).identifiers,
      item.library.getBook(bookId)?.identifiers,
    );
    assert.equal(
      (replacedIdentifiers.body as { identifiers: Array<{ value: string }> })
        .identifiers[0]?.value,
      "9780306406157",
    );
    const removedIdentifiers = await call(item, "PATCH", `/api/books/${bookId}`, {
      identifiers: [],
    });
    assert.equal(removedIdentifiers.status, 200);
    assert.deepEqual(
      (removedIdentifiers.body as { identifiers: unknown[] }).identifiers,
      [],
    );

    const note = item.library.addNote(bookId, "Old note");
    const updatedNote = await call(item, "PATCH", `/api/books/${bookId}/notes/${note.id}`, {
      note: "New note",
    });
    assert.equal(updatedNote.status, 200);
    assert.deepEqual(updatedNote.body, item.library.getNote(note.id));
    assertNoCors(updatedNote.headers);
    const deletedNote = await call(item, "DELETE", `/api/books/${bookId}/notes/${note.id}`);
    assert.equal(deletedNote.status, 204);
    assert.equal(deletedNote.body, undefined);
    assertNoCors(deletedNote.headers);
    item.library.recordRecommendation("request-http", bookId, "Rationale");
    const recommendationPage = await call(item, "GET", `/api/books/${bookId}/recommendations`);
    assert.equal(recommendationPage.status, 200);
    assert.deepEqual(recommendationPage.body, item.library.listRecommendations(bookId, { limit: 20, offset: 0 }));
    assertNoCors(recommendationPage.headers);

    const createdConversation = await call(item, "POST", "/api/conversations", {
      name: "Second",
    });
    assert.equal(createdConversation.status, 201);
    const conversationId = (createdConversation.body as { id: number }).id;
    assert.deepEqual(createdConversation.body, item.registry.get(conversationId));
    assertNoCors(createdConversation.headers);
    const conversationsPage = await call(item, "GET", "/api/conversations");
    assert.equal(conversationsPage.status, 200);
    assert.deepEqual(conversationsPage.body, {
      items: item.registry.list({ limit: 20, offset: 0 }),
      total: 2,
      limit: 20,
      offset: 0,
    });
    assertNoCors(conversationsPage.headers);
    const conversation = await call(
      item,
      "GET",
      `/api/conversations/${conversationId}`,
    );
    assert.equal(conversation.status, 200);
    assert.deepEqual(conversation.body, {
      ...item.registry.get(conversationId),
      transcript: [],
    });
    assertNoCors(conversation.headers);
    const renamedConversation = await call(item, "PATCH", `/api/conversations/${conversationId}`, {
      name: "Renamed",
    });
    assert.equal(renamedConversation.status, 200);
    assert.deepEqual(renamedConversation.body, item.registry.get(conversationId));
    assertNoCors(renamedConversation.headers);
    const archivedConversation = await call(
      item,
      "POST",
      `/api/conversations/${conversationId}/archive`,
      { archived: true },
    );
    assert.equal(archivedConversation.status, 200);
    assert.deepEqual(archivedConversation.body, item.registry.get(conversationId));
    assertNoCors(archivedConversation.headers);
    const deletedConversation = await call(item, "DELETE", `/api/conversations/${conversationId}`);
    assert.equal(deletedConversation.status, 204);
    assert.equal(deletedConversation.body, undefined);
    assertNoCors(deletedConversation.headers);
    const deletedSeries = await call(item, "DELETE", `/api/series/${seriesId}`);
    assert.equal(deletedSeries.status, 204);
    assert.equal(deletedSeries.body, undefined);
    assertNoCors(deletedSeries.headers);
    const deletedBook = await call(item, "DELETE", `/api/books/${bookId}`);
    assert.equal(deletedBook.status, 204);
    assert.equal(deletedBook.body, undefined);
    assertNoCors(deletedBook.headers);
  } finally {
    await stop(item);
  }
});

test("HTTP proposal, Open Library, and message routes use service APIs", async () => {
  const item = fixture();
  await start(item);
  try {
    const book = item.library.createOrFindBook({
      title: "Book",
      author: "Author",
    });
    const proposal = await createProposal(item.registry, item.conversationId, {
      requestId: "proposal-request",
      bookId: book.id,
      kind: "status",
      value: "read",
      semanticSlot: "status",
      explanation: "Finished",
    });
    const pending = await call(
      item,
      "GET",
      `/api/conversations/${item.conversationId}/proposals`,
    );
    assert.equal(pending.status, 200);
    const pendingProposal = (pending.body as Array<Record<string, unknown>>)[0];
    assert.ok(pendingProposal);
    assert.deepEqual(
      { ...pendingProposal, createdAt: undefined },
      { ...proposal, createdAt: undefined, state: "pending" },
    );
    assertNoCors(pending.headers);
    const accepted = await call(
      item,
      "POST",
      `/api/conversations/${item.conversationId}/proposals/${proposal.proposalId}/accept`,
      { value: "read" },
    );
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, {
      proposalId: proposal.proposalId,
      state: "accepted",
      value: "read",
      bookId: book.id,
      kind: "status",
    });
    assertNoCors(accepted.headers);

    const lookup = await call(item, "POST", "/api/open-library/lookup", {
      workId: "OL123W",
    });
    assert.equal(lookup.status, 200);
    assert.deepEqual(lookup.body, {
      metadata: {
        workId: "OL123W",
        title: "Lookup",
        author: "Author",
        publicationYear: 2026,
        coverUrl: null,
        seriesHints: [],
        identifiers: [
          {
            scheme: "openlibrary_work",
            value: "OL123W",
            source: "openlibrary",
          },
        ],
      },
    });
    assertNoCors(lookup.headers);

    item.openLibrary.fail = true;
    const failedLookup = await call(item, "POST", "/api/open-library/lookup", {
      workId: "OL123W",
    });
    assert.equal(failedLookup.status, 500);
    assert.deepEqual(failedLookup.body, {
      error: {
        code: "internal_error",
        message: "Internal server error",
        retryable: true,
      },
    });
    assertNoCors(failedLookup.headers);
    item.openLibrary.fail = false;
    const manuallyCreated = await call(item, "POST", "/api/books", {
      title: "Manual",
      author: "Entry",
    });
    assert.equal(manuallyCreated.status, 201);
    const manualBookId = (manuallyCreated.body as { id: number }).id;
    assert.deepEqual(manuallyCreated.body, item.library.getBook(manualBookId));
    assertNoCors(manuallyCreated.headers);

    item.turns.activeRequestId = "active-request";
    const mismatchedCancellation = await call(
      item,
      "POST",
      "/api/requests/wrong-request/cancel",
      {},
    );
    assert.equal(mismatchedCancellation.status, 409);
    assert.deepEqual(mismatchedCancellation.body, {
      error: {
        code: "request_not_active",
        message: "The request is no longer active",
        retryable: false,
      },
    });
    assertNoCors(mismatchedCancellation.headers);
    assert.deepEqual(item.turns.cancelled, []);
    const cancellation = await call(
      item,
      "POST",
      "/api/requests/active-request/cancel",
      {},
    );
    assert.equal(cancellation.status, 202);
    assert.deepEqual(cancellation.body, {
      requestId: "active-request",
      cancelled: true,
    });
    assert.deepEqual(item.turns.cancelled, ["active-request"]);
    assertNoCors(cancellation.headers);
    const staleCancellation = await call(
      item,
      "POST",
      "/api/requests/active-request/cancel",
      {},
    );
    assert.equal(staleCancellation.status, 409);
    assert.deepEqual(staleCancellation.body, {
      error: {
        code: "request_not_active",
        message: "The request is no longer active",
        retryable: false,
      },
    });
    assertNoCors(staleCancellation.headers);

    const stream = await call(
      item,
      "POST",
      `/api/conversations/${item.conversationId}/messages`,
      { text: "Hello" },
    );
    assert.equal(stream.status, 200);
    assert.equal(stream.headers["content-type"], "text/event-stream");
    assert.deepEqual(parsedSse(stream.raw), [
      { type: "text_delta", delta: "hello" },
      { type: "complete", incomplete: false },
    ]);
    assert.equal(item.turns.submitted[0]?.conversationId, item.conversationId);
    assert.equal(item.turns.submitted[0]?.text, "Hello");
    assertNoCors(stream.headers);

    item.turns.busy = true;
    const busyStream = await call(
      item,
      "POST",
      `/api/conversations/${item.conversationId}/messages`,
      { text: "Busy" },
    );
    assert.equal(busyStream.status, 200);
    assert.deepEqual(parsedSse(busyStream.raw), [
      {
        type: "error",
        code: "global_busy",
        message: "Another model turn is active",
        retryable: true,
      },
    ]);
    assertNoCors(busyStream.headers);
    item.turns.busy = false;
    item.turns.burst = true;
    const burstStream = await call(
      item,
      "POST",
      `/api/conversations/${item.conversationId}/messages`,
      { text: "Backpressure" },
    );
    assert.equal(burstStream.status, 200);
    const burstEvents = parsedSse(burstStream.raw);
    assert.equal(burstEvents.length, 41);
    assert.deepEqual(burstEvents.at(-1), {
      type: "complete",
      incomplete: false,
    });
    assertNoCors(burstStream.headers);

    const rejectedProposal = await createProposal(
      item.registry,
      item.conversationId,
      {
        requestId: "proposal-request-2",
        bookId: book.id,
        kind: "rating",
        value: 5,
        semanticSlot: "rating",
        explanation: "Favorite",
      },
    );
    const rejected = await call(
      item,
      "POST",
      `/api/conversations/${item.conversationId}/proposals/${rejectedProposal.proposalId}/reject`,
      {},
    );
    assert.equal(rejected.status, 200);
    assert.deepEqual(rejected.body, {
      proposalId: rejectedProposal.proposalId,
      state: "rejected",
      value: 5,
      bookId: book.id,
      kind: "rating",
    });
    assertNoCors(rejected.headers);
  } finally {
    await stop(item);
  }
});

test("HTTP accepts steering only while a turn is active", async () => {
  const item = fixture();
  await start(item);
  try {
    const inactive = await call(
      item,
      "POST",
      `/api/conversations/${item.conversationId}/steer`,
      { text: "too soon" },
    );
    assert.equal(inactive.status, 409);
    assert.deepEqual(inactive.body, {
      error: {
        code: "turn_not_active",
        message: "This conversation has no active model turn",
        retryable: true,
      },
    });

    item.turns.activeRequestId = "request-steer";
    const accepted = await call(
      item,
      "POST",
      `/api/conversations/${item.conversationId}/steer`,
      { text: "focus on the sequel" },
    );
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.body, { steered: true });
    assert.deepEqual(item.turns.steered, [
      {
        conversationId: item.conversationId,
        text: "focus on the sequel",
      },
    ]);
  } finally {
    await stop(item);
  }
});

test("HTTP transcript marks persisted assistant stop reasons as incomplete", async () => {
  const item = fixture();
  await start(item);
  try {
    await item.registry.withConversation(item.conversationId, (manager) => {
      for (const stopReason of ["aborted", "error", "length", "stop"]) {
        manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: stopReason }],
          stopReason,
        } as never);
      }
    });

    const response = await call(
      item,
      "GET",
      `/api/conversations/${item.conversationId}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body as { transcript: Array<{ incomplete?: boolean }> })
        .transcript.map((entry) => entry.incomplete === true),
      [true, true, true, false],
    );
  } finally {
    await stop(item);
  }
});

test("HTTP sanitizes raw turn error messages before sending SSE", async () => {
  const item = fixture();
  await start(item);
  try {
    const bearer = "sk-raw-bearer-secret";
    const quotedApiKey = "quoted raw api secret";
    const quotedToken = "single raw token secret";
    item.turns.rawError = {
      type: "error",
      code: "authentication_error",
      message: `request failed Authorization: Bearer ${bearer} apiKey="${quotedApiKey}" token: '${quotedToken}'`,
      retryable: false,
      incomplete: true,
    };
    const response = await call(
      item,
      "POST",
      `/api/conversations/${item.conversationId}/messages`,
      { text: "error" },
    );
    assert.equal(response.status, 200);
    const event = parsedSse(response.raw);
    assert.deepEqual(event, [
      {
        type: "error",
        code: "authentication_error",
        message: "request failed Authorization: Bearer [redacted] apiKey=[redacted] token: [redacted]",
        retryable: false,
        incomplete: true,
      },
    ]);
    assert.equal(response.raw.includes(bearer), false);
    assert.equal(response.raw.includes(quotedApiKey), false);
    assert.equal(response.raw.includes(quotedToken), false);
    assertNoCors(response.headers);
  } finally {
    await stop(item);
  }
});

test("HTTP route errors are uniform and duplicate candidates stay in safe details", async () => {
  const item = fixture();
  await start(item);
  try {
    const invalid = await call(item, "POST", "/api/books", {
      title: "Only title",
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body, {
      error: {
        code: "invalid_input",
        message: "author is required",
        retryable: false,
      },
    });
    assertNoCors(invalid.headers);
    assert.equal(
      (invalid.body as { error: { code: string; retryable: boolean } }).error
        .retryable,
      false,
    );

    const missing = await call(item, "GET", "/api/books/999999");
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, {
      error: {
        code: "not_found",
        message: "Book 999999 was not found",
        retryable: false,
      },
    });
    assertNoCors(missing.headers);

    item.library.createOrFindBook({
      title: "Same",
      author: "Author",
      identifiers: [
        { scheme: "isbn13", value: "9780306406157", source: "test" },
      ],
    });
    item.db
      .prepare(
        "INSERT INTO books (title, author, normalized_title, normalized_author) VALUES (?, ?, ?, ?)",
      )
      .run("same", "author", "same", "author");
    const ambiguous = await call(item, "POST", "/api/books", {
      title: "Same",
      author: "Author",
    });
    assert.equal(ambiguous.status, 409);
    assert.equal(
      (
        ambiguous.body as {
          error: { code: string; details: { candidates: unknown[] } };
        }
      ).error.code,
      "ambiguous_book",
    );
    const ambiguousError = ambiguous.body as {
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details: { candidates: unknown[] };
      };
    };
    assert.equal(ambiguousError.error.code, "ambiguous_book");
    assert.equal(ambiguousError.error.message, "More than one book matches the supplied identity");
    assert.equal(ambiguousError.error.retryable, false);
    assert.equal(Array.isArray(ambiguousError.error.details.candidates), true);
    assertNoCors(ambiguous.headers);
  } finally {
    await stop(item);
  }
});

test("HTTP state changes require exact Host, Origin, CSRF, and JSON content type without CORS", async () => {
  const item = fixture();
  await start(item);
  try {
    for (const options of [
      { csrf: "wrong" },
      { host: "localhost:" + item.port },
      { origin: "http://localhost:" + item.port },
      { contentType: "text/plain" },
    ]) {
      const response = await call(
        item,
        "POST",
        "/api/conversations",
        { name: "Rejected" },
        options,
      );
      assert.equal(response.status, 403);
    }
    const response = await call(item, "POST", "/api/conversations", {
      name: "Accepted",
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    const oversized = await call(item, "POST", "/api/conversations", {
      name: "x".repeat(1_048_576),
    });
    assert.equal(oversized.status, 413);
    assert.equal(
      (oversized.body as { error: { code: string; retryable: boolean } }).error
        .code,
      "payload_too_large",
    );
    const csrfA = item.api.csrfToken;
    const other = fixture();
    assert.notEqual(csrfA, other.api.csrfToken);
    other.registry.close();
    closeDatabase(other.db);
    rmSync(other.root, { recursive: true, force: true });
  } finally {
    await stop(item);
  }
});

test("HTTP canonicalizes default HTTP ports for Host and Origin checks", async () => {
  const item = fixture({ host: "127.0.0.1:80" });
  await start(item);
  try {
    const response = await call(
      item,
      "POST",
      "/api/conversations",
      { name: "Canonical port" },
      { host: "127.0.0.1", origin: "http://127.0.0.1" },
    );
    assert.equal(response.status, 201);
  } finally {
    await stop(item);
  }
});

test("HTTP aborts the submitted signal when the SSE client disconnects", async () => {
  const item = fixture();
  await start(item);
  let releaseRequest: (() => void) | undefined;
  try {
    item.turns.hold = true;
    let closeRequest!: () => void;
    const closed = new Promise<void>((resolve) => {
      closeRequest = resolve;
    });
    let request: ReturnType<typeof httpRequest>;
    request = httpRequest(
      {
        host: "127.0.0.1",
        port: item.port,
        method: "POST",
        path: `/api/conversations/${item.conversationId}/messages`,
        headers: {
          host: item.host,
          origin: `http://${item.host}`,
          "x-csrf-token": item.api.csrfToken,
          "content-type": "application/json",
        },
      },
      (response) => {
        response.once("data", () => request.destroy());
        response.once("close", closeRequest);
        response.resume();
      },
    );
    request.once("error", closeRequest);
    request.end(JSON.stringify({ text: "disconnect" }));
    await waitUntil(() => item.turns.signals.length > 0);
    const signal = item.turns.signals.at(-1);
    assert.ok(signal);
    await waitUntil(() => signal.aborted);
    assert.equal(signal.aborted, true);
    releaseRequest = item.turns.release;
    releaseRequest?.();
    await closed;
  } finally {
    item.turns.release?.();
    item.turns.hold = false;
    await stop(item);
  }
});

test("HTTP awaits SSE drain before the turn can continue", async () => {
  const item = fixture();
  await start(item);
  const originalWrite = ServerResponse.prototype.write;
  let forcedResponse: ServerResponse | undefined;
  let forceBackpressure = true;
  let pending: Promise<Awaited<ReturnType<typeof call>>> | undefined;
  // SAFETY: this test replaces the concrete Node response writer only for one request.
  ServerResponse.prototype.write = function (this: ServerResponse, chunk: string | Uint8Array): boolean {
    const result = originalWrite.call(this, chunk, "utf8", undefined);
    if (forceBackpressure) {
      forceBackpressure = false;
      forcedResponse = this;
      return false;
    }
    return result;
  } as typeof originalWrite;
  try {
    pending = call(item, "POST", `/api/conversations/${item.conversationId}/messages`, { text: "drain" });
    await waitUntil(() => forcedResponse !== undefined);
    assert.equal(item.turns.firstEventReturned, false);
    const responseForDrain = forcedResponse;
    assert.ok(responseForDrain);
    responseForDrain.emit("drain");
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(item.turns.firstEventReturned, true);
    assert.deepEqual(parsedSse(response.raw).at(-1), { type: "complete", incomplete: false });
  } finally {
    forcedResponse?.emit("drain");
    await pending?.catch(() => undefined);
    ServerResponse.prototype.write = originalWrite;
    await stop(item);
  }
});

test("HTTP pagination defaults and caps are exposed in list envelopes", async () => {
  const item = fixture();
  await start(item);
  try {
    for (let index = 0; index < 3; index += 1)
      item.library.createOrFindBook({
        title: `Book ${index}`,
        author: "Author",
      });
    const defaultPage = await call(item, "GET", "/api/books");
    assert.deepEqual(
      (defaultPage.body as { limit: number; offset: number }).limit,
      20,
    );
    assert.deepEqual(
      (defaultPage.body as { limit: number; offset: number }).offset,
      0,
    );
    const capped = await call(item, "GET", "/api/books?limit=100&offset=1");
    assert.equal((capped.body as { limit: number }).limit, 100);
    assert.equal((await call(item, "GET", "/api/books?limit=101")).status, 400);
  } finally {
    await stop(item);
  }
});
