import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDatabase, openDatabase, type Database } from '../src/db.js';
import { ConversationRegistry } from '../src/conversations.js';
import { createProposal } from '../src/proposals.js';
import { LibraryRepository } from '../src/library.js';
import { createHttpServer, type HttpServer } from '../src/http.js';
import type { BrowserStreamEvent } from '../src/turns.js';

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
}

class FakeTurns {
  activeRequestId: string | undefined;
  submitted: Array<{ conversationId: number; text: string; retryRequestId?: string }> = [];
  cancelled: string[] = [];
  emit: ((event: BrowserStreamEvent) => Promise<void>) | undefined;
  nextRequestId = 'request-http';
  busy = false;
  burst = false;

  async submit(
    input: { conversationId: number; text: string; retryRequestId?: string },
    emit: (event: BrowserStreamEvent) => Promise<void>,
  ): Promise<void> {
    if (this.busy) {
      await emit({
        type: 'error',
        code: 'global_busy',
        message: 'Another model turn is active',
        retryable: true,
      });
      return;
    }
    this.submitted.push(input);
    this.emit = emit;
    this.activeRequestId = this.nextRequestId;
    if (this.burst) {
      for (let index = 0; index < 40; index += 1) {
        await emit({ type: 'text_delta', delta: 'x'.repeat(20_000) });
      }
    } else {
      await emit({ type: 'text_delta', delta: 'hello' });
    }
    await emit({ type: 'complete', incomplete: false });
    this.activeRequestId = undefined;
  }

  async cancel(requestId: string): Promise<boolean> {
    if (this.activeRequestId !== requestId) return false;
    this.cancelled.push(requestId);
    this.activeRequestId = undefined;
    return true;
  }
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'book-explorer-http-'));
  const db = openDatabase(join(root, 'library.sqlite'));
  const registry = new ConversationRegistry(db, {
    cwd: root,
    sessionDir: join(root, 'sessions'),
  });
  const library = new LibraryRepository(db);
  const turns = new FakeTurns();
  const api = createHttpServer({
    library,
    registry,
    openLibrary: {
      lookup: async () => ({
        metadata: {
          workId: 'OL123W',
          title: 'Lookup',
          author: 'Author',
          publicationYear: 2026,
          coverUrl: null,
          seriesHints: [],
          identifiers: [{ scheme: 'openlibrary_work', value: 'OL123W', source: 'openlibrary' }],
        },
      }),
    },
    turns,
  });
  const conversationId = registry.create('HTTP').id;
  return { root, db, library, registry, api, port: 0, host: '', conversationId, turns };
}

async function start(item: Fixture): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    item.api.once('error', reject);
    item.api.listen(0, '127.0.0.1', () => {
      item.api.off('error', reject);
      const address = item.api.address();
      assert.ok(address && typeof address === 'object');
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
  options: { secure?: boolean; contentType?: string; host?: string; origin?: string; csrf?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown; raw: string }> {
  const secure = options.secure !== false;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (payload !== undefined) {
    headers['content-length'] = Buffer.byteLength(payload).toString();
    headers['content-type'] = options.contentType ?? 'application/json';
  }
  if (secure) {
    headers.host = options.host ?? item.host;
    headers.origin = options.origin ?? `http://${item.host}`;
    headers['x-csrf-token'] = options.csrf ?? item.api.csrfToken;
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: item.port,
      method,
      path,
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = raw;
        try {
          parsed = raw ? JSON.parse(raw) : undefined;
        } catch {
          // SSE and malformed bodies stay available as raw text.
        }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: parsed, raw });
      });
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

test('HTTP route contract covers conversations, books, series, notes, and recommendations', async () => {
  const item = fixture();
  await start(item);
  try {
    const createdSeries = await call(item, 'POST', '/api/series', { name: 'Saga', note: 'Note' });
    assert.equal(createdSeries.status, 201);
    const seriesId = (createdSeries.body as { id: number }).id;
    assert.equal((await call(item, 'GET', '/api/series?limit=20&offset=0')).status, 200);
    assert.equal((await call(item, 'PATCH', `/api/series/${seriesId}`, { name: 'New Saga' })).status, 200);

    const createdBook = await call(item, 'POST', '/api/books', {
      title: 'Book',
      author: 'Author',
      seriesId,
      identifiers: [{ scheme: 'openlibrary_work', value: 'OL123W', source: 'test' }],
    });
    assert.equal(createdBook.status, 201);
    const bookId = (createdBook.body as { id: number }).id;
    assert.equal((await call(item, 'GET', '/api/books')).status, 200);
    assert.equal((await call(item, 'GET', `/api/books/${bookId}`)).status, 200);
    assert.equal((await call(item, 'PATCH', `/api/books/${bookId}`, { status: 'read', rating: 5 })).status, 200);

    const note = item.library.addNote(bookId, 'Old note');
    assert.equal((await call(item, 'PATCH', `/api/books/${bookId}/notes/${note.id}`, { note: 'New note' })).status, 200);
    assert.equal((await call(item, 'DELETE', `/api/books/${bookId}/notes/${note.id}`)).status, 204);
    item.library.recordRecommendation('request-http', bookId, 'Rationale');
    assert.equal((await call(item, 'GET', `/api/books/${bookId}/recommendations`)).status, 200);

    const createdConversation = await call(item, 'POST', '/api/conversations', { name: 'Second' });
    assert.equal(createdConversation.status, 201);
    const conversationId = (createdConversation.body as { id: number }).id;
    assert.equal((await call(item, 'GET', '/api/conversations')).status, 200);
    const conversation = await call(item, 'GET', `/api/conversations/${conversationId}`);
    assert.equal(conversation.status, 200);
    assert.ok(Array.isArray((conversation.body as { transcript: unknown[] }).transcript));
    assert.equal((await call(item, 'PATCH', `/api/conversations/${conversationId}`, { name: 'Renamed' })).status, 200);
    assert.equal((await call(item, 'POST', `/api/conversations/${conversationId}/archive`, { archived: true })).status, 200);
    assert.equal((await call(item, 'DELETE', `/api/conversations/${conversationId}`)).status, 204);
    assert.equal((await call(item, 'DELETE', `/api/series/${seriesId}`)).status, 204);
    assert.equal((await call(item, 'DELETE', `/api/books/${bookId}`)).status, 204);
  } finally {
    await stop(item);
  }
});

test('HTTP proposal, Open Library, and message routes use service APIs', async () => {
  const item = fixture();
  await start(item);
  try {
    const book = item.library.createOrFindBook({ title: 'Book', author: 'Author' });
    const proposal = await createProposal(item.registry, item.conversationId, {
      requestId: 'proposal-request',
      bookId: book.id,
      kind: 'status',
      value: 'read',
      semanticSlot: 'status',
      explanation: 'Finished',
    });
    const pending = await call(item, 'GET', `/api/conversations/${item.conversationId}/proposals`);
    assert.equal(pending.status, 200);
    assert.equal((pending.body as Array<{ proposalId: string }>)[0]?.proposalId, proposal.proposalId);
    assert.equal((await call(item, 'POST', `/api/conversations/${item.conversationId}/proposals/${proposal.proposalId}/accept`, { value: 'read' })).status, 200);

    const lookup = await call(item, 'POST', '/api/open-library/lookup', { workId: 'OL123W' });
    assert.equal(lookup.status, 200);
    assert.equal((lookup.body as { metadata: { workId: string } }).metadata.workId, 'OL123W');

    item.turns.activeRequestId = 'active-request';
    const cancellation = await call(item, 'POST', '/api/requests/active-request/cancel', {});
    assert.equal(cancellation.status, 202);
    assert.deepEqual((cancellation.body as { requestId: string; cancelled: boolean }), {
      requestId: 'active-request',
      cancelled: true,
    });
    assert.deepEqual(item.turns.cancelled, ['active-request']);

    const stream = await call(item, 'POST', `/api/conversations/${item.conversationId}/messages`, { text: 'Hello' });
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers['content-type']), /^text\/event-stream/);
    assert.match(stream.raw, /text_delta/);
    assert.match(stream.raw, /complete/);
    assert.equal(item.turns.submitted[0]?.conversationId, item.conversationId);
    assert.equal(item.turns.submitted[0]?.text, 'Hello');

    item.turns.busy = true;
    const busyStream = await call(item, 'POST', `/api/conversations/${item.conversationId}/messages`, { text: 'Busy' });
    assert.equal(busyStream.status, 200);
    assert.match(busyStream.raw, /global_busy/);
    item.turns.busy = false;
    item.turns.burst = true;
    const burstStream = await call(item, 'POST', `/api/conversations/${item.conversationId}/messages`, { text: 'Backpressure' });
    assert.equal(burstStream.status, 200);
    assert.match(burstStream.raw, /complete/);

    const rejectedProposal = await createProposal(item.registry, item.conversationId, {
      requestId: 'proposal-request-2',
      bookId: book.id,
      kind: 'rating',
      value: 5,
      semanticSlot: 'rating',
      explanation: 'Favorite',
    });
    assert.equal((await call(item, 'POST', `/api/conversations/${item.conversationId}/proposals/${rejectedProposal.proposalId}/reject`, {})).status, 200);
  } finally {
    await stop(item);
  }
});

test('HTTP route errors are uniform and duplicate candidates stay in safe details', async () => {
  const item = fixture();
  await start(item);
  try {
    const invalid = await call(item, 'POST', '/api/books', { title: 'Only title' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(Object.keys(invalid.body as object), ['error']);
    assert.equal((invalid.body as { error: { code: string; retryable: boolean } }).error.retryable, false);

    const missing = await call(item, 'GET', '/api/books/999999');
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { error: { code: string } }).error.code, 'not_found');

    item.library.createOrFindBook({ title: 'Same', author: 'Author', identifiers: [{ scheme: 'isbn13', value: '9780306406157', source: 'test' }] });
    item.db.prepare('INSERT INTO books (title, author, normalized_title, normalized_author) VALUES (?, ?, ?, ?)').run('same', 'author', 'same', 'author');
    const ambiguous = await call(item, 'POST', '/api/books', { title: 'Same', author: 'Author' });
    assert.equal(ambiguous.status, 409);
    assert.equal((ambiguous.body as { error: { code: string; details: { candidates: unknown[] } } }).error.code, 'ambiguous_book');
    assert.equal(Array.isArray((ambiguous.body as { error: { details: { candidates: unknown[] } } }).error.details.candidates), true);
  } finally {
    await stop(item);
  }
});

test('HTTP state changes require exact Host, Origin, CSRF, and JSON content type without CORS', async () => {
  const item = fixture();
  await start(item);
  try {
    for (const options of [
      { csrf: 'wrong' },
      { host: 'localhost:' + item.port },
      { origin: 'http://localhost:' + item.port },
      { contentType: 'text/plain' },
    ]) {
      const response = await call(item, 'POST', '/api/conversations', { name: 'Rejected' }, options);
      assert.equal(response.status, 403);
    }
    const response = await call(item, 'POST', '/api/conversations', { name: 'Accepted' });
    assert.equal(response.status, 201);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    const oversized = await call(item, 'POST', '/api/conversations', { name: 'x'.repeat(1_048_576) });
    assert.equal(oversized.status, 413);
    assert.equal((oversized.body as { error: { code: string; retryable: boolean } }).error.code, 'payload_too_large');
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

test('HTTP pagination defaults and caps are exposed in list envelopes', async () => {
  const item = fixture();
  await start(item);
  try {
    for (let index = 0; index < 3; index += 1) item.library.createOrFindBook({ title: `Book ${index}`, author: 'Author' });
    const defaultPage = await call(item, 'GET', '/api/books');
    assert.deepEqual((defaultPage.body as { limit: number; offset: number }).limit, 20);
    assert.deepEqual((defaultPage.body as { limit: number; offset: number }).offset, 0);
    const capped = await call(item, 'GET', '/api/books?limit=100&offset=1');
    assert.equal((capped.body as { limit: number }).limit, 100);
    assert.equal((await call(item, 'GET', '/api/books?limit=101')).status, 400);
  } finally {
    await stop(item);
  }
});
