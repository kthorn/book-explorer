import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  closeDatabase,
  openDatabase,
  READING_STATUSES,
  transaction,
} from '../src/db.js';

function withDatabase(run: (db: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'book-explorer-db-'));
  const path = join(directory, 'library.sqlite');
  const db = openDatabase(path);
  try {
    run(db);
  } finally {
    closeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
}

test('database migration creates exactly the frozen v1 tables and indexes', () => {
  withDatabase((db) => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => String((row as { name: string }).name));
    assert.deepEqual(tables, [
      'book_identifiers',
      'book_notes',
      'books',
      'citations',
      'conversations',
      'open_library_cache',
      'recommendation_citations',
      'recommendations',
      'series',
    ]);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
      .all()
      .map((row) => String((row as { name: string }).name));
    assert.deepEqual(indexes, ['idx_books_normalized_title_author']);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  });
});

test('database accepts every reading status and rejects invalid status or rating', () => {
  withDatabase((db) => {
    const insert = db.prepare(
      `INSERT INTO books
       (title, author, normalized_title, normalized_author, status, rating)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const status of READING_STATUSES) {
      insert.run('Book', 'Author', 'book', 'author', status, null);
    }
    assert.throws(() => insert.run('Bad status', 'Author', 'bad status', 'author', 'finished', null));
    assert.throws(() => insert.run('Bad rating', 'Author', 'bad rating', 'author', 'read', 0));
    assert.throws(() => insert.run('Bad rating', 'Author', 'bad rating 2', 'author', 'read', 6));
    assert.throws(() => insert.run('Bad rating', 'Author', 'bad rating 3', 'author', 'read', 1.5));
  });
});

test('database enforces every v1 unique constraint', () => {
  withDatabase((db) => {
    db.prepare('INSERT INTO conversations (name, session_filename) VALUES (?, ?)').run('One', 'one.jsonl');
    assert.throws(() =>
      db.prepare('INSERT INTO conversations (name, session_filename) VALUES (?, ?)').run('Two', 'one.jsonl'),
    );

    db.prepare('INSERT INTO series (name, normalized_name) VALUES (?, ?)').run('Saga', 'saga');
    assert.throws(() => db.prepare('INSERT INTO series (name, normalized_name) VALUES (?, ?)').run('SAGA', 'saga'));

    const seriesId = Number((db.prepare('SELECT id FROM series').get() as { id: number }).id);
    const book = db.prepare(
      `INSERT INTO books
       (title, author, normalized_title, normalized_author, series_id, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const bookId = Number(book.run('Book', 'Author', 'book', 'author', seriesId, 'recommended').lastInsertRowid);
    const secondBookId = Number(
      book.run('Book Two', 'Author', 'book two', 'author', seriesId, 'recommended').lastInsertRowid,
    );

    const identifier = db.prepare(
      'INSERT INTO book_identifiers (book_id, scheme, value, source) VALUES (?, ?, ?, ?)',
    );
    identifier.run(bookId, 'openlibrary_work', 'OL1W', 'test');
    assert.throws(() => identifier.run(secondBookId, 'openlibrary_work', 'OL1W', 'other'));

    db.prepare(
      'INSERT INTO citations (url, title, snippet, provider, retrieved_at) VALUES (?, ?, ?, ?, ?)',
    ).run('https://example.com/', 'Example', null, 'openai', '2026-08-29T00:00:00.000Z');
    assert.throws(() =>
      db.prepare(
        'INSERT INTO citations (url, title, snippet, provider, retrieved_at) VALUES (?, ?, ?, ?, ?)',
      ).run('https://example.com/', 'Other', null, 'openai', '2026-08-29T00:00:00.000Z'),
    );

    const recommendation = db.prepare(
      `INSERT INTO recommendations
       (book_id, source_conversation_id, request_id, rationale, cautions)
       VALUES (?, ?, ?, ?, ?)`,
    );
    recommendation.run(bookId, 1, 'request-1', 'First', null);
    assert.throws(() => recommendation.run(bookId, 1, 'request-1', 'Second', null));
    recommendation.run(secondBookId, 1, 'request-1', 'Second book', null);

    const note = db.prepare(
      'INSERT INTO book_notes (book_id, source_conversation_id, source_proposal_id, note) VALUES (?, ?, ?, ?)',
    );
    note.run(bookId, 1, 'proposal-1', 'A note');
    assert.throws(() => note.run(bookId, 1, 'proposal-1', 'Another note'));
    note.run(bookId, 1, null, 'Another note');
    note.run(bookId, 1, null, 'Third note');
  });
});

test('database foreign keys set series and conversation provenance links to null on deletion', () => {
  withDatabase((db) => {
    const conversationId = Number(
      db.prepare('INSERT INTO conversations (name, session_filename) VALUES (?, ?)').run('Chat', 'chat.jsonl')
        .lastInsertRowid,
    );
    const seriesId = Number(
      db.prepare('INSERT INTO series (name, normalized_name) VALUES (?, ?)').run('Saga', 'saga').lastInsertRowid,
    );
    const bookId = Number(
      db.prepare(
        `INSERT INTO books
         (title, author, normalized_title, normalized_author, series_id, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('Book', 'Author', 'book', 'author', seriesId, 'recommended').lastInsertRowid,
    );
    const recommendationId = Number(
      db.prepare(
        `INSERT INTO recommendations
         (book_id, source_conversation_id, request_id, rationale, cautions)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(bookId, conversationId, 'request-1', 'Rationale', null).lastInsertRowid,
    );
    db.prepare(
      'INSERT INTO book_notes (book_id, source_conversation_id, source_proposal_id, note) VALUES (?, ?, ?, ?)',
    ).run(bookId, conversationId, null, 'Note');

    db.prepare('DELETE FROM series WHERE id = ?').run(seriesId);
    assert.equal((db.prepare('SELECT series_id FROM books WHERE id = ?').get(bookId) as { series_id: number | null }).series_id, null);

    db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
    const provenance = db
      .prepare('SELECT source_conversation_id FROM book_notes WHERE book_id = ?')
      .get(bookId) as { source_conversation_id: number | null };
    assert.equal(provenance.source_conversation_id, null);
    const recommendation = db.prepare('SELECT source_conversation_id FROM recommendations WHERE id = ?').get(recommendationId) as {
      source_conversation_id: number | null;
    };
    assert.equal(recommendation.source_conversation_id, null);
  });
});

test('transaction rolls back an injected failing migration without partial schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'book-explorer-migration-'));
  const path = join(directory, 'library.sqlite');
  const seed = new DatabaseSync(path);
  seed.exec('CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  seed.close();

  assert.throws(() => openDatabase(path));
  const reopened = new DatabaseSync(path);
  try {
    const tables = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String((row as { name: string }).name));
    assert.deepEqual(tables, ['series']);
    assert.equal((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 0);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('database transaction rolls back callback changes when it throws', () => {
  withDatabase((db) => {
    assert.throws(() =>
      transaction(db, () => {
        db.exec('CREATE TABLE transient (value TEXT NOT NULL)');
        throw new Error('injected failure');
      }),
    );
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'transient'").get(), undefined);
  });
});
