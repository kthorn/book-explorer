import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { closeDatabase, openDatabase, type Database } from '../src/db.js';
import { ConversationRegistry, ConversationBusyError } from '../src/conversations.js';

interface Fixture {
  root: string;
  sessions: string;
  db: Database;
  registry: ConversationRegistry;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'book-explorer-conversations-'));
  const sessions = join(root, 'sessions');
  mkdirSync(sessions, { mode: 0o700 });
  const db = openDatabase(join(root, 'library.sqlite'));
  return { root, sessions, db, registry: new ConversationRegistry(db, { cwd: root, sessionDir: sessions }) };
}

function dispose(item: Fixture): void {
  item.registry.close();
  closeDatabase(item.db);
  rmSync(item.root, { recursive: true, force: true });
}

function row(item: Fixture, sessionFilename: string): number {
  return Number(
    item.db.prepare(
      `INSERT INTO conversations (name, session_filename) VALUES (?, ?)`,
    ).run('Existing', sessionFilename).lastInsertRowid,
  );
}

test('creates and materializes a private session before publishing its conversation row', () => {
  const item = fixture();
  try {
    const conversation = item.registry.create('Reading list');
    const sessionPath = join(item.sessions, conversation.sessionFilename);
    assert.equal(existsSync(sessionPath), true);
    assert.equal(statSync(sessionPath).mode & 0o777, 0o600);
    const header = JSON.parse(readFileSync(sessionPath, 'utf8').split('\n')[0]) as { type: string; version: number; id: string };
    assert.equal(header.type, 'session');
    assert.equal(header.version, 3);
    assert.equal(typeof header.id, 'string');
    const count = item.db.prepare('SELECT COUNT(*) AS count FROM conversations').get() as { count: number };
    assert.equal(Number(count.count), 1);
  } finally {
    dispose(item);
  }
});

test('persists a custom entry immediately before any assistant output', async () => {
  const item = fixture();
  try {
    const conversation = item.registry.create('Durable');
    await item.registry.withConversation(conversation.id, (manager: SessionManager) => {
      manager.appendCustomEntry('book-explorer-request', { requestId: 'request-1' });
    });
    const contents = readFileSync(join(item.sessions, conversation.sessionFilename), 'utf8');
    assert.match(contents, /book-explorer-request/);
    assert.equal(contents.trim().split('\n').length, 2);
  } finally {
    dispose(item);
  }
});

test('atomically acquires one manager and serializes FIFO appends', async () => {
  const item = fixture();
  try {
    const conversation = item.registry.create('FIFO');
    const order: number[] = [];
    const first = item.registry.withConversation(conversation.id, async (manager: SessionManager) => {
      order.push(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      manager.appendCustomEntry('order', 1);
      order.push(2);
      return manager;
    });
    const second = item.registry.withConversation(conversation.id, (manager: SessionManager) => {
      order.push(3);
      manager.appendCustomEntry('order', 2);
      return manager;
    });
    const [firstManager, secondManager] = await Promise.all([first, second]);
    assert.equal(firstManager, secondManager);
    assert.deepEqual(order, [1, 2, 3]);
    assert.deepEqual(
      firstManager.getEntries().filter((entry: SessionEntry) => entry.type === 'custom').map((entry: SessionEntry) => entry.type === 'custom' ? entry.data : undefined),
      [1, 2],
    );
  } finally {
    dispose(item);
  }
});

test('retains the registered manager across archive and rename', async () => {
  const item = fixture();
  try {
    const conversation = item.registry.create('Before');
    const manager = await item.registry.withConversation(conversation.id, (session: SessionManager) => session);
    assert.equal(item.registry.archive(conversation.id, true)?.archived, true);
    assert.equal(item.registry.rename(conversation.id, 'After')?.name, 'After');
    const reopenedManager = await item.registry.withConversation(conversation.id, (session: SessionManager) => session);
    assert.equal(reopenedManager, manager);
    assert.equal(item.registry.get(conversation.id)?.archived, true);
  } finally {
    dispose(item);
  }
});

test('rejects deletion while a turn or append is active', async () => {
  const item = fixture();
  try {
    const conversation = item.registry.create('Busy');
    let release!: () => void;
    const active = item.registry.withConversation(conversation.id, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.throws(() => item.registry.delete(conversation.id), ConversationBusyError);
    release();
    await active;
    assert.equal(item.registry.delete(conversation.id), true);
  } finally {
    dispose(item);
  }
});

test('restores a tombstone when its conversation row survives restart', () => {
  const item = fixture();
  try {
    const conversation = item.registry.create('Restore');
    const original = join(item.sessions, conversation.sessionFilename);
    const tombstone = `${original}.deleting`;
    item.registry.close();
    renameSync(original, tombstone);
    const reopened = new ConversationRegistry(item.db, { cwd: item.root, sessionDir: item.sessions });
    assert.equal(existsSync(original), true);
    assert.equal(existsSync(tombstone), false);
    assert.equal(reopened.get(conversation.id)?.id, conversation.id);
    reopened.close();
  } finally {
    dispose(item);
  }
});

test('removes a tombstone and orphan session when no row references them', () => {
  const item = fixture();
  try {
    const conversation = item.registry.create('Delete');
    const referenced = join(item.sessions, conversation.sessionFilename);
    const orphan = join(item.sessions, 'orphan.jsonl');
    const tombstone = `${referenced}.deleting`;
    item.registry.close();
    renameSync(referenced, tombstone);
    row(item, 'orphan.jsonl');
    item.db.prepare('DELETE FROM conversations WHERE name = ?').run('Existing');
    // The ordinary orphan is not referenced; the tombstone is not referenced either.
    writeSessionHeader(orphan, item.root);
    const reopened = new ConversationRegistry(item.db, { cwd: item.root, sessionDir: item.sessions });
    assert.equal(existsSync(tombstone), false);
    assert.equal(existsSync(orphan), false);
    reopened.close();
  } finally {
    dispose(item);
  }
});

test('fails startup for a missing or corrupt referenced file', () => {
  const missing = fixture();
  try {
    row(missing, 'missing.jsonl');
    missing.registry.close();
    assert.throws(
      () => new ConversationRegistry(missing.db, { cwd: missing.root, sessionDir: missing.sessions }),
      /data recovery|missing|session/i,
    );
  } finally {
    dispose(missing);
  }

  const corrupt = fixture();
  try {
    const path = join(corrupt.sessions, 'corrupt.jsonl');
    writeFile(path, '{not-json}\n');
    row(corrupt, 'corrupt.jsonl');
    corrupt.registry.close();
    assert.throws(
      () => new ConversationRegistry(corrupt.db, { cwd: corrupt.root, sessionDir: corrupt.sessions }),
      /data recovery|valid|session/i,
    );
  } finally {
    dispose(corrupt);
  }
});

test('rejects traversal and symlink escape session paths', () => {
  const traversal = fixture();
  try {
    row(traversal, '../outside.jsonl');
    traversal.registry.close();
    assert.throws(
      () => new ConversationRegistry(traversal.db, { cwd: traversal.root, sessionDir: traversal.sessions }),
      /session path|boundary|recovery/i,
    );
  } finally {
    dispose(traversal);
  }

  const symlink = fixture();
  try {
    const outside = join(symlink.root, 'outside.jsonl');
    writeSessionHeader(outside, symlink.root);
    symlinkSync(outside, join(symlink.sessions, 'linked.jsonl'));
    row(symlink, 'linked.jsonl');
    symlink.registry.close();
    assert.throws(
      () => new ConversationRegistry(symlink.db, { cwd: symlink.root, sessionDir: symlink.sessions }),
      /boundary|recovery|session path/i,
    );
  } finally {
    dispose(symlink);
  }
});

test('reopens a persisted conversation and keeps later custom appends', async () => {
  const item = fixture();
  try {
    const conversation = item.registry.create('Restart');
    await item.registry.withConversation(conversation.id, (manager: SessionManager) => {
      manager.appendCustomEntry('restart-marker', { ok: true });
    });
    item.registry.close();
    const reopened = new ConversationRegistry(item.db, { cwd: item.root, sessionDir: item.sessions });
    const entries = await reopened.withConversation(conversation.id, (manager: SessionManager) => manager.getEntries());
    assert.equal(entries.some((entry: SessionEntry) => entry.type === 'custom' && entry.customType === 'restart-marker'), true);
    reopened.close();
  } finally {
    dispose(item);
  }
});

test('restores the exact manager after SQLite deletion failure and permits a later append', async () => {
  const item = fixture();
  try {
    item.registry.close();
    let fail = false;
    let acquisitionDuringDelete: Promise<unknown> | undefined;
    let conversationId = 0;
    let failingRegistry!: ConversationRegistry;
    const failingDb = new Proxy(item.db, {
      get(target, property, receiver) {
        if (property === 'exec' || property === 'close') return target[property].bind(target);
        if (property !== 'prepare') return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!/DELETE FROM conversations/.test(sql)) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== 'run' || !fail) return Reflect.get(statementTarget, statementProperty, statementReceiver);
              return () => {
                acquisitionDuringDelete = failingRegistry.withConversation(conversationId, (session: SessionManager) => session);
                fail = false;
                throw new Error('injected SQLite deletion failure');
              };
            },
          });
        };
      },
    }) as unknown as Database;
    failingRegistry = new ConversationRegistry(failingDb, { cwd: item.root, sessionDir: item.sessions });
    const conversation = failingRegistry.create('Rollback');
    conversationId = conversation.id;
    const original = join(item.sessions, conversation.sessionFilename);
    const manager = await failingRegistry.withConversation(conversation.id, (session: SessionManager) => session);
    fail = true;
    assert.throws(() => failingRegistry.delete(conversation.id), /injected SQLite deletion failure/);
    assert.ok(acquisitionDuringDelete);
    await assert.rejects(acquisitionDuringDelete, ConversationBusyError);
    assert.equal(existsSync(original), true);
    assert.equal(existsSync(`${original}.deleting`), false);
    const republished = await failingRegistry.withConversation(conversation.id, (session: SessionManager) => session);
    assert.equal(republished, manager);
    await failingRegistry.withConversation(conversation.id, (session: SessionManager) => {
      session.appendCustomEntry('after-rollback', { ok: true });
    });
    assert.match(readFileSync(original, 'utf8'), /after-rollback/);
    failingRegistry.close();
  } finally {
    dispose(item);
  }
});

function writeSessionHeader(path: string, cwd: string): void {
  const manager = SessionManager.create(cwd, undefined);
  const header = manager.getHeader();
  assert.ok(header);
  writeFile(path, `${JSON.stringify(header)}\n`);
}

function writeFile(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
}
