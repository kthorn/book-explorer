import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDatabase, openDatabase, type Database } from '../src/db.js';
import {
  OpenLibraryClient,
  type OpenLibraryMetadata,
  type OpenLibraryResult,
} from '../src/open-library.js';

interface ServerFixture {
  baseUrl: string;
  requests: string[];
  userAgents: string[];
  maxInFlight: number;
  close: () => Promise<void>;
  setHandler: (handler: (request: IncomingMessage, response: ServerResponse) => void) => void;
}

async function serverFixture(): Promise<ServerFixture> {
  const requests: string[] = [];
  const userAgents: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let handler: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'unconfigured test request' }));
  };
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    userAgents.push(String(request.headers['user-agent'] ?? ''));
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    response.once('finish', () => {
      inFlight -= 1;
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    userAgents,
    get maxInFlight() {
      return maxInFlight;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    setHandler: (next) => {
      handler = next;
    },
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function metadata(overrides: Partial<OpenLibraryMetadata> = {}): OpenLibraryMetadata {
  return {
    workId: 'OL123W',
    title: 'The Dispossessed',
    author: 'Ursula K. Le Guin',
    publicationYear: 1974,
    coverUrl: 'https://covers.openlibrary.org/b/id/123-L.jpg',
    seriesHints: ['Hainish Cycle'],
    identifiers: [
      { scheme: 'openlibrary_work', value: 'OL123W', source: 'openlibrary' },
      { scheme: 'isbn13', value: '9780306406157', source: 'openlibrary' },
    ],
    ...overrides,
  };
}

function withDatabase(run: (db: Database) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'book-explorer-open-library-'));
  const db = openDatabase(join(directory, 'library.sqlite'));
  return Promise.resolve()
    .then(() => run(db))
    .finally(() => {
      closeDatabase(db);
      rmSync(directory, { recursive: true, force: true });
    });
}

function workPayload(value: Partial<{
  title: string;
  author: string;
  year: number;
  cover: number;
  series: string[];
}> = {}): Record<string, unknown> {
  return {
    title: value.title ?? 'The Dispossessed',
    authors: [{ name: value.author ?? 'Ursula K. Le Guin' }],
    first_publish_year: value.year ?? 1974,
    covers: [value.cover ?? 123],
    series: value.series ?? ['Hainish Cycle'],
    isbn: ['9780306406157'],
  };
}

test('Open Library sends an identifying user agent and maps work metadata', async () => {
  const fixture = await serverFixture();
  try {
    fixture.setHandler((_request, response) => json(response, 200, workPayload()));
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl });
      const result = await client.lookup({ workId: '/works/ol123w' });
      assert.equal(result.metadata?.workId, 'OL123W');
      assert.equal(result.metadata?.title, 'The Dispossessed');
      assert.equal(result.metadata?.author, 'Ursula K. Le Guin');
      assert.equal(result.metadata?.publicationYear, 1974);
      assert.equal(result.metadata?.coverUrl, 'https://covers.openlibrary.org/b/id/123-L.jpg');
      assert.deepEqual(result.metadata?.seriesHints, ['Hainish Cycle']);
      assert.equal(fixture.requests[0], '/works/OL123W.json');
      assert.match(fixture.userAgents[0] ?? '', /book-explorer/i);
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library preserves documented author references when names are unavailable', async () => {
  const fixture = await serverFixture();
  try {
    fixture.setHandler((_request, response) => json(response, 200, {
      title: 'Fantastic Mr Fox',
      key: '/works/OL45804W',
      authors: [
        { author: { key: '/authors/OL34184A' } },
        { author: { key: '/authors/OL3944327A' } },
      ],
      first_publish_date: '1970',
    }));
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl });
      const result = await client.lookup({ workId: 'OL45804W' });
      assert.equal(result.metadata?.author, '/authors/OL34184A, /authors/OL3944327A');
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library treats unparseable optional publication dates as null', async () => {
  const fixture = await serverFixture();
  try {
    fixture.setHandler((_request, response) => json(response, 200, {
      title: 'Undated work',
      authors: [{ name: 'An Author' }],
      first_publish_date: 'publication date unknown',
    }));
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl });
      const result = await client.lookup({ workId: 'OL124W' });
      assert.equal(result.metadata?.publicationYear, null);
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library rejects non-string publication dates and invalid year numbers', async () => {
  const fixture = await serverFixture();
  try {
    const responses = new Map<string, Record<string, unknown>>([
      ['OL125W', { first_publish_date: { year: 1988 } }],
      ['OL126W', { first_publish_date: 1988 }],
      ['OL127W', { first_publish_year: 10_000 }],
    ]);
    fixture.setHandler((request, response) => {
      const path = new URL(request.url ?? '/', fixture.baseUrl).pathname;
      const workId = path.match(/^\/works\/(OL\d+W)\.json$/i)?.[1]?.toUpperCase();
      json(response, 200, {
        title: 'Invalid date payload',
        authors: [{ name: 'An Author' }],
        isbn: ['9780306406157'],
        ...(workId ? responses.get(workId) : {}),
      });
    });
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl });
      for (const workId of responses.keys()) {
        await assert.rejects(
          () => client.lookup({ workId }),
          (error: unknown) =>
            error instanceof Error &&
            'code' in error &&
            (error as { code: string }).code === 'malformed_response',
        );
      }
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library caps parsed identifier aliases at the v1 limit', async () => {
  const fixture = await serverFixture();
  try {
    fixture.setHandler((_request, response) => json(response, 200, {
      title: 'Many identifiers',
      authors: [{ name: 'An Author' }],
      identifiers: Array.from({ length: 30 }, (_value, index) => ({
        scheme: 'openlibrary_work',
        value: `OL${index + 1}W`,
        source: 'catalog',
      })),
    }));
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl });
      const result = await client.lookup({ workId: 'OL123W' });
      assert.equal(result.metadata?.identifiers.length, 20);
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library uses ISBN and title-author search endpoints', async () => {
  const fixture = await serverFixture();
  try {
    fixture.setHandler((request, response) => {
      const path = new URL(request.url ?? '/', fixture.baseUrl).pathname;
      if (path === '/isbn/9780306406157.json') {
        json(response, 200, {
          title: 'The Dispossessed',
          authors: [{ name: 'Ursula K. Le Guin' }],
          works: [{ key: '/works/OL123W' }],
          publish_date: 'October 1, 1988',
          covers: [123],
          isbn_13: ['9780306406157'],
        });
        return;
      }
      if (path === '/search.json') {
        json(response, 200, {
          numFound: 1,
          docs: [{
            key: '/works/OL123W',
            title: 'A Search',
            author_name: ['Search Author'],
            first_publish_year: 1974,
            cover_i: 123,
            isbn: ['9780306406157'],
          }],
        });
        return;
      }
      json(response, 404, {});
    });
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl });
      const isbnResult = await client.lookup({ isbn: '978-0-306-40615-7' });
      assert.equal(isbnResult.metadata?.workId, 'OL123W');
      assert.equal(isbnResult.metadata?.publicationYear, 1988);
      assert.equal(isbnResult.metadata?.identifiers.some((item: OpenLibraryMetadata['identifiers'][number]) => item.value === '9780306406157'), true);
      const searchResult = await client.lookup({ title: 'A Search', author: 'Search Author' });
      assert.equal(searchResult.candidates?.length, 1);
      assert.equal(searchResult.candidates?.[0]?.workId, 'OL123W');
      const searchUrl = new URL(fixture.requests[1] ?? '', fixture.baseUrl);
      assert.equal(searchUrl.pathname, '/search.json');
      assert.equal(searchUrl.searchParams.get('title'), 'A Search');
      assert.equal(searchUrl.searchParams.get('author'), 'Search Author');
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library requests are single-flight and FIFO across lookups', async () => {
  const fixture = await serverFixture();
  try {
    const releaseFirst = Promise.withResolvers<void>();
    fixture.setHandler((request, response) => {
      const path = new URL(request.url ?? '/', fixture.baseUrl).pathname;
      if (path === '/works/OL1W.json') {
        void releaseFirst.promise.then(() => json(response, 200, workPayload({ title: 'First' })));
        return;
      }
      json(response, 200, workPayload({ title: path.includes('OL2W') ? 'Second' : 'Third' }));
    });
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl });
      const first = client.lookup({ workId: 'OL1W' });
      const second = client.lookup({ workId: 'OL2W' });
      const third = client.lookup({ workId: 'OL3W' });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(fixture.requests, ['/works/OL1W.json']);
      assert.equal(fixture.maxInFlight, 1);
      releaseFirst.resolve();
      const results = await Promise.all([first, second, third]);
      assert.deepEqual(results.map((item: OpenLibraryResult) => item.metadata?.title), ['First', 'Second', 'Third']);
      assert.deepEqual(fixture.requests, ['/works/OL1W.json', '/works/OL2W.json', '/works/OL3W.json']);
      assert.equal(fixture.maxInFlight, 1);
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library serves fresh cache, misses old/schema-version rows, and replaces on refresh', async () => {
  const fixture = await serverFixture();
  try {
    fixture.setHandler((_request, response) => json(response, 200, workPayload({ title: 'Fresh from HTTP' })));
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    await withDatabase(async (db) => {
      db.prepare(
        'INSERT INTO open_library_cache (work_id, payload_version, payload, retrieved_at) VALUES (?, ?, ?, ?)',
      ).run('OL123W', 1, JSON.stringify(metadata({ title: 'Cached title' })), new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString());
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl, now: () => now });
      const cached = await client.lookup({ workId: 'OL123W' });
      assert.equal(cached.metadata?.title, 'Cached title');
      assert.equal(fixture.requests.length, 0);

      db.prepare('UPDATE open_library_cache SET payload_version = 2 WHERE work_id = ?').run('OL123W');
      const schemaMiss = await client.lookup({ workId: 'OL123W' });
      assert.equal(schemaMiss.metadata?.title, 'Fresh from HTTP');
      assert.equal(fixture.requests.length, 1);

      fixture.setHandler((_request, response) => json(response, 200, workPayload({ title: 'Explicit refresh' })));
      const refreshed = await client.lookup({ workId: 'OL123W' }, { refresh: true });
      assert.equal(refreshed.metadata?.title, 'Explicit refresh');
      assert.equal(fixture.requests.length, 2);
      const row = db.prepare('SELECT payload_version, payload FROM open_library_cache WHERE work_id = ?').get('OL123W') as {
        payload_version: number;
        payload: string;
      };
      assert.equal(row.payload_version, 1);
      assert.equal((JSON.parse(row.payload) as OpenLibraryMetadata).title, 'Explicit refresh');
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library removes superseded ISBN cache rows on a changed-work refresh', async () => {
  const fixture = await serverFixture();
  try {
    let workId = 'OL200W';
    let title = 'ISBN original';
    fixture.setHandler((_request, response) =>
      json(response, 200, {
        title,
        authors: [{ name: 'An Author' }],
        works: [{ key: `/works/${workId}` }],
        publish_date: 'October 1, 1988',
        isbn_13: ['9780306406157'],
      }),
    );
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl });
      const first = await client.lookup({ isbn: '9780306406157' });
      assert.equal(first.metadata?.workId, 'OL200W');

      workId = 'OL201W';
      title = 'ISBN refreshed';
      const refreshed = await client.lookup(
        { isbn: '9780306406157' },
        { refresh: true },
      );
      assert.equal(refreshed.metadata?.workId, 'OL201W');

      const rows = db
        .prepare('SELECT work_id FROM open_library_cache ORDER BY work_id')
        .all() as Array<{ work_id: string }>;
      assert.deepEqual(rows.map((row) => row.work_id), ['OL201W']);
      const cached = await client.lookup({ isbn: '9780306406157' });
      assert.equal(cached.metadata?.workId, 'OL201W');
      assert.equal(fixture.requests.length, 2);
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library removes superseded search cache rows on a changed-work refresh', async () => {
  const fixture = await serverFixture();
  try {
    let workId = 'OL300W';
    fixture.setHandler((_request, response) =>
      json(response, 200, {
        numFound: 1,
        docs: [{
          key: `/works/${workId}`,
          title: 'Search cached',
          author_name: ['An Author'],
          first_publish_year: 1988,
          isbn: ['9780306406157'],
        }],
      }),
    );
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl });
      const first = await client.lookup({
        title: 'Search cached',
        author: 'An Author',
      });
      assert.equal(first.candidates?.[0]?.workId, 'OL300W');

      workId = 'OL301W';
      const refreshed = await client.lookup(
        { title: 'Search cached', author: 'An Author' },
        { refresh: true },
      );
      assert.equal(refreshed.candidates?.[0]?.workId, 'OL301W');

      const rows = db
        .prepare('SELECT work_id FROM open_library_cache ORDER BY work_id')
        .all() as Array<{ work_id: string }>;
      assert.deepEqual(rows.map((row) => row.work_id), ['OL301W']);
      const cached = await client.lookup({
        title: 'Search cached',
        author: 'An Author',
      });
      assert.deepEqual(
        cached.candidates?.map((candidate) => candidate.workId),
        ['OL301W'],
      );
      assert.equal(fixture.requests.length, 2);
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library retains stale metadata and exposes failed refresh errors', async () => {
  const fixture = await serverFixture();
  try {
    fixture.setHandler((_request, response) => json(response, 429, { error: 'slow down' }));
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    await withDatabase(async (db) => {
      db.prepare(
        'INSERT INTO open_library_cache (work_id, payload_version, payload, retrieved_at) VALUES (?, ?, ?, ?)',
      ).run('OL123W', 1, JSON.stringify(metadata({ title: 'Stale title' })), new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString());
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl, now: () => now });
      const result = await client.lookup({ workId: 'OL123W' });
      assert.equal(result.metadata?.title, 'Stale title');
      assert.equal(result.stale, true);
      assert.equal(result.refreshError?.code, 'rate_limited');
      const row = db.prepare('SELECT payload FROM open_library_cache WHERE work_id = ?').get('OL123W') as { payload: string };
      assert.equal((JSON.parse(row.payload) as OpenLibraryMetadata).title, 'Stale title');
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library rejects a malformed work key even with a requested fallback ID', async () => {
  const fixture = await serverFixture();
  try {
    fixture.setHandler((_request, response) => json(response, 200, {
      key: '/works/not-valid',
      title: 'Wrong work',
      authors: [{ name: 'An Author' }],
    }));
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl });
      await assert.rejects(() => client.lookup({ workId: 'OL123W' }), (error: unknown) => {
        return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'malformed_response';
      });
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library reuses fresh and stale ISBN cache entries', async () => {
  const fixture = await serverFixture();
  try {
    let status = 200;
    let title = 'ISBN cached';
    fixture.setHandler((_request, response) => {
      if (status !== 200) return json(response, status, { error: 'slow down' });
      return json(response, 200, {
        title,
        authors: [{ name: 'An Author' }],
        works: [{ key: '/works/OL200W' }],
        publish_date: 'October 1, 1988',
        isbn_13: ['9780306406157'],
      });
    });
    let now = Date.parse('2026-08-29T00:00:00.000Z');
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl, now: () => now });
      const first = await client.lookup({ isbn: '978-0-306-40615-7' });
      assert.equal(first.metadata?.title, 'ISBN cached');
      const cached = await client.lookup({ isbn: '9780306406157' });
      assert.equal(cached.metadata?.title, 'ISBN cached');
      assert.equal(fixture.requests.length, 1);

      now += 31 * 24 * 60 * 60 * 1000;
      status = 429;
      const stale = await client.lookup({ isbn: '9780306406157' });
      assert.equal(stale.metadata?.title, 'ISBN cached');
      assert.equal(stale.stale, true);
      assert.equal(stale.refreshError?.code, 'rate_limited');
      assert.equal(fixture.requests.length, 2);

      status = 200;
      title = 'ISBN replaced';
      const refreshed = await client.lookup({ isbn: '9780306406157' }, { refresh: true });
      assert.equal(refreshed.metadata?.title, 'ISBN replaced');
      assert.equal(fixture.requests.length, 3);
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library reuses fresh and stale title-author cache entries', async () => {
  const fixture = await serverFixture();
  try {
    let status = 200;
    let title = 'Search cached';
    fixture.setHandler((_request, response) => {
      if (status !== 200) return json(response, status, { error: 'slow down' });
      return json(response, 200, {
        numFound: 1,
        docs: [{
          key: '/works/OL201W',
          title,
          author_name: ['An Author'],
          first_publish_year: 1988,
          isbn: ['9780306406157'],
        }],
      });
    });
    let now = Date.parse('2026-08-29T00:00:00.000Z');
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl, now: () => now });
      const first = await client.lookup({ title: 'Search cached', author: 'An Author' });
      assert.equal(first.candidates?.[0]?.title, 'Search cached');
      const cached = await client.lookup({ title: 'Search cached', author: 'An Author' });
      assert.equal(cached.candidates?.[0]?.title, 'Search cached');
      assert.equal(fixture.requests.length, 1);

      now += 31 * 24 * 60 * 60 * 1000;
      status = 429;
      const stale = await client.lookup({ title: 'Search cached', author: 'An Author' });
      assert.equal(stale.candidates?.[0]?.title, 'Search cached');
      assert.equal(stale.stale, true);
      assert.equal(stale.refreshError?.code, 'rate_limited');
      assert.equal(fixture.requests.length, 2);

      status = 200;
      title = 'Search replaced';
      const refreshed = await client.lookup({ title: 'Search cached', author: 'An Author' }, { refresh: true });
      assert.equal(refreshed.candidates?.[0]?.title, 'Search replaced');
      assert.equal(fixture.requests.length, 3);
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library timeout, malformed, and not-found errors do not prevent manual entry', async () => {
  const fixture = await serverFixture();
  try {
    fixture.setHandler((request, response) => {
      const path = new URL(request.url ?? '/', fixture.baseUrl).pathname;
      if (path === '/works/OL1W.json') return;
      if (path === '/works/OL2W.json') return json(response, 200, { title: 42 });
      return json(response, 404, {});
    });
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl, timeoutMs: 20 });
      await assert.rejects(() => client.lookup({ workId: 'OL999W' }), (error: unknown) => {
        return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'not_found';
      });
      await assert.rejects(() => client.lookup({ workId: 'OL2W' }), (error: unknown) => {
        return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'malformed_response';
      });
      await assert.rejects(() => client.lookup({ workId: 'OL1W' }), (error: unknown) => {
        return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'timeout';
      });
      const manual = db.prepare(
        'INSERT INTO books (title, author, normalized_title, normalized_author) VALUES (?, ?, ?, ?)',
      ).run('Manual', 'Author', 'manual', 'author');
      assert.equal(Number(manual.lastInsertRowid) > 0, true);
    });
  } finally {
    await fixture.close();
  }
});

test('Open Library rate-limit errors do not get cached', async () => {
  const fixture = await serverFixture();
  try {
    fixture.setHandler((_request, response) => json(response, 429, { error: 'slow down' }));
    await withDatabase(async (db) => {
      const client = new OpenLibraryClient(db, { baseUrl: fixture.baseUrl });
      await assert.rejects(() => client.lookup({ workId: 'OL123W' }));
      const count = db.prepare('SELECT COUNT(*) AS count FROM open_library_cache').get() as { count: number };
      assert.equal(Number(count.count), 0);
    });
  } finally {
    await fixture.close();
  }
});
