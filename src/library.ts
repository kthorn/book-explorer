import { LIBRARY_SQL, transaction, type Database } from "./db.js";
import {
  normalizeCitationUrl,
  normalizeIsbn,
  normalizeName,
  normalizeOpenLibraryWorkId,
  READING_STATUSES,
  type ReadingStatus,
  ValidationError,
} from "./normalize.js";

export const IDENTIFIER_SCHEMES = [
  "openlibrary_work",
  "isbn10",
  "isbn13",
] as const;
export type IdentifierScheme = (typeof IDENTIFIER_SCHEMES)[number];

export interface BookIdentifierInput {
  scheme: IdentifierScheme;
  value: string;
  source: string;
}

export interface BookIdentifier extends BookIdentifierInput {
  id: number;
  bookId: number;
  createdAt: string;
}

export interface CreateBookInput {
  title: string;
  author: string;
  publicationYear?: number | null;
  coverUrl?: string | null;
  seriesId?: number | null;
  seriesPosition?: string | null;
  identifiers?: readonly BookIdentifierInput[] | null;
}

export interface BookUpdateInput {
  title?: string;
  author?: string;
  publicationYear?: number | null;
  coverUrl?: string | null;
  seriesId?: number | null;
  seriesPosition?: string | null;
  status?: ReadingStatus;
  rating?: number | null;
  identifiers?: readonly BookIdentifierInput[] | null;
}

export type BookUpdateSource = "agent" | "user";
export type BookUpdateOwner =
  | BookUpdateSource
  | { actor?: BookUpdateSource; source?: BookUpdateSource };

export interface BookSummary {
  id: number;
  title: string;
  author: string;
  publicationYear: number | null;
  coverUrl: string | null;
  seriesId: number | null;
  seriesPosition: string | null;
  seriesName: string | null;
  status: ReadingStatus;
  rating: number | null;
  noteCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookCandidateSummary {
  id: number;
  title: string;
  author: string;
  publicationYear: number | null;
  coverUrl: string | null;
  seriesId: number | null;
  seriesPosition: string | null;
}

export interface BookNote {
  id: number;
  bookId: number;
  note: string;
  sourceConversationId: number | null;
  sourceProposalId: string | null;
  createdAt: string;
}

export interface Series {
  id: number;
  name: string;
  normalizedName: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CitationInput {
  url: string;
  title: string;
  snippet?: string | null;
  provider: string;
  retrievedAt?: string;
}

export interface Citation {
  id: number;
  url: string;
  title: string;
  snippet: string | null;
  provider: string;
  retrievedAt: string;
}

export interface Recommendation {
  id: number;
  bookId: number;
  sourceConversationId: number | null;
  requestId: string;
  rationale: string;
  cautions: string | null;
  createdAt: string;
  citations: Citation[];
}

export interface Book extends BookSummary {
  identifiers: BookIdentifier[];
  notes: BookNote[];
  recommendations: Recommendation[];
}

export interface SearchBooksOptions {
  query?: string;
  status?: ReadingStatus;
  rating?: number;
  seriesId?: number;
  limit?: number;
  offset?: number;
}

export interface SearchSeriesOptions {
  query?: string;
  limit?: number;
  offset?: number;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export class AmbiguousBookError extends Error {
  readonly candidates: BookCandidateSummary[];
  readonly candidateSummaries: BookCandidateSummary[];

  constructor(candidates: BookCandidateSummary[]) {
    super("More than one book matches the supplied identity");
    this.name = "AmbiguousBookError";
    this.candidates = candidates;
    this.candidateSummaries = candidates;
  }
}

export class RecordNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordNotFoundError";
  }
}

type SqlValue = string | number | bigint | null | undefined;
type Row = Record<string, SqlValue>;
type NormalizedIdentifier = Omit<BookIdentifierInput, "value"> & {
  value: string;
};
type NormalizedCreateBook = Omit<
  CreateBookInput,
  "title" | "author" | "identifiers"
> & {
  title: string;
  author: string;
  normalizedTitle: string;
  normalizedAuthor: string;
  identifiers: NormalizedIdentifier[];
};
type NormalizedBookUpdate = Partial<{
  title: string;
  author: string;
  publicationYear: number | null;
  coverUrl: string | null;
  seriesId: number | null;
  seriesPosition: string | null;
  status: ReadingStatus;
  rating: number | null;
  identifiers: NormalizedIdentifier[];
}>;
type NormalizedCitation = {
  url: string;
  title: string;
  snippet: string | null;
  provider: string;
  retrievedAt: string;
};

const MAX_PAGE_LIMIT = 100;

function rowValue(row: Row, key: string): SqlValue {
  return row[key];
}

function numberValue(value: unknown): number {
  return Number(value);
}

function nullableNumberValue(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function stringValue(value: unknown): string {
  return String(value);
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be a string`);
  }
  const result = value.trim();
  if (!result) {
    throw new ValidationError(`${label} must not be empty`);
  }
  if (result.length > maximum) {
    throw new ValidationError(`${label} must be at most ${maximum} characters`);
  }
  return result;
}

function optionalText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be a string`);
  }
  if (value.length > maximum) {
    throw new ValidationError(`${label} must be at most ${maximum} characters`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return positiveInteger(value, label);
}

function optionalYear(
  value: unknown,
  label = "Publication year",
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > 9999
  ) {
    throw new ValidationError(
      `${label} must be an integer from 0 through 9999`,
    );
  }
  return Number(value);
}

function optionalRating(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 5) {
    throw new ValidationError("Rating must be an integer from 1 through 5");
  }
  return Number(value);
}

function optionalStatus(value: unknown): ReadingStatus | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !(READING_STATUSES as readonly string[]).includes(value)
  ) {
    throw new ValidationError("Invalid reading status");
  }
  return value as ReadingStatus;
}

function optionalHttpUrl(
  value: unknown,
  label: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be a string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`Invalid ${label.toLowerCase()}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError(`${label} must use HTTP(S)`);
  }
  return url.toString();
}

function normalizeIdentifier(input: BookIdentifierInput): NormalizedIdentifier {
  if (!input || typeof input !== "object") {
    throw new ValidationError("Identifier must be an object");
  }
  const scheme = input.scheme;
  if (!(IDENTIFIER_SCHEMES as readonly string[]).includes(scheme)) {
    throw new ValidationError("Invalid identifier scheme");
  }
  const rawValue = requiredText(input.value, "Identifier value", 200);
  let value: string;
  switch (scheme) {
    case "openlibrary_work":
      value = normalizeOpenLibraryWorkId(rawValue);
      break;
    case "isbn10":
      value = normalizeIsbn(rawValue);
      if (value.length !== 10)
        throw new ValidationError("ISBN does not match identifier scheme");
      break;
    case "isbn13":
      value = normalizeIsbn(rawValue);
      if (value.length !== 13)
        throw new ValidationError("ISBN does not match identifier scheme");
      break;
  }
  return {
    scheme,
    value,
    source: requiredText(input.source, "Identifier source", 200),
  };
}

function normalizeIdentifiers(
  value: CreateBookInput["identifiers"],
): NormalizedIdentifier[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new ValidationError("Identifiers must be an array");
  if (value.length > 20)
    throw new ValidationError("At most 20 identifiers are allowed");
  const identifiers: NormalizedIdentifier[] = [];
  const seen = new Set<string>();
  for (const input of value) {
    const identifier = normalizeIdentifier(input);
    const key = `${identifier.scheme}:${identifier.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    identifiers.push(identifier);
  }
  return identifiers;
}

function normalizeCreateBook(input: CreateBookInput): NormalizedCreateBook {
  if (!input || typeof input !== "object")
    throw new ValidationError("Book must be an object");
  const title = requiredText(input.title, "Title", 300);
  const author = requiredText(input.author, "Author", 300);
  const publicationYear = optionalYear(input.publicationYear);
  const coverUrl = optionalHttpUrl(input.coverUrl, "Cover URL");
  const seriesId = optionalPositiveInteger(input.seriesId, "Series ID");
  const seriesPosition = optionalText(
    input.seriesPosition,
    "Series position",
    40,
  );
  return {
    title,
    author,
    normalizedTitle: normalizeName(title),
    normalizedAuthor: normalizeName(author),
    publicationYear,
    coverUrl,
    seriesId,
    seriesPosition,
    identifiers: normalizeIdentifiers(input.identifiers),
  };
}

function normalizeBookUpdate(input: BookUpdateInput): NormalizedBookUpdate {
  if (!input || typeof input !== "object")
    throw new ValidationError("Book update must be an object");
  const update: NormalizedBookUpdate = {};
  if ("title" in input && input.title !== undefined)
    update.title = requiredText(input.title, "Title", 300);
  if ("author" in input && input.author !== undefined)
    update.author = requiredText(input.author, "Author", 300);
  if ("publicationYear" in input)
    update.publicationYear = optionalYear(input.publicationYear);
  if ("coverUrl" in input)
    update.coverUrl = optionalHttpUrl(input.coverUrl, "Cover URL");
  if ("seriesId" in input)
    update.seriesId = optionalPositiveInteger(input.seriesId, "Series ID");
  if ("seriesPosition" in input)
    update.seriesPosition = optionalText(
      input.seriesPosition,
      "Series position",
      40,
    );
  if ("status" in input) update.status = optionalStatus(input.status);
  if ("rating" in input) update.rating = optionalRating(input.rating);
  if ("identifiers" in input && input.identifiers !== undefined) {
    update.identifiers = normalizeIdentifiers(input.identifiers);
  }
  return update;
}

function normalizeOwner(owner: BookUpdateOwner | undefined): BookUpdateSource {
  if (owner === undefined) return "user";
  if (typeof owner === "string") {
    if (owner === "agent" || owner === "user") return owner;
  } else if (owner && (owner.actor === "agent" || owner.source === "agent")) {
    return "agent";
  } else if (owner && (owner.actor === "user" || owner.source === "user")) {
    return "user";
  }
  throw new ValidationError("Invalid book update owner");
}

function normalizeNote(value: unknown): string {
  return requiredText(value, "Note", 4000);
}

function normalizeSeriesName(value: unknown): {
  name: string;
  normalizedName: string;
} {
  const name = requiredText(value, "Series name", 200);
  return { name, normalizedName: normalizeName(name) };
}

function normalizeSeriesNote(value: unknown): string | null {
  return optionalText(value, "Series note", 2000);
}

function normalizeRequestId(value: unknown): string {
  return requiredText(value, "Request ID", 200);
}

function normalizeCautions(value: unknown): string | null {
  return optionalText(value, "Cautions", 2000);
}

function normalizeCitation(input: CitationInput): NormalizedCitation {
  if (!input || typeof input !== "object")
    throw new ValidationError("Citation must be an object");
  const url = normalizeCitationUrl(
    requiredText(input.url, "Citation URL", 4000),
  );
  const title = requiredText(input.title, "Citation title", 1000);
  const snippet = optionalText(input.snippet, "Citation snippet", 4000);
  const provider = requiredText(input.provider, "Citation provider", 200);
  const retrievedAt =
    input.retrievedAt === undefined
      ? new Date().toISOString()
      : requiredText(input.retrievedAt, "Citation retrieval time", 100);
  return { url, title, snippet, provider, retrievedAt };
}

function normalizePagination(
  optionsOrLimit?: PaginationOptions | number,
  offset = 0,
): { limit: number; offset: number } {
  const options =
    typeof optionsOrLimit === "number"
      ? { limit: optionsOrLimit, offset }
      : (optionsOrLimit ?? {});
  const limit = options.limit ?? 20;
  const resultOffset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ValidationError(
      `Limit must be an integer from 1 through ${MAX_PAGE_LIMIT}`,
    );
  }
  if (!Number.isSafeInteger(resultOffset) || resultOffset < 0) {
    throw new ValidationError("Offset must be a non-negative integer");
  }
  return { limit, offset: resultOffset };
}

function mapBookSummary(row: Row): BookSummary {
  return {
    id: numberValue(rowValue(row, "id")),
    title: stringValue(rowValue(row, "title")),
    author: stringValue(rowValue(row, "author")),
    publicationYear: nullableNumberValue(rowValue(row, "publication_year")),
    coverUrl:
      rowValue(row, "cover_url") === null
        ? null
        : stringValue(rowValue(row, "cover_url")),
    seriesId: nullableNumberValue(rowValue(row, "series_id")),
    seriesPosition:
      rowValue(row, "series_position") === null
        ? null
        : stringValue(rowValue(row, "series_position")),
    seriesName:
      rowValue(row, "series_name") === null
        ? null
        : stringValue(rowValue(row, "series_name")),
    status: stringValue(rowValue(row, "status")) as ReadingStatus,
    rating: nullableNumberValue(rowValue(row, "rating")),
    noteCount: numberValue(rowValue(row, "note_count")),
    createdAt: stringValue(rowValue(row, "created_at")),
    updatedAt: stringValue(rowValue(row, "updated_at")),
  };
}

function mapCandidate(row: Row): BookCandidateSummary {
  return {
    id: numberValue(rowValue(row, "id")),
    title: stringValue(rowValue(row, "title")),
    author: stringValue(rowValue(row, "author")),
    publicationYear: nullableNumberValue(rowValue(row, "publication_year")),
    coverUrl:
      rowValue(row, "cover_url") === null
        ? null
        : stringValue(rowValue(row, "cover_url")),
    seriesId: nullableNumberValue(rowValue(row, "series_id")),
    seriesPosition:
      rowValue(row, "series_position") === null
        ? null
        : stringValue(rowValue(row, "series_position")),
  };
}

function mapIdentifier(row: Row): BookIdentifier {
  return {
    id: numberValue(rowValue(row, "id")),
    bookId: numberValue(rowValue(row, "book_id")),
    scheme: stringValue(rowValue(row, "scheme")) as IdentifierScheme,
    value: stringValue(rowValue(row, "value")),
    source: stringValue(rowValue(row, "source")),
    createdAt: stringValue(rowValue(row, "created_at")),
  };
}

function mapNote(row: Row): BookNote {
  return {
    id: numberValue(rowValue(row, "id")),
    bookId: numberValue(rowValue(row, "book_id")),
    note: stringValue(rowValue(row, "note")),
    sourceConversationId: nullableNumberValue(
      rowValue(row, "source_conversation_id"),
    ),
    sourceProposalId:
      rowValue(row, "source_proposal_id") === null
        ? null
        : stringValue(rowValue(row, "source_proposal_id")),
    createdAt: stringValue(rowValue(row, "created_at")),
  };
}

function mapSeries(row: Row): Series {
  return {
    id: numberValue(rowValue(row, "id")),
    name: stringValue(rowValue(row, "name")),
    normalizedName: stringValue(rowValue(row, "normalized_name")),
    note:
      rowValue(row, "note") === null
        ? null
        : stringValue(rowValue(row, "note")),
    createdAt: stringValue(rowValue(row, "created_at")),
    updatedAt: stringValue(rowValue(row, "updated_at")),
  };
}

function mapCitation(row: Row): Citation {
  return {
    id: numberValue(rowValue(row, "id")),
    url: stringValue(rowValue(row, "url")),
    title: stringValue(rowValue(row, "title")),
    snippet:
      rowValue(row, "snippet") === null
        ? null
        : stringValue(rowValue(row, "snippet")),
    provider: stringValue(rowValue(row, "provider")),
    retrievedAt: stringValue(rowValue(row, "retrieved_at")),
  };
}

function mapRecommendation(row: Row, citations: Citation[]): Recommendation {
  return {
    id: numberValue(rowValue(row, "id")),
    bookId: numberValue(rowValue(row, "book_id")),
    sourceConversationId: nullableNumberValue(
      rowValue(row, "source_conversation_id"),
    ),
    requestId: stringValue(rowValue(row, "request_id")),
    rationale: stringValue(rowValue(row, "rationale")),
    cautions:
      rowValue(row, "cautions") === null
        ? null
        : stringValue(rowValue(row, "cautions")),
    createdAt: stringValue(rowValue(row, "created_at")),
    citations,
  };
}

export class LibraryRepository {
  constructor(private readonly db: Database) {}

  createOrFindBook(input: CreateBookInput): Book {
    const book = normalizeCreateBook(input);
    if (book.seriesId !== undefined && book.seriesId !== null)
      this.requireSeries(book.seriesId);

    return transaction(this.db, () => {
      const matches = new Map<number, Row>();
      for (const identifier of book.identifiers) {
        const row = this.db
          .prepare(LIBRARY_SQL.selectBookByIdentifier)
          .get(identifier.scheme, identifier.value) as Row | undefined;
        if (row) matches.set(numberValue(rowValue(row, "id")), row);
      }
      if (matches.size > 1)
        throw new AmbiguousBookError([...matches.values()].map(mapCandidate));

      let existing = matches.values().next().value as Row | undefined;
      const candidates = this.db
        .prepare(LIBRARY_SQL.selectBookCandidates)
        .all(book.normalizedTitle, book.normalizedAuthor) as Row[];
      if (existing) {
        const existingId = numberValue(rowValue(existing, "id"));
        const conflictingCandidates = candidates.filter(
          (candidate) => numberValue(rowValue(candidate, "id")) !== existingId,
        );
        if (conflictingCandidates.length > 0) {
          throw new AmbiguousBookError(
            [existing, ...conflictingCandidates].map(mapCandidate),
          );
        }
      } else {
        if (candidates.length > 1)
          throw new AmbiguousBookError(candidates.map(mapCandidate));
        existing = candidates[0];
      }

      if (existing) {
        const id = numberValue(rowValue(existing, "id"));
        this.fillMissingBookFields(id, existing, book);
        const owners = this.insertIdentifiersAndFindOwners(
          id,
          book.identifiers,
        );
        const conflictingOwners = [...owners.values()].filter(
          (owner) => numberValue(rowValue(owner, "id")) !== id,
        );
        if (conflictingOwners.length > 0) {
          throw new AmbiguousBookError(
            [existing, ...conflictingOwners].map(mapCandidate),
          );
        }
        return this.requireBook(id);
      }

      const result = this.db
        .prepare(LIBRARY_SQL.insertBook)
        .run(
          book.title,
          book.author,
          book.normalizedTitle,
          book.normalizedAuthor,
          book.publicationYear ?? null,
          book.coverUrl ?? null,
          book.seriesId ?? null,
          book.seriesPosition ?? null,
        );
      const id = numberValue(result.lastInsertRowid);
      const owners = this.insertIdentifiersAndFindOwners(id, book.identifiers);
      if (owners.size > 1)
        throw new AmbiguousBookError([...owners.values()].map(mapCandidate));
      const owner = owners.values().next().value as Row | undefined;
      if (owner && numberValue(rowValue(owner, "id")) !== id) {
        const ownerId = numberValue(rowValue(owner, "id"));
        this.db.prepare(LIBRARY_SQL.deleteBook).run(id);
        this.fillMissingBookFields(ownerId, owner, book);
        this.insertIdentifiersAndFindOwners(ownerId, book.identifiers);
        return this.requireBook(ownerId);
      }
      return this.requireBook(id);
    });
  }

  getBook(bookId: number): Book | null {
    const id = positiveInteger(bookId, "Book ID");
    const row = this.db.prepare(LIBRARY_SQL.selectBook).get(id) as
      | Row
      | undefined;
    if (!row) return null;
    const summary = mapBookSummary(row);
    const identifiers = (
      this.db.prepare(LIBRARY_SQL.selectIdentifiers).all(id) as Row[]
    ).map(mapIdentifier);
    const notes = (
      this.db.prepare(LIBRARY_SQL.selectNotes).all(id) as Row[]
    ).map(mapNote);
    const recommendations = this.allRecommendations(id);
    return { ...summary, identifiers, notes, recommendations };
  }

  searchBooks(options: SearchBooksOptions = {}): Page<BookSummary> {
    if (!options || typeof options !== "object")
      throw new ValidationError("Book search options must be an object");
    const { limit, offset } = normalizePagination(options);
    const query =
      options.query === undefined || options.query.trim() === ""
        ? null
        : normalizeName(options.query);
    const status = optionalStatus(options.status);
    const rating = optionalRating(options.rating);
    const seriesId = optionalPositiveInteger(options.seriesId, "Series ID");
    const values = [
      query,
      query,
      query,
      status ?? null,
      status ?? null,
      rating ?? null,
      rating ?? null,
      seriesId ?? null,
      seriesId ?? null,
    ];
    const total = numberValue(
      (this.db.prepare(LIBRARY_SQL.countBooks).get(...values) as Row).count,
    );
    const items = (
      this.db
        .prepare(LIBRARY_SQL.searchBooks)
        .all(...values, limit, offset) as Row[]
    ).map(mapBookSummary);
    return { items, total, limit, offset };
  }

  updateBook(
    bookId: number,
    input: BookUpdateInput,
    owner?: BookUpdateOwner,
  ): Book | null {
    const id = positiveInteger(bookId, "Book ID");
    const source = normalizeOwner(owner);
    const update = normalizeBookUpdate(input);
    if (source === "agent") {
      delete update.title;
      delete update.author;
      delete update.identifiers;
    }
    if (update.seriesId !== undefined && update.seriesId !== null)
      this.requireSeries(update.seriesId);

    return transaction(this.db, () => {
      const row = this.db.prepare(LIBRARY_SQL.selectBook).get(id) as
        | Row
        | undefined;
      if (!row) return null;
      if (source === "agent") {
        if (
          update.publicationYear !== undefined &&
          update.publicationYear !== null &&
          rowValue(row, "publication_year") === null
        ) {
          this.db
            .prepare(LIBRARY_SQL.fillBookPublicationYear)
            .run(update.publicationYear, id);
        }
        if (
          update.coverUrl !== undefined &&
          update.coverUrl !== null &&
          rowValue(row, "cover_url") === null
        ) {
          this.db
            .prepare(LIBRARY_SQL.fillBookCoverUrl)
            .run(update.coverUrl, id);
        }
        if (
          update.seriesId !== undefined &&
          update.seriesId !== null &&
          rowValue(row, "series_id") === null
        ) {
          this.db
            .prepare(LIBRARY_SQL.fillBookSeriesId)
            .run(update.seriesId, id);
        }
        if (
          update.seriesPosition !== undefined &&
          update.seriesPosition !== null &&
          rowValue(row, "series_position") === null
        ) {
          this.db
            .prepare(LIBRARY_SQL.fillBookSeriesPosition)
            .run(update.seriesPosition, id);
        }
        if (update.status !== undefined) {
          this.db.prepare(LIBRARY_SQL.updateBookStatus).run(update.status, id);
        }
        if (update.rating !== undefined) {
          this.db.prepare(LIBRARY_SQL.updateBookRating).run(update.rating, id);
        }
      } else {
        if (update.title !== undefined) {
          this.db
            .prepare(LIBRARY_SQL.updateBookTitle)
            .run(update.title, normalizeName(update.title), id);
        }
        if (update.author !== undefined) {
          this.db
            .prepare(LIBRARY_SQL.updateBookAuthor)
            .run(update.author, normalizeName(update.author), id);
        }
        if (update.publicationYear !== undefined) {
          this.db
            .prepare(LIBRARY_SQL.updateBookPublicationYear)
            .run(update.publicationYear, id);
        }
        if (update.coverUrl !== undefined) {
          this.db
            .prepare(LIBRARY_SQL.updateBookCoverUrl)
            .run(update.coverUrl, id);
        }
        if (update.seriesId !== undefined) {
          this.db
            .prepare(LIBRARY_SQL.updateBookSeriesId)
            .run(update.seriesId, id);
        }
        if (update.seriesPosition !== undefined) {
          this.db
            .prepare(LIBRARY_SQL.updateBookSeriesPosition)
            .run(update.seriesPosition, id);
        }
        if (update.status !== undefined) {
          this.db.prepare(LIBRARY_SQL.updateBookStatus).run(update.status, id);
        }
        if (update.rating !== undefined) {
          this.db.prepare(LIBRARY_SQL.updateBookRating).run(update.rating, id);
        }
        if (update.identifiers !== undefined) {
          this.db.prepare(LIBRARY_SQL.deleteIdentifiers).run(id);
          const insert = this.db.prepare(
            LIBRARY_SQL.insertReplacementIdentifier,
          );
          for (const identifier of update.identifiers) {
            insert.run(
              id,
              identifier.scheme,
              identifier.value,
              identifier.source,
            );
          }
          this.db.prepare(LIBRARY_SQL.touchBook).run(id);
        }
      }
      return this.requireBook(id);
    });
  }

  deleteBook(bookId: number): boolean {
    const id = positiveInteger(bookId, "Book ID");
    return this.db.prepare(LIBRARY_SQL.deleteBook).run(id).changes > 0;
  }

  createOrFindSeries(input: { name: string; note?: string | null }): Series;
  createOrFindSeries(name: string, note?: string | null): Series;
  createOrFindSeries(
    inputOrName: { name: string; note?: string | null } | string,
    note?: string | null,
  ): Series {
    const nameInput =
      typeof inputOrName === "string" ? inputOrName : inputOrName.name;
    const noteInput = typeof inputOrName === "string" ? note : inputOrName.note;
    const { name, normalizedName } = normalizeSeriesName(nameInput);
    const seriesNote = normalizeSeriesNote(noteInput);

    return transaction(this.db, () => {
      const existing = this.db
        .prepare(LIBRARY_SQL.selectSeriesByName)
        .get(normalizedName) as Row | undefined;
      if (existing) {
        const id = numberValue(rowValue(existing, "id"));
        if (seriesNote !== null && rowValue(existing, "note") === null) {
          this.db.prepare(LIBRARY_SQL.updateSeriesNote).run(seriesNote, id);
        }
        return this.requireSeriesRecord(id);
      }
      const result = this.db
        .prepare(LIBRARY_SQL.insertSeries)
        .run(name, normalizedName, seriesNote);
      return this.requireSeriesRecord(numberValue(result.lastInsertRowid));
    });
  }

  createSeries(input: { name: string; note?: string | null }): Series;
  createSeries(name: string, note?: string | null): Series;
  createSeries(
    inputOrName: { name: string; note?: string | null } | string,
    note?: string | null,
  ): Series {
    return typeof inputOrName === "string"
      ? this.createOrFindSeries(inputOrName, note)
      : this.createOrFindSeries(inputOrName);
  }

  upsertSeries(input: { name: string; note?: string | null }): Series;
  upsertSeries(name: string, note?: string | null): Series;
  upsertSeries(
    inputOrName: { name: string; note?: string | null } | string,
    note?: string | null,
  ): Series {
    return typeof inputOrName === "string"
      ? this.createOrFindSeries(inputOrName, note)
      : this.createOrFindSeries(inputOrName);
  }

  getSeries(seriesId: number): Series | null {
    const id = positiveInteger(seriesId, "Series ID");
    const row = this.db.prepare(LIBRARY_SQL.selectSeries).get(id) as
      | Row
      | undefined;
    return row ? mapSeries(row) : null;
  }

  searchSeries(options: SearchSeriesOptions = {}): Page<Series> {
    if (!options || typeof options !== "object")
      throw new ValidationError("Series search options must be an object");
    const { limit, offset } = normalizePagination(options);
    const query =
      options.query === undefined || options.query.trim() === ""
        ? null
        : normalizeName(options.query);
    const values = [query, query];
    const total = numberValue(
      (this.db.prepare(LIBRARY_SQL.countSeries).get(...values) as Row).count,
    );
    const items = (
      this.db
        .prepare(LIBRARY_SQL.searchSeries)
        .all(...values, limit, offset) as Row[]
    ).map(mapSeries);
    return { items, total, limit, offset };
  }

  updateSeries(
    seriesId: number,
    input: { name?: string; note?: string | null },
  ): Series | null {
    const id = positiveInteger(seriesId, "Series ID");
    if (!input || typeof input !== "object")
      throw new ValidationError("Series update must be an object");
    const name =
      input.name === undefined ? undefined : normalizeSeriesName(input.name);
    const note = "note" in input ? normalizeSeriesNote(input.note) : undefined;
    return transaction(this.db, () => {
      if (!this.db.prepare(LIBRARY_SQL.selectSeries).get(id)) return null;
      if (name)
        this.db
          .prepare(LIBRARY_SQL.updateSeriesName)
          .run(name.name, name.normalizedName, id);
      if (note !== undefined)
        this.db.prepare(LIBRARY_SQL.updateSeriesNote).run(note, id);
      return this.requireSeriesRecord(id);
    });
  }

  deleteSeries(seriesId: number): boolean {
    const id = positiveInteger(seriesId, "Series ID");
    return this.db.prepare(LIBRARY_SQL.deleteSeries).run(id).changes > 0;
  }

  addNote(
    bookId: number,
    note: string,
    sourceConversationId: number | null = null,
    sourceProposalId: string | null = null,
  ): BookNote {
    const id = positiveInteger(bookId, "Book ID");
    this.requireBook(id);
    const text = normalizeNote(note);
    const conversationId =
      sourceConversationId === null
        ? null
        : positiveInteger(sourceConversationId, "Conversation ID");
    const proposalId =
      sourceProposalId === null
        ? null
        : requiredText(sourceProposalId, "Proposal ID", 200);
    const result = this.db
      .prepare(LIBRARY_SQL.insertNote)
      .run(id, text, conversationId, proposalId);
    return this.requireNote(numberValue(result.lastInsertRowid));
  }

  getNote(noteId: number): BookNote | null {
    const id = positiveInteger(noteId, "Note ID");
    const row = this.db.prepare(LIBRARY_SQL.selectNote).get(id) as
      | Row
      | undefined;
    return row ? mapNote(row) : null;
  }

  editNote(bookId: number, noteId: number, note: string): BookNote | null;
  editNote(noteId: number, note: string): BookNote | null;
  editNote(
    bookIdOrNoteId: number,
    noteIdOrText: number | string,
    noteText?: string,
  ): BookNote | null {
    const text = normalizeNote(
      noteText === undefined ? noteIdOrText : noteText,
    );
    const noteId =
      noteText === undefined
        ? positiveInteger(bookIdOrNoteId, "Note ID")
        : positiveInteger(noteIdOrText, "Note ID");
    const result =
      noteText === undefined
        ? this.db.prepare(LIBRARY_SQL.updateNoteById).run(text, noteId)
        : this.db
            .prepare(LIBRARY_SQL.updateNote)
            .run(text, noteId, positiveInteger(bookIdOrNoteId, "Book ID"));
    return result.changes > 0 ? this.requireNote(noteId) : null;
  }

  updateNote(bookId: number, noteId: number, note: string): BookNote | null;
  updateNote(noteId: number, note: string): BookNote | null;
  updateNote(
    bookIdOrNoteId: number,
    noteIdOrText: number | string,
    noteText?: string,
  ): BookNote | null {
    return noteText === undefined
      ? this.editNote(bookIdOrNoteId, noteIdOrText as string)
      : this.editNote(bookIdOrNoteId, noteIdOrText as number, noteText);
  }

  deleteNote(bookId: number, noteId: number): boolean;
  deleteNote(noteId: number): boolean;
  deleteNote(bookIdOrNoteId: number, noteId?: number): boolean {
    if (noteId === undefined) {
      return (
        this.db
          .prepare(LIBRARY_SQL.deleteNoteById)
          .run(positiveInteger(bookIdOrNoteId, "Note ID")).changes > 0
      );
    }
    return (
      this.db
        .prepare(LIBRARY_SQL.deleteNote)
        .run(
          positiveInteger(noteId, "Note ID"),
          positiveInteger(bookIdOrNoteId, "Book ID"),
        ).changes > 0
    );
  }

  recordRecommendation(
    requestId: string,
    bookId: number,
    rationale: string,
    cautions: string | null = null,
    citations: readonly CitationInput[] = [],
    sourceConversationId: number | null = null,
  ): Recommendation {
    const request = normalizeRequestId(requestId);
    const id = positiveInteger(bookId, "Book ID");
    const text = requiredText(rationale, "Rationale", 4000);
    const cautionText = normalizeCautions(cautions);
    if (!Array.isArray(citations))
      throw new ValidationError("Citations must be an array");
    if (citations.length > 20)
      throw new ValidationError("At most 20 citations are allowed");
    const normalizedCitations = new Map<string, NormalizedCitation>();
    for (const citation of citations) {
      const normalized = normalizeCitation(citation);
      normalizedCitations.set(normalized.url, normalized);
    }
    const conversationId =
      sourceConversationId === null
        ? null
        : positiveInteger(sourceConversationId, "Conversation ID");

    return transaction(this.db, () => {
      const existing = this.db
        .prepare(LIBRARY_SQL.selectRecommendationByRequest)
        .get(request, id) as Row | undefined;
      if (existing)
        return this.requireRecommendation(
          numberValue(rowValue(existing, "id")),
        );
      this.requireBook(id);
      const result = this.db
        .prepare(LIBRARY_SQL.insertRecommendation)
        .run(id, conversationId, request, text, cautionText);
      if (result.changes === 0) {
        const winner = this.db
          .prepare(LIBRARY_SQL.selectRecommendationByRequest)
          .get(request, id) as Row | undefined;
        if (!winner)
          throw new Error(
            "Recommendation insert was ignored without an existing row",
          );
        return this.requireRecommendation(numberValue(rowValue(winner, "id")));
      }
      const recommendationId = numberValue(result.lastInsertRowid);
      for (const citation of normalizedCitations.values()) {
        this.db
          .prepare(LIBRARY_SQL.insertOrUpdateCitation)
          .run(
            citation.url,
            citation.title,
            citation.snippet,
            citation.provider,
            citation.retrievedAt,
          );
        const citationRow = this.db
          .prepare(LIBRARY_SQL.selectCitationByUrl)
          .get(citation.url) as Row;
        this.db
          .prepare(LIBRARY_SQL.insertRecommendationCitation)
          .run(recommendationId, numberValue(rowValue(citationRow, "id")));
      }
      return this.requireRecommendation(recommendationId);
    });
  }

  listRecommendations(
    bookId: number,
    options?: PaginationOptions,
  ): Page<Recommendation>;
  listRecommendations(
    bookId: number,
    limit?: number,
    offset?: number,
  ): Page<Recommendation>;
  listRecommendations(
    bookId: number,
    optionsOrLimit: PaginationOptions | number = {},
    offset = 0,
  ): Page<Recommendation> {
    const id = positiveInteger(bookId, "Book ID");
    this.requireBook(id);
    const page = normalizePagination(optionsOrLimit, offset);
    const total = numberValue(
      (this.db.prepare(LIBRARY_SQL.countRecommendations).get(id) as Row).count,
    );
    const rows = this.db
      .prepare(LIBRARY_SQL.selectRecommendations)
      .all(id, page.limit, page.offset) as Row[];
    return {
      items: rows.map((row) => this.mapRecommendationRow(row)),
      total,
      ...page,
    };
  }

  getRecommendationHistory(
    bookId: number,
    options?: PaginationOptions,
  ): Page<Recommendation>;
  getRecommendationHistory(
    bookId: number,
    limit?: number,
    offset?: number,
  ): Page<Recommendation>;
  getRecommendationHistory(
    bookId: number,
    optionsOrLimit: PaginationOptions | number = {},
    offset = 0,
  ): Page<Recommendation> {
    return typeof optionsOrLimit === "number"
      ? this.listRecommendations(bookId, optionsOrLimit, offset)
      : this.listRecommendations(bookId, optionsOrLimit);
  }

  getRecommendations(
    bookId: number,
    options?: PaginationOptions,
  ): Page<Recommendation>;
  getRecommendations(
    bookId: number,
    limit?: number,
    offset?: number,
  ): Page<Recommendation>;
  getRecommendations(
    bookId: number,
    optionsOrLimit: PaginationOptions | number = {},
    offset = 0,
  ): Page<Recommendation> {
    return typeof optionsOrLimit === "number"
      ? this.listRecommendations(bookId, optionsOrLimit, offset)
      : this.listRecommendations(bookId, optionsOrLimit);
  }

  private requireBook(bookId: number): Book {
    const book = this.getBook(bookId);
    if (!book) throw new RecordNotFoundError(`Book ${bookId} was not found`);
    return book;
  }

  private requireSeries(seriesId: number): Series {
    const series = this.getSeries(seriesId);
    if (!series)
      throw new RecordNotFoundError(`Series ${seriesId} was not found`);
    return series;
  }

  private requireSeriesRecord(seriesId: number): Series {
    const row = this.db.prepare(LIBRARY_SQL.selectSeries).get(seriesId) as
      | Row
      | undefined;
    if (!row) throw new RecordNotFoundError(`Series ${seriesId} was not found`);
    return mapSeries(row);
  }

  private requireNote(noteId: number): BookNote {
    const note = this.getNote(noteId);
    if (!note) throw new RecordNotFoundError(`Note ${noteId} was not found`);
    return note;
  }

  private requireRecommendation(recommendationId: number): Recommendation {
    const row = this.db
      .prepare(LIBRARY_SQL.selectRecommendation)
      .get(recommendationId) as Row | undefined;
    if (!row)
      throw new RecordNotFoundError(
        `Recommendation ${recommendationId} was not found`,
      );
    return this.mapRecommendationRow(row);
  }

  private allRecommendations(bookId: number): Recommendation[] {
    const rows = this.db
      .prepare(LIBRARY_SQL.selectRecommendations)
      .all(bookId, -1, 0) as Row[];
    return rows.map((row) => this.mapRecommendationRow(row));
  }

  private mapRecommendationRow(row: Row): Recommendation {
    const id = numberValue(rowValue(row, "id"));
    const citations = (
      this.db
        .prepare(LIBRARY_SQL.selectRecommendationCitations)
        .all(id) as Row[]
    ).map(mapCitation);
    return mapRecommendation(row, citations);
  }

  private insertIdentifiersAndFindOwners(
    bookId: number,
    identifiers: readonly NormalizedIdentifier[],
  ): Map<number, Row> {
    const statement = this.db.prepare(LIBRARY_SQL.insertIdentifier);
    const owners = new Map<number, Row>();
    for (const identifier of identifiers) {
      statement.run(
        bookId,
        identifier.scheme,
        identifier.value,
        identifier.source,
      );
      const owner = this.db
        .prepare(LIBRARY_SQL.selectBookByIdentifier)
        .get(identifier.scheme, identifier.value) as Row | undefined;
      if (owner) owners.set(numberValue(rowValue(owner, "id")), owner);
    }
    return owners;
  }

  private fillMissingBookFields(
    bookId: number,
    current: Row,
    input: NormalizedCreateBook,
  ): void {
    if (
      input.publicationYear !== undefined &&
      input.publicationYear !== null &&
      rowValue(current, "publication_year") === null
    ) {
      this.db
        .prepare(LIBRARY_SQL.fillBookPublicationYear)
        .run(input.publicationYear, bookId);
    }
    if (
      input.coverUrl !== undefined &&
      input.coverUrl !== null &&
      rowValue(current, "cover_url") === null
    ) {
      this.db.prepare(LIBRARY_SQL.fillBookCoverUrl).run(input.coverUrl, bookId);
    }
    if (
      input.seriesId !== undefined &&
      input.seriesId !== null &&
      rowValue(current, "series_id") === null
    ) {
      this.db.prepare(LIBRARY_SQL.fillBookSeriesId).run(input.seriesId, bookId);
    }
    if (
      input.seriesPosition !== undefined &&
      input.seriesPosition !== null &&
      rowValue(current, "series_position") === null
    ) {
      this.db
        .prepare(LIBRARY_SQL.fillBookSeriesPosition)
        .run(input.seriesPosition, bookId);
    }
  }
}

export function createLibraryRepository(db: Database): LibraryRepository {
  return new LibraryRepository(db);
}
