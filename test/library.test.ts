import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  closeDatabase,
  LIBRARY_SQL,
  openDatabase,
  type Database,
} from "../src/db.js";
import {
  AmbiguousBookError,
  LibraryRepository,
  type CitationInput,
} from "../src/library.js";

function withDatabase(
  run: (db: Database, library: LibraryRepository) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "book-explorer-library-"));
  const db = openDatabase(join(directory, "library.sqlite"));
  const library = new LibraryRepository(db);
  try {
    run(db, library);
  } finally {
    closeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
}

const citation: CitationInput = {
  url: "HTTPS://Example.COM/source#section",
  title: "Source",
  snippet: "A useful source.",
  provider: "openai",
  retrievedAt: "2026-08-29T00:00:00.000Z",
};

function injectOnMissingLookup(
  db: Database,
  sql: string,
  inject: () => void,
): Database {
  let injected = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec" || property === "close") {
        return target[property].bind(target);
      }
      if (property !== "prepare") return Reflect.get(target, property);
      return (query: string) => {
        const statement = target.prepare(query);
        if (query !== sql) return statement;
        return new Proxy(statement, {
          get(statementTarget, statementProperty) {
            if (statementProperty !== "get") {
              const value = Reflect.get(statementTarget, statementProperty);
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            }
            return (...parameters: any[]) => {
              const result = statementTarget.get(...parameters);
              if (!injected && result === undefined) {
                injected = true;
                inject();
              }
              return result;
            };
          },
        });
      };
    },
  }) as unknown as Database;
}

test("reselects an identifier owner when it appears between lookup and insertion", () => {
  withDatabase((db) => {
    let injectedBookId = 0;
    const racingDatabase = injectOnMissingLookup(
      db,
      LIBRARY_SQL.selectBookByIdentifier,
      () => {
        injectedBookId = Number(
          db
            .prepare(
              `INSERT INTO books (title, author, normalized_title, normalized_author)
           VALUES (?, ?, ?, ?)`,
            )
            .run("Injected", "Other Author", "injected", "other author")
            .lastInsertRowid,
        );
        db.prepare(
          `INSERT INTO book_identifiers (book_id, scheme, value, source)
         VALUES (?, ?, ?, ?)`,
        ).run(injectedBookId, "openlibrary_work", "OL123W", "race");
      },
    );
    const library = new LibraryRepository(racingDatabase);
    const result = library.createOrFindBook({
      title: "Requested",
      author: "Author",
      identifiers: [
        { scheme: "openlibrary_work", value: "OL123W", source: "agent" },
      ],
    });

    assert.equal(result.id, injectedBookId);
    assert.equal(
      result.identifiers.some((identifier) => identifier.value === "OL123W"),
      true,
    );
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS count FROM books").get() as {
          count: number;
        }
      ).count,
      1,
    );
  });
});

test("reuses a book by exact identifier and fills only missing metadata", () => {
  withDatabase((_db, library) => {
    const first = library.createOrFindBook({
      title: "The First Title",
      author: "An Author",
      identifiers: [
        { scheme: "openlibrary_work", value: "OL123W", source: "openlibrary" },
      ],
    });
    const repeated = library.createOrFindBook({
      title: "A Different Display Title",
      author: "A Different Author",
      publicationYear: 2026,
      coverUrl: "https://covers.example/book.jpg",
      identifiers: [
        { scheme: "openlibrary_work", value: "/works/ol123w", source: "agent" },
      ],
    });

    assert.equal(repeated.id, first.id);
    assert.equal(repeated.title, "The First Title");
    assert.equal(repeated.publicationYear, 2026);
    assert.equal(repeated.coverUrl, "https://covers.example/book.jpg");
    assert.equal(library.getBook(first.id)?.identifiers[0]?.value, "OL123W");
  });
});

test("user updates replace and remove validated identifiers", () => {
  withDatabase((_db, library) => {
    const book = library.createOrFindBook({
      title: "Book",
      author: "Author",
      identifiers: [
        { scheme: "isbn13", value: "9780306406157", source: "catalog" },
      ],
    });

    const replaced = library.updateBook(
      book.id,
      {
        identifiers: [
          {
            scheme: "openlibrary_work",
            value: "/works/ol123w",
            source: "edited",
          },
        ],
      } as never,
      "user",
    );
    assert.deepEqual(
      replaced?.identifiers.map((identifier) => ({
        scheme: identifier.scheme,
        value: identifier.value,
        source: identifier.source,
      })),
      [{ scheme: "openlibrary_work", value: "OL123W", source: "edited" }],
    );

    assert.throws(
      () =>
        library.updateBook(
          book.id,
          {
            identifiers: [
              { scheme: "isbn13", value: "not-an-isbn", source: "edited" },
            ],
          } as never,
          "user",
        ),
      /ISBN/,
    );
    assert.equal(library.getBook(book.id)?.identifiers[0]?.value, "OL123W");
    assert.deepEqual(
      library.updateBook(book.id, { identifiers: [] } as never, "user")
        ?.identifiers,
      [],
    );
  });
});

test("reports ambiguous normalized title and author candidates without merging them", () => {
  withDatabase((db, library) => {
    const first = library.createOrFindBook({
      title: "Same Title",
      author: "Same Author",
      identifiers: [
        { scheme: "isbn13", value: "9780306406157", source: "catalog" },
      ],
    });
    const second = Number(
      db
        .prepare(
          `INSERT INTO books (title, author, normalized_title, normalized_author)
         VALUES (?, ?, ?, ?)`,
        )
        .run("same\u00a0title", "SAME AUTHOR", "same title", "same author")
        .lastInsertRowid,
    );

    assert.notEqual(first.id, second);
    assert.throws(
      () =>
        library.createOrFindBook({
          title: " SAME  TITLE ",
          author: "same author",
        }),
      (error: unknown) => {
        if (!(error instanceof AmbiguousBookError)) return false;
        const candidates = (
          error as unknown as {
            candidates: Array<{ id: number; title: string; author: string }>;
          }
        ).candidates;
        assert.deepEqual(
          candidates.map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            author: candidate.author,
          })),
          [
            { id: first.id, title: "Same Title", author: "Same Author" },
            { id: second, title: "same\u00a0title", author: "SAME AUTHOR" },
          ],
        );
        return true;
      },
    );
    assert.equal(library.searchBooks({}).total, 2);
  });
});

test("does not merge a matching identifier with a conflicting normalized candidate", () => {
  withDatabase((db, library) => {
    const first = library.createOrFindBook({
      title: "Same Title",
      author: "Same Author",
      identifiers: [
        { scheme: "openlibrary_work", value: "OL123W", source: "catalog" },
      ],
    });
    db.prepare(
      `INSERT INTO books (title, author, normalized_title, normalized_author)
       VALUES (?, ?, ?, ?)`,
    ).run("Same Title", "Same Author", "same title", "same author");

    assert.throws(
      () =>
        library.createOrFindBook({
          title: "Same Title",
          author: "Same Author",
          identifiers: [
            { scheme: "openlibrary_work", value: "OL123W", source: "catalog" },
          ],
        }),
      AmbiguousBookError,
    );
    assert.equal(library.getBook(first.id)?.identifiers.length, 1);
  });
});

test("book search summaries report how many notes each book has", () => {
  withDatabase((_db, library) => {
    const book = library.createOrFindBook({ title: "Book", author: "Author" });
    library.addNote(book.id, "First note");
    library.addNote(book.id, "Second note");

    assert.equal(library.searchBooks({}).items[0]?.noteCount, 2);
  });
});

test("agent updates status and rating without overwriting user-owned book metadata", () => {
  withDatabase((_db, library) => {
    const book = library.createOrFindBook({
      title: "Book",
      author: "Author",
      publicationYear: 2000,
    });
    library.updateBook(
      book.id,
      { publicationYear: 1999, coverUrl: "https://user.example/cover" },
      "user",
    );
    library.updateBook(
      book.id,
      {
        publicationYear: 2026,
        coverUrl: "https://agent.example/cover",
        seriesPosition: "1",
      },
      "agent",
    );

    const updated = library.getBook(book.id);
    assert.equal(updated?.publicationYear, 1999);
    assert.equal(updated?.coverUrl, "https://user.example/cover");
    assert.equal(updated?.seriesPosition, "1");

    library.updateBook(
      book.id,
      { title: "Agent title", status: "abandoned", rating: 1 },
      "agent",
    );
    assert.equal(library.getBook(book.id)?.title, "Book");
    assert.equal(library.getBook(book.id)?.status, "abandoned");
    assert.equal(library.getBook(book.id)?.rating, 1);

    library.updateBook(book.id, { status: "read", rating: 5 }, "user");
    assert.equal(library.getBook(book.id)?.status, "read");
    assert.equal(library.getBook(book.id)?.rating, 5);
  });
});

test("series names are normalized and member deletion leaves books intact", () => {
  withDatabase((_db, library) => {
    const first = library.createOrFindSeries("  The Saga  ");
    const repeated = library.createOrFindSeries("THE\u00a0SAGA");
    assert.equal(repeated.id, first.id);

    const book = library.createOrFindBook({
      title: "Book",
      author: "Author",
      seriesId: first.id,
    });
    assert.equal(library.getBook(book.id)?.seriesId, first.id);
    assert.equal(
      library.updateSeries(first.id, { note: "A note" })?.note,
      "A note",
    );
    assert.equal(library.deleteSeries(first.id), true);
    assert.equal(library.getBook(book.id)?.seriesId, null);
    assert.equal(library.getSeries(first.id), null);
  });
});

test("notes can be edited and deleted only within their book", () => {
  withDatabase((_db, library) => {
    const first = library.createOrFindBook({
      title: "First",
      author: "Author",
    });
    const second = library.createOrFindBook({
      title: "Second",
      author: "Author",
    });
    const note = library.addNote(first.id, "Original note", null, "proposal-1");

    assert.equal(library.editNote(second.id, note.id, "Wrong book"), null);
    assert.equal(
      library.editNote(first.id, note.id, "Edited note")?.note,
      "Edited note",
    );
    assert.equal(library.deleteNote(second.id, note.id), false);
    assert.equal(library.deleteNote(first.id, note.id), true);
    assert.deepEqual(library.getBook(first.id)?.notes, []);
  });
});

test("reselects an existing recommendation after an insert conflict", () => {
  withDatabase((db, library) => {
    const book = library.createOrFindBook({ title: "Book", author: "Author" });
    let injectedRecommendationId = 0;
    const racingDatabase = injectOnMissingLookup(
      db,
      LIBRARY_SQL.selectRecommendationByRequest,
      () => {
        injectedRecommendationId = Number(
          db
            .prepare(
              `INSERT INTO recommendations
           (book_id, source_conversation_id, request_id, rationale, cautions)
           VALUES (?, ?, ?, ?, ?)`,
            )
            .run(book.id, null, "race-request", "first", null).lastInsertRowid,
        );
      },
    );
    const racedLibrary = new LibraryRepository(racingDatabase);
    const result = racedLibrary.recordRecommendation(
      "race-request",
      book.id,
      "second",
      null,
      [],
    );

    assert.equal(result.id, injectedRecommendationId);
    assert.equal(result.rationale, "first");
  });
});

test("recommendations are idempotent by request and book while citations upsert and link", () => {
  withDatabase((_db, library) => {
    const book = library.createOrFindBook({ title: "Book", author: "Author" });
    const first = library.recordRecommendation(
      "request-1",
      book.id,
      "first",
      null,
      [citation],
    );
    const repeated = library.recordRecommendation(
      "request-1",
      book.id,
      "changed",
      "new cautions",
      [{ ...citation, title: "Changed title" }],
    );

    assert.equal(repeated.id, first.id);
    assert.equal(repeated.rationale, "first");
    assert.equal(repeated.cautions, null);
    assert.equal(repeated.citations[0]?.title, "Source");

    const otherBook = library.createOrFindBook({
      title: "Other",
      author: "Author",
    });
    const second = library.recordRecommendation(
      "request-2",
      otherBook.id,
      "second",
      null,
      [{ ...citation, title: "Newest title", snippet: null }],
    );
    assert.equal(second.citations[0]?.title, "Newest title");
    assert.equal(library.getBook(book.id)?.recommendations.length, 1);
    assert.equal(library.getBook(otherBook.id)?.recommendations.length, 1);

    const page = library.listRecommendations(book.id, { limit: 20, offset: 0 });
    assert.deepEqual(
      page.items.map((item: { id: number }) => item.id),
      [first.id],
    );
    assert.equal(page.total, 1);
  });
});

test("searchBooks returns filtered summaries and paged recommendation history", () => {
  withDatabase((_db, library) => {
    const first = library.createOrFindBook({
      title: "Alpha",
      author: "Author One",
    });
    const second = library.createOrFindBook({
      title: "Beta",
      author: "Author Two",
    });
    library.updateBook(first.id, { status: "read", rating: 4 }, "user");
    library.updateBook(second.id, { status: "interested", rating: 5 }, "user");
    library.recordRecommendation("request-1", first.id, "one", null, []);
    library.recordRecommendation("request-2", first.id, "two", null, []);

    assert.equal(library.searchBooks({ query: "alpha" }).total, 1);
    assert.equal(
      library.searchBooks({ status: "read", rating: 4 }).items[0]?.id,
      first.id,
    );
    assert.deepEqual(
      library
        .listRecommendations(first.id, { limit: 1, offset: 1 })
        .items.map((item: { rationale: string }) => item.rationale),
      ["one"],
    );
  });
});

test("deleting a book cascades its notes, recommendations, and citations", () => {
  withDatabase((_db, library) => {
    const book = library.createOrFindBook({ title: "Book", author: "Author" });
    library.addNote(book.id, "Note");
    library.recordRecommendation("request-1", book.id, "rationale", null, [
      citation,
    ]);
    assert.equal(library.deleteBook(book.id), true);
    assert.equal(library.getBook(book.id), null);
  });
});
