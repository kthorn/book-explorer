import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { READING_STATUSES, type ReadingStatus } from './normalize.js';

export type Database = DatabaseSync;
export { READING_STATUSES };
export type { ReadingStatus };

export const MIGRATION_1 = `
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  session_filename TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE TABLE series (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  normalized_author TEXT NOT NULL,
  publication_year INTEGER,
  cover_url TEXT,
  series_id INTEGER REFERENCES series(id) ON DELETE SET NULL,
  series_position TEXT,
  status TEXT NOT NULL DEFAULT 'recommended' CHECK (status IN ('recommended', 'interested', 'reading', 'read', 'abandoned', 'not_interested')),
  rating INTEGER CHECK (rating IS NULL OR (typeof(rating) = 'integer' AND rating BETWEEN 1 AND 5)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE book_identifiers (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  scheme TEXT NOT NULL CHECK (scheme IN ('openlibrary_work', 'isbn10', 'isbn13')),
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (scheme, value)
);

CREATE TABLE book_notes (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_proposal_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  cautions TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (request_id, book_id)
);

CREATE TABLE citations (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  snippet TEXT,
  provider TEXT NOT NULL,
  retrieved_at TEXT NOT NULL
);

CREATE TABLE recommendation_citations (
  recommendation_id INTEGER NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  citation_id INTEGER NOT NULL REFERENCES citations(id) ON DELETE CASCADE,
  PRIMARY KEY (recommendation_id, citation_id)
);

CREATE TABLE open_library_cache (
  work_id TEXT PRIMARY KEY,
  payload_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  retrieved_at TEXT NOT NULL
);

CREATE INDEX idx_books_normalized_title_author
  ON books (normalized_title, normalized_author);
`;

const migrations = [{ sql: MIGRATION_1, version: 'PRAGMA user_version = 1' }] as const;

function precreateDatabaseFile(path: string): void {
  if (path === ':memory:') return;

  try {
    const descriptor = openSync(path, 'wx', 0o600);
    closeSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function migrate(db: Database): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const currentVersion = Number(row.user_version);
  if (!Number.isInteger(currentVersion) || currentVersion < 0 || currentVersion > migrations.length) {
    throw new Error(`Unsupported database schema version: ${currentVersion}`);
  }

  for (let index = currentVersion; index < migrations.length; index += 1) {
    transaction(db, () => {
      db.exec(migrations[index].sql);
      db.exec(migrations[index].version);
    });
  }
}

export function openDatabase(path: string): Database {
  precreateDatabaseFile(path);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA journal_mode = WAL;');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function closeDatabase(db: Database): void {
  db.close();
}

export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the operation's original error.
    }
    throw error;
  }
}
