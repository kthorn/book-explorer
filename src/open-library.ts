import { LIBRARY_SQL, transaction, type Database } from './db.js';
import {
  normalizeIsbn,
  normalizeName,
  normalizeOpenLibraryWorkId,
  ValidationError,
} from './normalize.js';

const CACHE_PAYLOAD_VERSION = 1;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_BASE_URL = 'https://openlibrary.org/';
const DEFAULT_COVERS_BASE_URL = 'https://covers.openlibrary.org/';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'book-explorer/1.0';
const SEARCH_LIMIT = 20;

export type OpenLibraryIdentifierScheme = 'openlibrary_work' | 'isbn10' | 'isbn13';

export interface OpenLibraryIdentifier {
  scheme: OpenLibraryIdentifierScheme;
  value: string;
  source: string;
}

export interface OpenLibraryMetadata {
  workId: string;
  title: string;
  author: string;
  publicationYear: number | null;
  coverUrl: string | null;
  seriesHints: string[];
  identifiers: OpenLibraryIdentifier[];
}

export type OpenLibraryCandidate = OpenLibraryMetadata;

export type OpenLibraryErrorCode =
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'malformed_response'
  | 'network_error'
  | 'http_error';

export interface OpenLibraryRefreshError {
  code: OpenLibraryErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
}

export interface OpenLibraryResult {
  metadata?: OpenLibraryMetadata;
  candidates?: OpenLibraryCandidate[];
  stale?: boolean;
  refreshError?: OpenLibraryRefreshError;
}

export type OpenLibraryLookupInput =
  | { workId: string }
  | { isbn: string }
  | { title: string; author: string };

export interface OpenLibraryLookupOptions {
  refresh?: boolean;
}

export interface OpenLibraryClientOptions {
  baseUrl?: string;
  coversBaseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
  now?: () => number | Date;
}

export class OpenLibraryError extends Error {
  readonly code: OpenLibraryErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: OpenLibraryErrorCode, message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = 'OpenLibraryError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

interface NormalizedLookup {
  kind: 'work' | 'isbn' | 'search';
  workId?: string;
  isbn?: string;
  isbnScheme?: 'isbn10' | 'isbn13';
  title?: string;
  author?: string;
}

interface CacheEntry {
  metadata: OpenLibraryMetadata;
  retrievedAt: number;
}

interface CacheRow {
  work_id: unknown;
  payload_version: unknown;
  payload: unknown;
  retrieved_at: unknown;
}

interface RecordValue {
  [key: string]: unknown;
}

let requestTail: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const previous = requestTail;
  let release!: () => void;
  requestTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(operation).finally(release);
}

function asRecord(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function malformed(message = 'Open Library returned a malformed response'): never {
  throw new OpenLibraryError('malformed_response', message, false);
}

function responseText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) malformed(`Open Library response has no ${label}`);
  return value.trim();
}

function responseYear(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value <= 9999 ? value : null;
  }
  if (typeof value === 'string') {
    const match = /(?:^|[^\d])(\d{4})(?!\d)/u.exec(value);
    return match ? Number(match[1]) : null;
  }
  return null;
}

function responseYearFrom(record: RecordValue, ...keys: string[]): number | null {
  for (const key of keys) {
    if (key in record) return responseYear(record[key]);
  }
  return null;
}

function responseAuthor(record: RecordValue): string {
  if ('author' in record && typeof record.author === 'string' && record.author.trim()) {
    return record.author.trim();
  }

  if (Array.isArray(record.author_name)) {
    const names = record.author_name.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    if (names.length > 0) return names.join(', ');
  }

  if (Array.isArray(record.authors)) {
    const names: string[] = [];
    for (const value of record.authors) {
      const author = asRecord(value);
      if (!author) continue;
      if (typeof author.name === 'string' && author.name.trim()) {
        names.push(author.name.trim());
        continue;
      }
      const nested = asRecord(author.author);
      if (nested && typeof nested.name === 'string' && nested.name.trim()) {
        names.push(nested.name.trim());
      } else if (nested && typeof nested.key === 'string' && nested.key.trim()) {
        names.push(nested.key.trim());
      } else if (typeof author.key === 'string' && author.key.trim()) {
        names.push(author.key.trim());
      }
    }
    if (names.length > 0) return names.join(', ');
  }

  return malformed('Open Library response has no author');
}

function responseSeriesHints(record: RecordValue): string[] {
  const raw = 'seriesHints' in record ? record.seriesHints : record.series;
  if (raw === undefined || raw === null) return [];
  if (typeof raw === 'string') return raw.trim() ? [raw.trim()] : [];
  if (!Array.isArray(raw)) return malformed('Open Library response has invalid series hints');
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const name = typeof value === 'string'
      ? value.trim()
      : asRecord(value)?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const trimmed = name.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      hints.push(trimmed);
    }
  }
  return hints;
}

function httpUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return malformed('Open Library response has an invalid cover URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return malformed('Open Library response has an invalid cover URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return malformed('Open Library response has an invalid cover URL');
  }
  return url.toString();
}

function coverUrl(record: RecordValue, coversBaseUrl: string): string | null {
  if ('coverUrl' in record) return httpUrl(record.coverUrl);
  if ('cover_url' in record) return httpUrl(record.cover_url);

  let cover: unknown;
  if (Array.isArray(record.covers)) cover = record.covers[0];
  else if ('cover_i' in record) cover = record.cover_i;
  if (cover === null || cover === undefined || cover === '') return null;
  if (typeof cover !== 'number' && typeof cover !== 'string') {
    return malformed('Open Library response has an invalid cover ID');
  }
  const coverId = String(cover).trim();
  if (!/^\d+$/.test(coverId) || Number(coverId) <= 0) {
    return malformed('Open Library response has an invalid cover ID');
  }
  return new URL(`b/id/${encodeURIComponent(coverId)}-L.jpg`, coversBaseUrl).toString();
}

function addIdentifier(
  identifiers: OpenLibraryIdentifier[],
  seen: Set<string>,
  scheme: OpenLibraryIdentifierScheme,
  value: unknown,
  source = 'openlibrary',
): void {
  if (typeof value !== 'string' || !value.trim()) return;
  let normalized: string;
  try {
    normalized = scheme === 'openlibrary_work'
      ? normalizeOpenLibraryWorkId(value)
      : normalizeIsbn(value);
  } catch {
    return;
  }
  if ((scheme === 'isbn10' && normalized.length !== 10) || (scheme === 'isbn13' && normalized.length !== 13)) return;
  const key = `${scheme}:${normalized}`;
  if (seen.has(key) || identifiers.length >= 20) return;
  seen.add(key);
  identifiers.push({ scheme, value: normalized, source });
}

function responseIdentifiers(record: RecordValue, workId: string, extra: OpenLibraryIdentifier[] = []): OpenLibraryIdentifier[] {
  const identifiers: OpenLibraryIdentifier[] = [];
  const seen = new Set<string>();
  addIdentifier(identifiers, seen, 'openlibrary_work', workId);

  if (Array.isArray(record.identifiers)) {
    for (const value of record.identifiers) {
      const identifier = asRecord(value);
      if (!identifier) continue;
      const scheme = identifier.scheme;
      if (scheme === 'openlibrary_work' || scheme === 'isbn10' || scheme === 'isbn13') {
        addIdentifier(identifiers, seen, scheme, identifier.value, typeof identifier.source === 'string' ? identifier.source : 'openlibrary');
      }
    }
  }

  const isbn10 = Array.isArray(record.isbn_10) ? record.isbn_10 : [];
  const isbn13 = Array.isArray(record.isbn_13) ? record.isbn_13 : [];
  for (const value of isbn10) addIdentifier(identifiers, seen, 'isbn10', value);
  for (const value of isbn13) addIdentifier(identifiers, seen, 'isbn13', value);
  if (Array.isArray(record.isbn)) {
    for (const value of record.isbn) {
      if (typeof value !== 'string') continue;
      let normalized: string;
      try {
        normalized = normalizeIsbn(value);
      } catch {
        continue;
      }
      addIdentifier(identifiers, seen, normalized.length === 10 ? 'isbn10' : 'isbn13', normalized);
    }
  }
  for (const identifier of extra) addIdentifier(identifiers, seen, identifier.scheme, identifier.value, identifier.source);
  return identifiers;
}

function parseMetadata(
  value: unknown,
  fallbackWorkId: string | undefined,
  coversBaseUrl: string,
  extraIdentifiers: OpenLibraryIdentifier[] = [],
  validateWorkKey = false,
): OpenLibraryMetadata {
  const record = asRecord(value);
  if (!record) return malformed();

  let workId: string;
  try {
    const rawWorkId = fallbackWorkId ?? record.workId ?? record.key;
    if (typeof rawWorkId !== 'string') return malformed('Open Library response has no work ID');
    workId = normalizeOpenLibraryWorkId(rawWorkId);
    if (fallbackWorkId && record.workId !== undefined && normalizeOpenLibraryWorkId(String(record.workId)) !== workId) {
      return malformed('Open Library response has a conflicting work ID');
    }
    if (validateWorkKey && record.key !== undefined) {
      if (typeof record.key !== 'string') return malformed('Open Library response has an invalid work key');
      let declaredWorkId: string;
      try {
        declaredWorkId = normalizeOpenLibraryWorkId(record.key);
      } catch {
        return malformed('Open Library response has an invalid work key');
      }
      if (declaredWorkId !== workId) return malformed('Open Library response has a conflicting work ID');
    }
  } catch {
    return malformed('Open Library response has an invalid work ID');
  }

  const title = responseText(record.title, 'title');
  const author = responseAuthor(record);
  const publicationYear = 'publicationYear' in record
    ? responseYear(record.publicationYear)
    : responseYearFrom(record, 'first_publish_year', 'first_publish_date', 'publish_year', 'publish_date');
  const result: OpenLibraryMetadata = {
    workId,
    title,
    author,
    publicationYear,
    coverUrl: coverUrl(record, coversBaseUrl),
    seriesHints: responseSeriesHints(record),
    identifiers: responseIdentifiers(record, workId, extraIdentifiers),
  };
  if (result.identifiers.length === 0) return malformed('Open Library response has no usable identifiers');
  return result;
}

function normalizeInput(input: OpenLibraryLookupInput): NormalizedLookup {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Open Library lookup must be an object');
  }
  const value = input as Record<string, unknown>;
  const hasWorkId = value.workId !== undefined;
  const hasIsbn = value.isbn !== undefined;
  const hasTitle = value.title !== undefined;
  const hasAuthor = value.author !== undefined;
  const supplied = Number(hasWorkId) + Number(hasIsbn) + Number(hasTitle) + Number(hasAuthor);

  if (hasWorkId && supplied === 1) {
    return { kind: 'work', workId: normalizeOpenLibraryWorkId(value.workId as string) };
  }
  if (hasIsbn && supplied === 1) {
    const isbn = normalizeIsbn(value.isbn as string);
    return {
      kind: 'isbn',
      isbn,
      isbnScheme: isbn.length === 10 ? 'isbn10' : 'isbn13',
    };
  }
  if (hasTitle && hasAuthor && supplied === 2) {
    if (typeof value.title !== 'string' || typeof value.author !== 'string') {
      throw new ValidationError('Title and author must be strings');
    }
    const title = value.title.trim();
    const author = value.author.trim();
    normalizeName(title);
    normalizeName(author);
    return { kind: 'search', title, author };
  }
  throw new ValidationError('Provide exactly one work ID, ISBN, or title and author');
}

function refreshError(error: unknown): OpenLibraryRefreshError {
  if (error instanceof OpenLibraryError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  return {
    code: 'network_error',
    message: 'Open Library lookup failed',
    retryable: true,
  };
}

function safeDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export class OpenLibraryClient {
  private readonly db: Database;
  private readonly baseUrl: string;
  private readonly coversBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly now: () => number | Date;

  constructor(db: Database, options: OpenLibraryClientOptions | string = {}) {
    this.db = db;
    const config = typeof options === 'string' ? { baseUrl: options } : options;
    if (!config || typeof config !== 'object') throw new ValidationError('Open Library client options must be an object');
    this.baseUrl = this.normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL, 'Open Library base URL');
    this.coversBaseUrl = this.normalizeBaseUrl(config.coversBaseUrl ?? DEFAULT_COVERS_BASE_URL, 'Open Library covers URL');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ValidationError('Open Library timeout must be positive');
    }
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    if (typeof this.userAgent !== 'string' || !this.userAgent.trim()) {
      throw new ValidationError('Open Library user agent must not be empty');
    }
    this.now = config.now ?? (() => Date.now());
  }

  async lookup(input: OpenLibraryLookupInput, options: OpenLibraryLookupOptions = {}): Promise<OpenLibraryResult> {
    if (!options || typeof options !== 'object') throw new ValidationError('Open Library lookup options must be an object');
    const normalized = normalizeInput(input);
    const refresh = options.refresh === true;

    if (normalized.kind === 'work') {
      const cached = this.readCache(normalized.workId!);
      if (!refresh && cached && this.isFresh(cached)) return { metadata: cached.metadata };
      let metadata: OpenLibraryMetadata;
      try {
        metadata = await enqueue(() => this.fetchWork(normalized.workId!));
      } catch (error) {
        if (cached) return { metadata: cached.metadata, stale: true, refreshError: refreshError(error) };
        throw error;
      }
      this.writeCache(metadata);
      return { metadata };
    }

    if (normalized.kind === 'isbn') {
      const cached = this.findCachedByIsbn(normalized.isbn!);
      const fresh = cached.find((entry) => this.isFresh(entry));
      if (!refresh && fresh) return { metadata: fresh.metadata };
      let metadata: OpenLibraryMetadata;
      try {
        metadata = await enqueue(() => this.fetchIsbn(normalized.isbn!, normalized.isbnScheme!));
      } catch (error) {
        if (cached[0]) return { metadata: cached[0].metadata, stale: true, refreshError: refreshError(error) };
        throw error;
      }
      this.writeCache(metadata);
      return { metadata };
    }

    const cached = this.findCachedByTitleAuthor(normalized.title!, normalized.author!);
    if (!refresh && cached.length > 0 && cached.every((entry) => this.isFresh(entry))) {
      return { candidates: cached.map((entry) => entry.metadata) };
    }
    let candidates: OpenLibraryCandidate[];
    try {
      candidates = await enqueue(() => this.fetchSearch(normalized.title!, normalized.author!));
    } catch (error) {
      if (cached.length > 0) {
        return { candidates: cached.map((entry) => entry.metadata), stale: true, refreshError: refreshError(error) };
      }
      throw error;
    }
    for (const candidate of candidates) this.writeCache(candidate);
    return { candidates };
  }

  private normalizeBaseUrl(value: string, label: string): string {
    if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ValidationError(`Invalid ${label.toLowerCase()}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ValidationError(`${label} must use HTTP(S)`);
    }
    return `${url.toString().replace(/\/$/u, '')}/`;
  }

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': this.userAgent, accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status === 404) {
        throw new OpenLibraryError('not_found', 'Open Library did not find the requested record', false, 404);
      }
      if (response.status === 429) {
        throw new OpenLibraryError('rate_limited', 'Open Library rate limit exceeded', true, 429);
      }
      if (!response.ok) {
        throw new OpenLibraryError(
          'http_error',
          `Open Library request failed with status ${response.status}`,
          response.status >= 500,
          response.status,
        );
      }
      try {
        return await response.json() as unknown;
      } catch {
        throw new OpenLibraryError('malformed_response', 'Open Library returned invalid JSON', false);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new OpenLibraryError('timeout', 'Open Library request timed out', true);
      }
      if (error instanceof OpenLibraryError) throw error;
      throw new OpenLibraryError('network_error', 'Open Library request failed', true);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchWork(workId: string): Promise<OpenLibraryMetadata> {
    const body = await this.fetchJson(this.url(`works/${workId}.json`));
    return parseMetadata(body, workId, this.coversBaseUrl, [], true);
  }

  private async fetchIsbn(isbn: string, scheme: 'isbn10' | 'isbn13'): Promise<OpenLibraryMetadata> {
    const body = await this.fetchJson(this.url(`isbn/${isbn}.json`));
    const record = asRecord(body);
    if (!record) return malformed();
    const works = Array.isArray(record.works) ? record.works : [];
    let workId: string | undefined;
    for (const value of works) {
      const work = asRecord(value);
      const raw = work?.key ?? work?.workId ?? (typeof value === 'string' ? value : undefined);
      if (typeof raw !== 'string') continue;
      try {
        workId = normalizeOpenLibraryWorkId(raw);
        break;
      } catch {
        // Ignore an unusable work reference and inspect the next one.
      }
    }
    if (!workId) return malformed('Open Library ISBN response has no work reference');
    return parseMetadata(body, workId, this.coversBaseUrl, [{ scheme, value: isbn, source: 'openlibrary' }]);
  }

  private async fetchSearch(title: string, author: string): Promise<OpenLibraryCandidate[]> {
    const url = new URL('search.json', this.baseUrl);
    url.searchParams.set('title', title);
    url.searchParams.set('author', author);
    url.searchParams.set('limit', String(SEARCH_LIMIT));
    const body = await this.fetchJson(url.toString());
    const record = asRecord(body);
    if (!record || !Array.isArray(record.docs)) return malformed('Open Library search response has no document list');
    if ('numFound' in record && (!Number.isSafeInteger(record.numFound) || Number(record.numFound) < 0)) {
      return malformed('Open Library search response has an invalid result count');
    }

    const candidates: OpenLibraryCandidate[] = [];
    const seen = new Set<string>();
    for (const value of record.docs) {
      const candidate = asRecord(value);
      if (!candidate) continue;
      const rawWorkId = candidate.key ?? candidate.workId;
      if (typeof rawWorkId !== 'string') continue;
      let workId: string;
      try {
        workId = normalizeOpenLibraryWorkId(rawWorkId);
      } catch {
        continue;
      }
      if (seen.has(workId)) continue;
      try {
        const metadata = parseMetadata(candidate, workId, this.coversBaseUrl, [], true);
        seen.add(workId);
        candidates.push(metadata);
      } catch (error) {
        if (!(error instanceof OpenLibraryError) || error.code !== 'malformed_response') throw error;
      }
    }
    if (candidates.length === 0) {
      if (Number(record.numFound ?? 0) === 0) {
        throw new OpenLibraryError('not_found', 'Open Library found no matching works', false, 404);
      }
      return malformed('Open Library search response contained no usable works');
    }
    return candidates;
  }

  private readCache(workId: string): CacheEntry | null {
    const row = this.db.prepare(LIBRARY_SQL.selectOpenLibraryCache).get(workId) as CacheRow | undefined;
    return this.readCacheRow(row);
  }

  private readCaches(): CacheEntry[] {
    // ponytail: O(n) local-cache scan; add lookup-key columns if cache size makes it measurable.
    // SAFETY: DatabaseSync returns rows matching the cache SELECT columns.
    const rows = this.db.prepare(LIBRARY_SQL.selectOpenLibraryCaches).all() as unknown as CacheRow[];
    return rows.flatMap((row) => {
      const entry = this.readCacheRow(row);
      return entry ? [entry] : [];
    });
  }

  private findCachedByIsbn(isbn: string): CacheEntry[] {
    return this.readCaches().filter((entry) => entry.metadata.identifiers.some((identifier) => identifier.value === isbn));
  }

  private findCachedByTitleAuthor(title: string, author: string): CacheEntry[] {
    const normalizedTitle = normalizeName(title);
    const normalizedAuthor = normalizeName(author);
    return this.readCaches().filter((entry) => {
      return normalizeName(entry.metadata.title) === normalizedTitle
        && normalizeName(entry.metadata.author) === normalizedAuthor;
    });
  }

  private readCacheRow(row: CacheRow | undefined): CacheEntry | null {
    if (!row || typeof row.work_id !== 'string' || Number(row.payload_version) !== CACHE_PAYLOAD_VERSION) return null;
    const retrievedAt = safeDate(row.retrieved_at);
    if (retrievedAt === null || typeof row.payload !== 'string') return null;
    try {
      const payload = JSON.parse(row.payload) as unknown;
      const payloadRecord = asRecord(payload);
      if (!payloadRecord || typeof payloadRecord.workId !== 'string') return null;
      const metadata = parseMetadata(payload, row.work_id, this.coversBaseUrl);
      return { metadata, retrievedAt };
    } catch {
      return null;
    }
  }

  private isFresh(cache: CacheEntry): boolean {
    return this.nowMillis() - cache.retrievedAt < CACHE_MAX_AGE_MS;
  }

  private nowMillis(): number {
    const value = this.now();
    const milliseconds = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(milliseconds)) throw new ValidationError('Open Library clock must return a valid time');
    return milliseconds;
  }

  private writeCache(metadata: OpenLibraryMetadata): void {
    const retrievedAt = new Date(this.nowMillis()).toISOString();
    transaction(this.db, () => {
      this.db.prepare(LIBRARY_SQL.upsertOpenLibraryCache).run(
        metadata.workId,
        CACHE_PAYLOAD_VERSION,
        JSON.stringify(metadata),
        retrievedAt,
      );
    });
  }
}
