import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { SessionManager, type SessionHeader } from '@earendil-works/pi-coding-agent';
import { transaction, type Database } from './db.js';

export interface Conversation {
  id: number;
  name: string;
  sessionFilename: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface ConversationListOptions {
  archived?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateConversationInput {
  name: string;
}

export interface ConversationRegistryOptions {
  cwd?: string;
  sessionDir?: string;
  appCwd?: string;
  appSessionDir?: string;
  managerFactory?: SessionManagerFactory;
  sessionManagerFactory?: SessionManagerFactory;
}

export interface ConversationRegistryConfig extends ConversationRegistryOptions {
  db: Database;
}

export interface SessionManagerFactory {
  create(cwd: string, sessionDir: string): SessionManager;
  open(path: string, sessionDir: string, cwd: string): SessionManager;
}

export class ConversationNotFoundError extends Error {
  readonly code = 'conversation_not_found';

  constructor(id: number) {
    super(`Conversation ${id} was not found`);
    this.name = 'ConversationNotFoundError';
  }
}

export class ConversationBusyError extends Error {
  readonly code = 'conversation_busy';

  constructor(id: number) {
    super(`Conversation ${id} has an active turn or append`);
    this.name = 'ConversationBusyError';
  }
}

export class ConversationDataRecoveryError extends Error {
  readonly code = 'conversation_data_recovery';

  constructor(message: string) {
    super(`Conversation data recovery required: ${message}`);
    this.name = 'ConversationDataRecoveryError';
  }
}

export class ConversationPathError extends Error {
  readonly code = 'conversation_path_rejected';

  constructor(message: string) {
    super(`Conversation session path rejected: ${message}`);
    this.name = 'ConversationPathError';
  }
}

export class ConversationCreateError extends Error {
  readonly code = 'conversation_create_failed';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConversationCreateError';
  }
}

interface ConversationRow {
  id: unknown;
  name: unknown;
  session_filename: unknown;
  created_at: unknown;
  updated_at: unknown;
  archived: unknown;
}

interface ConversationState {
  conversation: Conversation;
  manager: SessionManager;
  sessionPath: string;
  chain: Promise<unknown>;
  queued: number;
  active: number;
  deleting: boolean;
}

const INSERT_CONVERSATION = `
  INSERT INTO conversations (name, session_filename)
  VALUES (?, ?)`;
const SELECT_CONVERSATION = `
  SELECT id, name, session_filename, created_at, updated_at, archived
  FROM conversations
  WHERE id = ?`;
const SELECT_CONVERSATIONS = `
  SELECT id, name, session_filename, created_at, updated_at, archived
  FROM conversations
  WHERE (? IS NULL OR archived = ?)
  ORDER BY id`;
const DELETE_CONVERSATION = 'DELETE FROM conversations WHERE id = ?';
const RESTORE_CONVERSATION = `
  INSERT INTO conversations
    (id, name, session_filename, created_at, updated_at, archived)
  VALUES (?, ?, ?, ?, ?, ?)`;

const DEFAULT_FACTORY: SessionManagerFactory = {
  create: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir),
  open: (path, sessionDir, cwd) => SessionManager.open(path, sessionDir, cwd),
};

function databaseLike(value: unknown): value is Database {
  return Boolean(value && typeof (value as { prepare?: unknown }).prepare === 'function');
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function conversationName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Conversation name must be a string');
  const name = value.trim();
  if (!name) throw new TypeError('Conversation name must not be empty');
  if (name.length > 200) throw new TypeError('Conversation name must be at most 200 characters');
  return name;
}

function rowNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new ConversationDataRecoveryError(`invalid ${label}`);
  return number;
}

function rowString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ConversationDataRecoveryError(`invalid ${label}`);
  return value;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: rowNumber(row.id, 'conversation ID'),
    name: rowString(row.name, 'conversation name'),
    sessionFilename: rowString(row.session_filename, 'session filename'),
    createdAt: rowString(row.created_at, 'conversation creation time'),
    updatedAt: rowString(row.updated_at, 'conversation update time'),
    archived: Number(row.archived) === 1,
  };
}

function normalizedRelativePath(value: string): string {
  return value.split(sep).join('/');
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === '..');
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
}

function firstSessionHeader(path: string): SessionHeader {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConversationDataRecoveryError(`cannot read referenced session file ${path}: ${String(error)}`);
  }
  if (!content.trim()) throw new ConversationDataRecoveryError(`referenced session file is empty: ${path}`);
  const line = content.split(/\r?\n/u).find((candidate) => candidate.trim());
  if (!line) throw new ConversationDataRecoveryError(`referenced session file has no header: ${path}`);
  let header: unknown;
  try {
    header = JSON.parse(line);
  } catch {
    throw new ConversationDataRecoveryError(`referenced session file has an invalid header: ${path}`);
  }
  if (!header || typeof header !== 'object' || (header as { type?: unknown }).type !== 'session' || typeof (header as { id?: unknown }).id !== 'string') {
    throw new ConversationDataRecoveryError(`referenced session file has an invalid header: ${path}`);
  }
  return header as SessionHeader;
}

function writeHeader(path: string, header: SessionHeader): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(header)}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function fileExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class ConversationRegistry {
  private readonly db: Database;
  private readonly cwd: string;
  private readonly sessionDir: string;
  private readonly realSessionDir: string;
  private readonly factory: SessionManagerFactory;
  private readonly states = new Map<number, ConversationState>();
  private readonly managers = new Map<number, SessionManager>();
  private closed = false;

  constructor(db: Database, options?: ConversationRegistryOptions);
  constructor(db: Database, sessionDir: string, cwd?: string);
  constructor(config: ConversationRegistryConfig);
  constructor(
    dbOrConfig: Database | ConversationRegistryConfig,
    optionsOrSessionDir: ConversationRegistryOptions | string = {},
    cwd?: string,
  ) {
    const options = typeof optionsOrSessionDir === 'string'
      ? { sessionDir: optionsOrSessionDir, cwd }
      : optionsOrSessionDir;
    const config = databaseLike(dbOrConfig)
      ? { ...options, db: dbOrConfig }
      : dbOrConfig;
    this.db = config.db;
    this.cwd = resolve(config.cwd ?? config.appCwd ?? process.cwd());
    this.sessionDir = resolve(config.sessionDir ?? config.appSessionDir ?? join(this.cwd, 'sessions'));
    this.factory = config.managerFactory ?? config.sessionManagerFactory ?? DEFAULT_FACTORY;

    mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    this.realSessionDir = this.realPath(this.sessionDir, 'session directory');
    this.recoverSessionFiles();
    this.openExistingConversations();
  }

  create(name: string | CreateConversationInput): Conversation {
    this.assertOpen();
    const conversationNameValue = conversationName(typeof name === 'string' ? name : name?.name);
    const manager = this.factory.create(this.cwd, this.sessionDir);
    const managerPath = manager.getSessionFile();
    const header = manager.getHeader();
    if (!managerPath || !header) {
      throw new ConversationCreateError('SessionManager did not provide a session file and header');
    }

    const sessionPath = this.creationPath(managerPath);
    const sessionFilename = normalizedRelativePath(relative(this.sessionDir, sessionPath));
    let materialized = false;
    try {
      writeHeader(sessionPath, header);
      materialized = true;
      manager.setSessionFile(sessionPath);
      const conversation = transaction(this.db, () => {
        const result = this.db.prepare(INSERT_CONVERSATION).run(conversationNameValue, sessionFilename);
        return this.getById(Number(result.lastInsertRowid)) as Conversation;
      });
      const state: ConversationState = {
        conversation,
        manager,
        sessionPath,
        chain: Promise.resolve(),
        queued: 0,
        active: 0,
        deleting: false,
      };
      this.states.set(conversation.id, state);
      this.managers.set(conversation.id, manager);
      return conversation;
    } catch (error) {
      if (materialized) {
        try {
          unlinkSync(sessionPath);
        } catch {
          // Preserve the operation's original error.
        }
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ConversationCreateError(`Session file already exists: ${sessionPath}`, { cause: error });
      }
      throw error;
    }
  }

  get(conversationId: number): Conversation | null {
    this.assertOpen();
    const id = positiveInteger(conversationId, 'Conversation ID');
    const state = this.states.get(id);
    if (state?.deleting) throw new ConversationBusyError(id);
    const conversation = this.getById(id);
    if (!conversation) return null;
    if (!state) this.publish(conversation);
    return conversation;
  }

  list(options: ConversationListOptions | boolean = {}): Conversation[] {
    this.assertOpen();
    if (typeof options === 'boolean') options = { archived: options };
    if (!options || typeof options !== 'object') throw new TypeError('Conversation list options must be an object');
    const archived = options.archived === undefined ? null : options.archived;
    if (archived !== null && typeof archived !== 'boolean') throw new TypeError('Archived must be a boolean');
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Limit must be an integer from 1 through 100');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Offset must be a non-negative integer');
    // SAFETY: DatabaseSync returns row objects whose columns match SELECT_CONVERSATIONS.
    const rows = this.db.prepare(SELECT_CONVERSATIONS).all(
      archived === null ? null : Number(archived),
      archived === null ? null : Number(archived),
    ) as unknown as ConversationRow[];
    return rows.slice(offset, offset + limit).map(mapConversation);
  }

  archive(conversationId: number, archived = true): Conversation | null {
    this.assertOpen();
    const id = positiveInteger(conversationId, 'Conversation ID');
    if (typeof archived !== 'boolean') throw new TypeError('Archived must be a boolean');
    if (this.states.get(id)?.deleting) throw new ConversationBusyError(id);
    return transaction(this.db, () => {
      const current = this.getById(id);
      if (!current) return null;
      this.db.prepare('UPDATE conversations SET archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Number(archived), id);
      const updated = this.getById(id);
      if (!updated) throw new ConversationDataRecoveryError(`conversation ${id} disappeared while archiving`);
      const state = this.states.get(id);
      if (state) state.conversation = updated;
      return updated;
    });
  }

  rename(conversationId: number, name: string | CreateConversationInput): Conversation | null {
    this.assertOpen();
    const id = positiveInteger(conversationId, 'Conversation ID');
    const value = conversationName(typeof name === 'string' ? name : name?.name);
    if (this.states.get(id)?.deleting) throw new ConversationBusyError(id);
    return transaction(this.db, () => {
      const current = this.getById(id);
      if (!current) return null;
      this.db.prepare('UPDATE conversations SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(value, id);
      const updated = this.getById(id);
      if (!updated) throw new ConversationDataRecoveryError(`conversation ${id} disappeared while renaming`);
      const state = this.states.get(id);
      if (state) state.conversation = updated;
      return updated;
    });
  }

  delete(conversationId: number): boolean {
    this.assertOpen();
    const id = positiveInteger(conversationId, 'Conversation ID');
    let state = this.states.get(id);
    const conversation = this.getById(id);
    if (!conversation) return false;
    if (!state) {
      this.publish(conversation);
      state = this.states.get(id);
    }
    if (!state) throw new ConversationDataRecoveryError(`conversation ${id} could not be opened`);
    if (state.deleting || state.queued > 0 || state.active > 0) throw new ConversationBusyError(id);

    state.deleting = true;
    this.managers.delete(id);
    let renamed = false;
    let rowDeleted = false;
    const tombstonePath = `${state.sessionPath}.deleting`;
    try {
      if (fileExists(tombstonePath)) throw new ConversationCreateError(`Deletion tombstone already exists: ${tombstonePath}`);
      renameSync(state.sessionPath, tombstonePath);
      renamed = true;
      transaction(this.db, () => {
        const result = this.db.prepare(DELETE_CONVERSATION).run(id);
        if (Number(result.changes) !== 1) throw new ConversationDataRecoveryError(`conversation ${id} disappeared while deleting`);
      });
      rowDeleted = true;
      unlinkSync(tombstonePath);
      this.states.delete(id);
      return true;
    } catch (error) {
      this.rollbackDeletion(state, conversation, tombstonePath, renamed, rowDeleted);
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.states.clear();
    this.managers.clear();
  }

  withConversation<T>(conversationId: number, fn: (manager: SessionManager, conversation: Conversation) => T | PromiseLike<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Conversation registry is closed'));
    const id = positiveInteger(conversationId, 'Conversation ID');
    let state = this.states.get(id);
    if (!state) {
      const conversation = this.getById(id);
      if (!conversation) return Promise.reject(new ConversationNotFoundError(id));
      try {
        this.publish(conversation);
      } catch (error) {
        return Promise.reject(error);
      }
      state = this.states.get(id);
    }
    if (!state || state.deleting || this.states.get(id) !== state) return Promise.reject(new ConversationBusyError(id));

    state.queued += 1;
    const previous = state.chain;
    const operation = previous.then(async () => {
      state!.queued -= 1;
      if (this.closed || state!.deleting || this.states.get(id) !== state || this.managerFor(id) !== state!.manager) {
        throw new ConversationBusyError(id);
      }
      state!.active += 1;
      try {
        return await fn(state!.manager, state!.conversation);
      } finally {
        state!.active -= 1;
      }
    });
    state.chain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** Append a custom JSONL entry through the conversation FIFO. */
  append(id: number, customType: string, data?: unknown): Promise<string> {
    return this.withConversation(id, (manager) => manager.appendCustomEntry(customType, data));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Conversation registry is closed');
  }

  private getById(id: number): Conversation | null {
    // SAFETY: DatabaseSync returns a row matching the selected conversation columns.
    const row = this.db.prepare(SELECT_CONVERSATION).get(id) as unknown as ConversationRow | undefined;
    return row ? mapConversation(row) : null;
  }

  private managerFor(id: number): SessionManager | undefined {
    return this.managers.get(id);
  }

  private publish(conversation: Conversation): SessionManager {
    const existing = this.states.get(conversation.id);
    if (existing) return existing.manager;
    const sessionPath = this.referencePath(conversation.sessionFilename);
    this.validateSessionFile(sessionPath);
    const manager = this.factory.open(sessionPath, this.sessionDir, this.cwd);
    if (!manager.getHeader()) throw new ConversationDataRecoveryError(`session manager loaded no header: ${sessionPath}`);
    this.states.set(conversation.id, {
      conversation,
      manager,
      sessionPath,
      chain: Promise.resolve(),
      queued: 0,
      active: 0,
      deleting: false,
    });
    this.managers.set(conversation.id, manager);
    return manager;
  }

  private openExistingConversations(): void {
    // SAFETY: DatabaseSync returns row objects whose columns match the SELECT list.
    const rows = this.db.prepare(`
      SELECT id, name, session_filename, created_at, updated_at, archived
      FROM conversations
      ORDER BY id`).all() as unknown as ConversationRow[];
    for (const row of rows) {
      const conversation = mapConversation(row);
      this.publish(conversation);
    }
  }

  private recoverSessionFiles(): void {
    // SAFETY: DatabaseSync returns the two columns selected by this query.
    const rows = this.db.prepare(`SELECT id, session_filename FROM conversations`).all() as unknown as Array<{ id: unknown; session_filename: unknown }>;
    const referenced = new Map<string, string>();
    for (const row of rows) {
      const filename = row.session_filename;
      if (typeof filename !== 'string') throw new ConversationDataRecoveryError(`conversation ${String(row.id)} has no session filename`);
      const path = this.referencePath(filename);
      const canonicalPath = this.canonicalPath(path);
      referenced.set(normalizedRelativePath(relative(this.realSessionDir, canonicalPath)), path);
    }

    for (const path of referenced.values()) {
      const tombstone = `${path}.deleting`;
      if (fileExists(tombstone)) {
        this.validateArtifactPath(tombstone);
        if (fileExists(path)) unlinkSync(tombstone);
        else renameSync(tombstone, path);
      }
    }
    this.removeOrphanSessionFiles(this.realSessionDir, referenced);
  }

  private removeOrphanSessionFiles(directory: string, referenced: ReadonlyMap<string, string>): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        this.removeOrphanSessionFiles(path, referenced);
        if (readdirSync(path).length === 0) rmdirSync(path);
        continue;
      }
      const relativeName = normalizedRelativePath(relative(this.realSessionDir, this.canonicalPath(path)));
      if (referenced.has(relativeName)) continue;
      if (entry.name.endsWith('.deleting')) {
        const originalName = entry.name.slice(0, -'.deleting'.length);
        const originalPath = join(directory, originalName);
        if (referenced.has(normalizedRelativePath(relative(this.realSessionDir, this.canonicalPath(originalPath))))) continue;
      }
      unlinkSync(path);
    }
  }

  private canonicalPath(path: string): string {
    try {
      return this.realPath(path, 'session artifact');
    } catch {
      return resolve(this.realSessionDir, relative(this.sessionDir, path));
    }
  }

  private referencePath(filename: string): string {
    if (!filename || isAbsolute(filename) || isWindowsAbsolute(filename) || hasParentTraversal(filename)) {
      throw new ConversationPathError(`unsafe relative filename ${JSON.stringify(filename)}`);
    }
    const candidate = resolve(this.sessionDir, filename);
    const lexicalRelative = relative(this.sessionDir, candidate);
    if (!lexicalRelative || lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
      throw new ConversationPathError(`filename escapes sessions directory: ${filename}`);
    }
    if (fileExists(candidate)) this.validateArtifactPath(candidate);
    else {
      const parent = resolve(candidate, '..');
      const realParent = this.realPath(parent, 'session file parent directory');
      if (!inside(this.realSessionDir, realParent) && realParent !== this.realSessionDir) {
        throw new ConversationPathError(`filename parent escapes sessions directory: ${filename}`);
      }
    }
    return candidate;
  }

  private creationPath(managerPath: string): string {
    if (isAbsolute(managerPath) || isWindowsAbsolute(managerPath)) {
      const candidate = resolve(managerPath);
      const parent = this.realPath(resolve(candidate, '..'), 'new session file parent directory');
      if (parent !== this.realSessionDir) throw new ConversationPathError('new session file must be directly in sessions directory');
      if (fileExists(candidate)) this.validateArtifactPath(candidate);
      return candidate;
    }
    return this.referencePath(managerPath);
  }

  private validateArtifactPath(path: string): void {
    let realPath: string;
    try {
      realPath = this.realPath(path, 'session artifact');
    } catch (error) {
      throw new ConversationPathError(String(error));
    }
    if (!inside(this.realSessionDir, realPath)) throw new ConversationPathError(`session artifact escapes sessions directory: ${path}`);
  }

  private validateSessionFile(path: string): void {
    this.validateArtifactPath(path);
    try {
      if (!statSync(path).isFile()) throw new Error('not a regular file');
    } catch (error) {
      throw new ConversationDataRecoveryError(`referenced session file is unavailable: ${path} (${String(error)})`);
    }
    firstSessionHeader(path);
  }

  private realPath(path: string, label: string): string {
    try {
      return resolve(realpathSync(path));
    } catch (error) {
      throw new ConversationDataRecoveryError(`cannot resolve ${label} ${path}: ${String(error)}`);
    }
  }

  private rollbackDeletion(
    state: ConversationState,
    conversation: Conversation,
    tombstonePath: string,
    renamed: boolean,
    rowDeleted: boolean,
  ): void {
    let rollbackError: unknown;
    try {
      if (rowDeleted) {
        transaction(this.db, () => {
          this.db.prepare(RESTORE_CONVERSATION).run(
            conversation.id,
            conversation.name,
            conversation.sessionFilename,
            conversation.createdAt,
            conversation.updatedAt,
            Number(conversation.archived),
          );
        });
      }
      if (renamed && fileExists(tombstonePath) && !fileExists(state.sessionPath)) renameSync(tombstonePath, state.sessionPath);
    } catch (error) {
      rollbackError = error;
    } finally {
      state.deleting = false;
      this.states.set(conversation.id, state);
      this.managers.set(conversation.id, state.manager);
    }
    if (rollbackError) {
      throw new ConversationDataRecoveryError(`deletion rollback failed: ${String(rollbackError)}`);
    }
  }
}

export function createConversationRegistry(db: Database, options?: ConversationRegistryOptions): ConversationRegistry {
  return new ConversationRegistry(db, options);
}