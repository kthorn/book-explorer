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

export const LIBRARY_SQL = {
  selectBook: `
    SELECT b.id, b.title, b.author, b.publication_year, b.cover_url,
           b.series_id, b.series_position, b.status, b.rating,
           b.created_at, b.updated_at, s.name AS series_name
    FROM books AS b
    LEFT JOIN series AS s ON s.id = b.series_id
    WHERE b.id = ?`,
  selectBookSummary: `
    SELECT b.id, b.title, b.author, b.publication_year, b.cover_url,
           b.series_id, b.series_position, b.status, b.rating,
           b.created_at, b.updated_at, s.name AS series_name
    FROM books AS b
    LEFT JOIN series AS s ON s.id = b.series_id
    WHERE b.id = ?`,
  selectBookByIdentifier: `
    SELECT b.id, b.title, b.author, b.publication_year, b.cover_url,
           b.series_id, b.series_position, b.status, b.rating,
           b.created_at, b.updated_at, s.name AS series_name
    FROM books AS b
    LEFT JOIN series AS s ON s.id = b.series_id
    INNER JOIN book_identifiers AS i ON i.book_id = b.id
    WHERE i.scheme = ? AND i.value = ?`,
  selectBookCandidates: `
    SELECT b.id, b.title, b.author, b.publication_year, b.cover_url,
           b.series_id, b.series_position, b.status, b.rating,
           b.created_at, b.updated_at, s.name AS series_name
    FROM books AS b
    LEFT JOIN series AS s ON s.id = b.series_id
    WHERE b.normalized_title = ? AND b.normalized_author = ?
    ORDER BY b.id`,
  insertBook: `
    INSERT INTO books
      (title, author, normalized_title, normalized_author, publication_year,
       cover_url, series_id, series_position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  insertIdentifier: `
    INSERT OR IGNORE INTO book_identifiers (book_id, scheme, value, source)
    VALUES (?, ?, ?, ?)`,
  selectIdentifiers: `
    SELECT id, book_id, scheme, value, source, created_at
    FROM book_identifiers
    WHERE book_id = ?
    ORDER BY id`,
  updateBookTitle: `
    UPDATE books
    SET title = ?, normalized_title = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
  updateBookAuthor: `
    UPDATE books
    SET author = ?, normalized_author = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
  updateBookPublicationYear: `
    UPDATE books
    SET publication_year = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
  updateBookCoverUrl: `
    UPDATE books
    SET cover_url = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
  updateBookSeriesId: `
    UPDATE books
    SET series_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
  updateBookSeriesPosition: `
    UPDATE books
    SET series_position = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
  updateBookStatus: `
    UPDATE books
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
  updateBookRating: `
    UPDATE books
    SET rating = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
  fillBookPublicationYear: `
    UPDATE books
    SET publication_year = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND publication_year IS NULL`,
  fillBookCoverUrl: `
    UPDATE books
    SET cover_url = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND cover_url IS NULL`,
  fillBookSeriesId: `
    UPDATE books
    SET series_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND series_id IS NULL`,
  fillBookSeriesPosition: `
    UPDATE books
    SET series_position = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND series_position IS NULL`,
  deleteBook: 'DELETE FROM books WHERE id = ?',
  searchBooks: `
    SELECT b.id, b.title, b.author, b.publication_year, b.cover_url,
           b.series_id, b.series_position, b.status, b.rating,
           b.created_at, b.updated_at, s.name AS series_name
    FROM books AS b
    LEFT JOIN series AS s ON s.id = b.series_id
    WHERE (? IS NULL OR b.normalized_title LIKE '%' || ? || '%' OR b.normalized_author LIKE '%' || ? || '%')
      AND (? IS NULL OR b.status = ?)
      AND (? IS NULL OR b.rating = ?)
      AND (? IS NULL OR b.series_id = ?)
    ORDER BY b.id
    LIMIT ? OFFSET ?`,
  countBooks: `
    SELECT COUNT(*) AS count
    FROM books AS b
    WHERE (? IS NULL OR b.normalized_title LIKE '%' || ? || '%' OR b.normalized_author LIKE '%' || ? || '%')
      AND (? IS NULL OR b.status = ?)
      AND (? IS NULL OR b.rating = ?)
      AND (? IS NULL OR b.series_id = ?)`,
  selectSeries: `
    SELECT id, name, normalized_name, note, created_at, updated_at
    FROM series
    WHERE id = ?`,
  selectSeriesByName: `
    SELECT id, name, normalized_name, note, created_at, updated_at
    FROM series
    WHERE normalized_name = ?`,
  insertSeries: `
    INSERT INTO series (name, normalized_name, note)
    VALUES (?, ?, ?)`,
  updateSeriesName: `
    UPDATE series
    SET name = ?, normalized_name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
  updateSeriesNote: `
    UPDATE series
    SET note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
  deleteSeries: 'DELETE FROM series WHERE id = ?',
  searchSeries: `
    SELECT id, name, normalized_name, note, created_at, updated_at
    FROM series
    WHERE (? IS NULL OR normalized_name LIKE '%' || ? || '%')
    ORDER BY id
    LIMIT ? OFFSET ?`,
  countSeries: `
    SELECT COUNT(*) AS count
    FROM series
    WHERE (? IS NULL OR normalized_name LIKE '%' || ? || '%')`,
  selectNotes: `
    SELECT id, book_id, note, source_conversation_id, source_proposal_id, created_at
    FROM book_notes
    WHERE book_id = ?
    ORDER BY id`,
  selectNote: `
    SELECT id, book_id, note, source_conversation_id, source_proposal_id, created_at
    FROM book_notes
    WHERE id = ?`,
  insertNote: `
    INSERT INTO book_notes
      (book_id, note, source_conversation_id, source_proposal_id)
    VALUES (?, ?, ?, ?)`,
  updateNote: `
    UPDATE book_notes
    SET note = ?
    WHERE id = ? AND book_id = ?`,
  updateNoteById: `
    UPDATE book_notes
    SET note = ?
    WHERE id = ?`,
  deleteNote: 'DELETE FROM book_notes WHERE id = ? AND book_id = ?',
  deleteNoteById: 'DELETE FROM book_notes WHERE id = ?',
  selectRecommendationByRequest: `
    SELECT id, book_id, source_conversation_id, request_id, rationale, cautions, created_at
    FROM recommendations
    WHERE request_id = ? AND book_id = ?`,
  selectRecommendation: `
    SELECT id, book_id, source_conversation_id, request_id, rationale, cautions, created_at
    FROM recommendations
    WHERE id = ?`,
  insertRecommendation: `
    INSERT OR IGNORE INTO recommendations
      (book_id, source_conversation_id, request_id, rationale, cautions)
    VALUES (?, ?, ?, ?, ?)`,
  countRecommendations: `
    SELECT COUNT(*) AS count
    FROM recommendations
    WHERE book_id = ?`,
  selectRecommendations: `
    SELECT id, book_id, source_conversation_id, request_id, rationale, cautions, created_at
    FROM recommendations
    WHERE book_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?`,
  selectCitationByUrl: `
    SELECT id, url, title, snippet, provider, retrieved_at
    FROM citations
    WHERE url = ?`,
  insertOrUpdateCitation: `
    INSERT INTO citations (url, title, snippet, provider, retrieved_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title = excluded.title,
      snippet = excluded.snippet,
      provider = excluded.provider,
      retrieved_at = excluded.retrieved_at`,
  insertRecommendationCitation: `
    INSERT OR IGNORE INTO recommendation_citations (recommendation_id, citation_id)
    VALUES (?, ?)`,
  selectRecommendationCitations: `
    SELECT c.id, c.url, c.title, c.snippet, c.provider, c.retrieved_at
    FROM citations AS c
    INNER JOIN recommendation_citations AS rc ON rc.citation_id = c.id
    WHERE rc.recommendation_id = ?
    ORDER BY c.id`,
} as const;

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
