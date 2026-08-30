import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Value } from 'typebox/value';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { closeDatabase, openDatabase, type Database } from '../src/db.js';
import { ConversationRegistry } from '../src/conversations.js';
import { LibraryRepository } from '../src/library.js';
import { createCitationCapture, type CitationCapture } from '../src/search-guard.js';
import { deterministicProposalId } from '../src/proposals.js';
import { createBookExplorerTools, type ToolEnvelope, type BookExplorerToolContext } from '../src/tools.js';

interface Fixture {
  root: string;
  db: Database;
  library: LibraryRepository;
  registry: ConversationRegistry;
  conversationId: number;
  capture: CitationCapture;
  tools: ToolDefinition[];
}

function fixture(requestId = 'request-tools-1'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'book-explorer-tools-'));
  const db = openDatabase(join(root, 'library.sqlite'));
  const library = new LibraryRepository(db);
  const registry = new ConversationRegistry(db, { cwd: root, sessionDir: join(root, 'sessions') });
  const conversationId = registry.create('Tool conversation').id;
  const capture = createCitationCapture();
  const context: BookExplorerToolContext = {
    library,
    proposalRegistry: registry,
    conversationId,
    requestId,
    citationCapture: capture,
  };
  return { root, db, library, registry, conversationId, capture, tools: createBookExplorerTools(context) };
}

function dispose(item: Fixture): void {
  item.registry.close();
  closeDatabase(item.db);
  rmSync(item.root, { recursive: true, force: true });
}

function tool(item: Fixture, name: string): ToolDefinition {
  const found = item.tools.find((candidate) => candidate.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

async function execute(item: Fixture, name: string, input: unknown): Promise<ToolEnvelope<unknown>> {
  const result = await tool(item, name).execute('call-1', input as never, undefined, undefined, {} as never);
  return result.details as ToolEnvelope<unknown>;
}

function schemaAccepts(item: Fixture, name: string, input: unknown): boolean {
  return Value.Check(tool(item, name).parameters, input);
}

function assertFailure(value: ToolEnvelope<unknown>, code: string): void {
  assert.equal(value.ok, false);
  if (value.ok) return;
  assert.equal(value.error.code, code);
  assert.equal(typeof value.error.message, 'string');
  assert.equal(typeof value.error.retryable, 'boolean');
}

test('tool schema exposes exactly six strict definitions and accepts valid literal bounds', () => {
  const item = fixture();
  try {
    assert.deepEqual(item.tools.map((candidate) => candidate.name), [
      'search_library',
      'get_book',
      'upsert_book',
      'upsert_series',
      'record_recommendation',
      'propose_change',
    ]);
    const isbn = '9780306406157';
    const validInputs: Record<string, unknown> = {
      search_library: {
        query: 'x'.repeat(200),
        status: 'not_interested',
        rating: 5,
        seriesId: 1,
        limit: 50,
        offset: 0,
      },
      get_book: { bookId: 1 },
      upsert_book: {
        title: 'T',
        author: 'A',
        publicationYear: 0,
        coverUrl: 'HTTPS://example.test/cover.jpg',
        seriesId: 1,
        seriesPosition: 'x'.repeat(40),
        identifiers: [{ scheme: 'isbn13', value: isbn, source: 'catalog' }],
      },
      upsert_series: { name: 'S', note: 'x'.repeat(2000) },
      record_recommendation: {
        bookId: 1,
        rationale: 'R',
        cautions: 'x'.repeat(2000),
        citationTokens: ['citation_1'],
      },
      propose_change: {
        bookId: 1,
        kind: 'rating',
        value: 1,
        semanticSlot: 'x'.repeat(100),
        explanation: 'x'.repeat(2000),
      },
    };
    for (const [name, input] of Object.entries(validInputs)) assert.equal(schemaAccepts(item, name, input), true, name);
  } finally {
    dispose(item);
  }
});

test('tool schemas reject unknown properties, overlong values, and invalid bounds or enums', () => {
  const item = fixture();
  try {
    const invalidInputs: Array<[string, unknown]> = [
      ['search_library', { query: 'x'.repeat(201) }],
      ['search_library', { status: 'finished' }],
      ['search_library', { rating: 0 }],
      ['search_library', { limit: 51 }],
      ['search_library', { offset: -1 }],
      ['search_library', { unexpected: true }],
      ['get_book', { bookId: 0 }],
      ['get_book', { bookId: 1, status: 'read' }],
      ['upsert_book', { title: '', author: 'A' }],
      ['upsert_book', { title: 'x'.repeat(301), author: 'A' }],
      ['upsert_book', { title: 'T', author: 'A', publicationYear: 10000 }],
      ['upsert_book', { title: 'T', author: 'A', coverUrl: 'javascript:alert(1)' }],
      ['upsert_book', { title: 'T', author: 'A', identifiers: new Array(21).fill({ scheme: 'isbn13', value: '9780306406157', source: 's' }) }],
      ['upsert_book', { title: 'T', author: 'A', status: 'read' }],
      ['upsert_book', { title: 'T', author: 'A', rating: 5 }],
      ['upsert_book', { title: 'T', author: 'A', note: 'opinion' }],
      ['upsert_series', { name: 'S', note: 'x'.repeat(2001) }],
      ['upsert_series', { name: 'S', extra: true }],
      ['record_recommendation', { bookId: 0, rationale: 'R' }],
      ['record_recommendation', { bookId: 1, rationale: '' }],
      ['record_recommendation', { bookId: 1, rationale: 'x'.repeat(4001) }],
      ['record_recommendation', { bookId: 1, rationale: 'R', citationTokens: new Array(21).fill('citation_1') }],
      ['record_recommendation', { bookId: 1, rationale: 'R', requestId: 'attacker-request' }],
      ['propose_change', { bookId: 1, kind: 'status', value: 'finished', semanticSlot: 's', explanation: 'e' }],
      ['propose_change', { bookId: 1, kind: 'rating', value: 6, semanticSlot: 's', explanation: 'e' }],
      ['propose_change', { bookId: 1, kind: 'note', value: 'x'.repeat(4001), semanticSlot: 's', explanation: 'e' }],
      ['propose_change', { bookId: 1, kind: 'status', value: 4, semanticSlot: 's', explanation: 'e' }],
      ['propose_change', { bookId: 1, kind: 'rating', value: 'read', semanticSlot: 's', explanation: 'e' }],
      ['propose_change', { bookId: 1, kind: 'note', value: 'n', semanticSlot: 's', explanation: 'x'.repeat(2001) }],
      ['propose_change', { bookId: 1, kind: 'status', value: 'read', semanticSlot: 's', explanation: 'e', requestId: 'attacker-request' }],
    ];
    for (const [name, input] of invalidInputs) assert.equal(schemaAccepts(item, name, input), false, `${name}: ${JSON.stringify(input).slice(0, 100)}`);
  } finally {
    dispose(item);
  }
});

test('tool handlers validate before database actions and reject direct user-owned fields', async () => {
  const item = fixture();
  try {
    const before = item.library.searchBooks({}).total;
    for (const [name, input] of [
      ['upsert_book', { title: 'Book', author: 'Author', status: 'read' }],
      ['upsert_book', { title: 'Book', author: 'Author', rating: 5 }],
      ['upsert_book', { title: 'Book', author: 'Author', note: 'Opinion' }],
      ['record_recommendation', { bookId: 1, rationale: 'R', requestId: 'forged' }],
      ['propose_change', { bookId: 1, kind: 'status', value: 'read', semanticSlot: 's', explanation: 'e', requestId: 'forged' }],
    ] as Array<[string, unknown]>) {
      const result = await execute(item, name, input);
      assertFailure(result, 'invalid_input');
    }
    assert.equal(item.library.searchBooks({}).total, before);
  } finally {
    dispose(item);
  }
});

test('tool effects use the real repository and return the standard success envelope', async () => {
  const item = fixture();
  try {
    const series = await execute(item, 'upsert_series', { name: ' The Saga ' });
    assert.equal(series.ok, true);
    const seriesData = series.ok ? series.data as { id: number } : undefined;
    assert.ok(seriesData?.id);

    const book = await execute(item, 'upsert_book', {
      title: 'The Dispossessed',
      author: 'Ursula K. Le Guin',
      seriesId: seriesData?.id,
      publicationYear: 1974,
    });
    assert.equal(book.ok, true);
    const bookData = book.ok ? book.data as { id: number; status: string } : undefined;
    assert.ok(bookData?.id);
    assert.equal(bookData?.status, 'recommended');

    const search = await execute(item, 'search_library', { query: 'dispossessed', limit: 1, offset: 0 });
    assert.equal(search.ok, true);
    assert.deepEqual(search.ok ? (search.data as { items: unknown[]; total: number; limit: number; offset: number }) : undefined, {
      items: [item.library.searchBooks({ query: 'dispossessed', limit: 1, offset: 0 }).items[0]],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const fetched = await execute(item, 'get_book', { bookId: bookData?.id });
    assert.equal(fetched.ok, true);
    assert.equal(fetched.ok ? (fetched.data as { id: number }).id : undefined, bookData?.id);

    const missing = await execute(item, 'get_book', { bookId: 999 });
    assertFailure(missing, 'not_found');
  } finally {
    dispose(item);
  }
});

test('record_recommendation captures only request-local citation tokens and is idempotent', async () => {
  const item = fixture('request-owned');
  try {
    const book = item.library.createOrFindBook({ title: 'Book', author: 'Author' });
    item.capture.set('citation_valid', {
      url: 'https://example.test/source?z=2&a=1',
      title: 'Source',
      snippet: 'Evidence',
      provider: 'openai',
    });
    const first = await execute(item, 'record_recommendation', {
      bookId: book.id,
      rationale: 'A strong fit.',
      citationTokens: ['citation_valid'],
    });
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal((first.data as { requestId: string }).requestId, 'request-owned');
      assert.equal((first.data as { sourceConversationId: number }).sourceConversationId, item.conversationId);
      assert.equal((first.data as { citations: Array<{ url: string; provider: string }> }).citations[0]?.url, 'https://example.test/source?a=1&z=2');
    }
    const repeated = await execute(item, 'record_recommendation', {
      bookId: book.id,
      rationale: 'Changed prose must not duplicate it.',
    });
    assert.equal(repeated.ok, true);
    assert.equal(item.library.getBook(book.id)?.recommendations.length, 1);

    const unknown = await execute(item, 'record_recommendation', {
      bookId: book.id,
      rationale: 'Do not save this.',
      citationTokens: ['citation_unknown'],
    });
    assertFailure(unknown, 'invalid_input');
    assert.equal(item.library.getBook(book.id)?.recommendations.length, 1);
  } finally {
    dispose(item);
  }
});

test('propose_change uses closure-owned request and conversation identity without approved state mutation', async () => {
  const item = fixture('request-proposal');
  try {
    const book = item.library.createOrFindBook({ title: 'Book', author: 'Author' });
    const result = await execute(item, 'propose_change', {
      bookId: book.id,
      kind: 'status',
      value: 'read',
      semanticSlot: 'reading-status',
      explanation: 'The user said they finished it.',
    });
    assert.equal(result.ok, true);
    const proposalData = result.ok ? result.data as { proposalId: string; state: string } : undefined;
    assert.deepEqual(proposalData, {
      proposalId: deterministicProposalId('request-proposal', 'status', book.id, 'reading-status'),
      state: 'pending',
    });
    assert.equal(item.library.getBook(book.id)?.status, 'recommended');
    const session = join(item.root, 'sessions');
    const files = readdirSync(session).filter((name) => name.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const content = readFileSync(join(session, files[0]!), 'utf8');
    assert.match(content, /"requestId":"request-proposal"/);
    assert.doesNotMatch(content, /attacker-request/);
  } finally {
    dispose(item);
  }
});

test('tool error envelopes do not create records for invalid identifiers or URLs', async () => {
  const item = fixture();
  try {
    const before = item.library.searchBooks({}).total;
    assertFailure(await execute(item, 'upsert_book', {
      title: 'Book',
      author: 'Author',
      coverUrl: 'https://',
    }), 'invalid_input');
    assertFailure(await execute(item, 'upsert_book', {
      title: 'Book',
      author: 'Author',
      identifiers: [{ scheme: 'isbn13', value: '9780306406158', source: 'catalog' }],
    }), 'invalid_input');
    assert.equal(item.library.searchBooks({}).total, before);
    assert.equal(existsSync(join(item.root, 'sessions')), true);
  } finally {
    dispose(item);
  }
});
