import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDatabase, openDatabase, type Database } from '../src/db.js';
import { LibraryRepository } from '../src/library.js';
import { ConversationRegistry } from '../src/conversations.js';
import { acceptProposal, createProposal, listPendingProposals, rejectProposal, type Proposal } from '../src/proposals.js';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';

interface Fixture {
  root: string;
  db: Database;
  library: LibraryRepository;
  registry: ConversationRegistry;
  conversationId: number;
  bookId: number;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'book-explorer-proposals-'));
  const sessions = join(root, 'sessions');
  mkdirSync(sessions, { mode: 0o700 });
  const db = openDatabase(join(root, 'library.sqlite'));
  const library = new LibraryRepository(db);
  const registry = new ConversationRegistry(db, { cwd: root, sessionDir: sessions });
  const conversationId = registry.create('Approval queue').id;
  const bookId = library.createOrFindBook({ title: 'The Dispossessed', author: 'Ursula K. Le Guin' }).id;
  return { root, db, library, registry, conversationId, bookId };
}

function dispose(item: Fixture): void {
  item.registry.close();
  closeDatabase(item.db);
  rmSync(item.root, { recursive: true, force: true });
}

async function proposal(item: Fixture, value: unknown = 'read'): Promise<Proposal> {
  return createProposal(item.registry, item.conversationId, {
    requestId: 'request-123',
    bookId: item.bookId,
    kind: 'status',
    value,
    semanticSlot: 'reading-status',
    explanation: 'The user explicitly said they finished it.',
  });
}

test('creates deterministic proposals and deduplicates repeated calls', async () => {
  const item = fixture();
  try {
    const first = await proposal(item);
    const second = await proposal(item, 'interested');
    assert.equal(second.id, first.id);
    assert.equal((await listPendingProposals(item.registry, item.conversationId)).length, 1);
    assert.equal(item.library.getBook(item.bookId)?.status, 'recommended');
  } finally {
    dispose(item);
  }
});

test('accepts an edited value through applying and terminal accepted entries', async () => {
  const item = fixture();
  try {
    const created = await proposal(item);
    const accepted = await acceptProposal(
      item.registry,
      item.library,
      item.conversationId,
      created.id,
      'reading',
    );
    assert.equal(accepted.state, 'accepted');
    assert.equal(item.library.getBook(item.bookId)?.status, 'reading');
    assert.deepEqual(await listPendingProposals(item.registry, item.conversationId), []);
    const entries = await item.registry.withConversation(item.conversationId, (manager: SessionManager) => manager.getEntries());
    const decisions = entries.filter((entry: SessionEntry) => entry.type === 'custom' && entry.customType === 'book-explorer-proposal-decision');
    assert.deepEqual(decisions.map((entry: SessionEntry) => entry.type === 'custom' ? entry.data : undefined), [
      { proposalId: created.id, state: 'applying', value: 'reading' },
      { proposalId: created.id, state: 'accepted', value: 'reading' },
    ]);
  } finally {
    dispose(item);
  }
});

test('accepts a route-shaped edited payload', async () => {
  const item = fixture();
  try {
    const created = await proposal(item);
    const accepted = await acceptProposal(
      item.registry,
      item.library,
      item.conversationId,
      created.id,
      { value: 'reading' },
    );
    assert.equal(accepted.value, 'reading');
    assert.equal(item.library.getBook(item.bookId)?.status, 'reading');
  } finally {
    dispose(item);
  }
});

test('reapplies an applying proposal after a crash before its database effect', async () => {
  const item = fixture();
  try {
    const created = await proposal(item);
    await item.registry.withConversation(item.conversationId, (manager: SessionManager) => {
      manager.appendCustomEntry('book-explorer-proposal-decision', {
        proposalId: created.id,
        state: 'applying',
        value: 'read',
      });
    });
    assert.equal((await listPendingProposals(item.registry, item.conversationId))[0]?.state, 'completion-required');
    await acceptProposal(item.registry, item.library, item.conversationId, created.id);
    assert.equal(item.library.getBook(item.bookId)?.status, 'read');
    assert.equal((await listPendingProposals(item.registry, item.conversationId)).length, 0);
  } finally {
    dispose(item);
  }
});

test('freezes the first applying value when a retry supplies a different edit', async () => {
  const item = fixture();
  try {
    const created = await proposal(item);
    await item.registry.withConversation(item.conversationId, (manager: SessionManager) => {
      manager.appendCustomEntry('book-explorer-proposal-decision', {
        proposalId: created.id,
        state: 'applying',
        value: 'read',
      });
    });

    const accepted = await acceptProposal(
      item.registry,
      item.library,
      item.conversationId,
      created.id,
      'abandoned',
    );

    assert.equal(accepted.value, 'read');
    assert.equal(item.library.getBook(item.bookId)?.status, 'read');
    const entries = await item.registry.withConversation(item.conversationId, (manager: SessionManager) => manager.getEntries());
    const decisions = entries.filter((entry: SessionEntry) => entry.type === 'custom' && entry.customType === 'book-explorer-proposal-decision');
    assert.deepEqual(decisions.map((entry: SessionEntry) => entry.type === 'custom' ? entry.data : undefined), [
      { proposalId: created.id, state: 'applying', value: 'read' },
      { proposalId: created.id, state: 'accepted', value: 'read' },
    ]);
  } finally {
    dispose(item);
  }
});

test('recovery keeps a persisted note aligned with its first applying value', async () => {
  const item = fixture();
  try {
    const created = await createProposal(item.registry, item.conversationId, {
      requestId: 'request-note-recovery',
      bookId: item.bookId,
      kind: 'note',
      value: 'Original opinion.',
      semanticSlot: 'opinion',
      explanation: 'The user shared an opinion.',
    });
    await item.registry.withConversation(item.conversationId, (manager: SessionManager) => {
      manager.appendCustomEntry('book-explorer-proposal-decision', {
        proposalId: created.id,
        state: 'applying',
        value: 'Original opinion.',
      });
    });
    item.library.addNote(item.bookId, 'Original opinion.', item.conversationId, created.id);

    const accepted = await acceptProposal(
      item.registry,
      item.library,
      item.conversationId,
      created.id,
      'Changed retry opinion.',
    );

    assert.equal(accepted.value, 'Original opinion.');
    assert.equal(accepted.note?.note, 'Original opinion.');
    const entries = await item.registry.withConversation(item.conversationId, (manager: SessionManager) => manager.getEntries());
    const terminal = entries.filter((entry: SessionEntry) => entry.type === 'custom' && entry.customType === 'book-explorer-proposal-decision').at(-1);
    assert.deepEqual(terminal?.type === 'custom' ? terminal.data : undefined, {
      proposalId: created.id,
      state: 'accepted',
      value: 'Original opinion.',
    });
  } finally {
    dispose(item);
  }
});

test('recovers when the terminal append fails after the SQLite commit', async () => {
  const item = fixture();
  try {
    const created = await proposal(item);
    const manager = await item.registry.withConversation(item.conversationId, (session: SessionManager) => session);
    const append = manager.appendCustomEntry.bind(manager);
    let failAfterCommit = true;
    manager.appendCustomEntry = ((customType: string, data?: unknown) => {
      const result = append(customType, data);
      if (failAfterCommit && customType === 'book-explorer-proposal-decision' && (data as { state?: string })?.state === 'accepted') {
        failAfterCommit = false;
        throw new Error('injected crash after SQLite commit');
      }
      return result;
    }) as SessionManager['appendCustomEntry'];
    await assert.rejects(
      acceptProposal(item.registry, item.library, item.conversationId, created.id),
      /injected crash after SQLite commit/,
    );
    assert.equal(item.library.getBook(item.bookId)?.status, 'read');
    const retry = await acceptProposal(item.registry, item.library, item.conversationId, created.id);
    assert.equal(retry.state, 'accepted');
    const entries = await item.registry.withConversation(item.conversationId, (session: SessionManager) => session.getEntries());
    assert.equal(entries.filter((entry: SessionEntry) => entry.type === 'custom' && entry.customType === 'book-explorer-proposal-decision').length, 2);
  } finally {
    dispose(item);
  }
});

test('applies rating and note proposals transactionally and idempotently', async () => {
  const item = fixture();
  try {
    const rating = await createProposal(item.registry, item.conversationId, {
      requestId: 'request-rating',
      bookId: item.bookId,
      kind: 'rating',
      value: 5,
      semanticSlot: 'favorite rating',
      explanation: 'The user rated the book five.',
    });
    await acceptProposal(item.registry, item.library, item.conversationId, rating.id);
    assert.equal(item.library.getBook(item.bookId)?.rating, 5);
    const note = await createProposal(item.registry, item.conversationId, {
      requestId: 'request-note',
      bookId: item.bookId,
      kind: 'note',
      value: 'A lasting favorite.',
      semanticSlot: 'opinion',
      explanation: 'The user called it a favorite.',
    });
    await acceptProposal(item.registry, item.library, item.conversationId, note.id);
    await acceptProposal(item.registry, item.library, item.conversationId, note.id);
    assert.equal(item.library.getBook(item.bookId)?.notes.filter((entry) => entry.sourceProposalId === note.id).length, 1);
  } finally {
    dispose(item);
  }
});

test('ignores malformed proposal entries during reconstruction', async () => {
  const item = fixture();
  try {
    await item.registry.withConversation(item.conversationId, (manager: SessionManager) => {
      manager.appendCustomEntry('book-explorer-proposed-change', {
        proposalId: 'bad',
        requestId: 'request-bad',
        bookId: item.bookId,
        kind: 'invalid',
        value: 'read',
        semanticSlot: 'status',
        explanation: 'bad',
      });
    });
    assert.deepEqual(await listPendingProposals(item.registry, item.conversationId), []);
  } finally {
    dispose(item);
  }
});

test('ignores persisted proposals whose ID does not match the deterministic hash', async () => {
  const item = fixture();
  try {
    await item.registry.withConversation(item.conversationId, (manager: SessionManager) => {
      manager.appendCustomEntry('book-explorer-proposed-change', {
        proposalId: 'not-the-deterministic-id',
        requestId: 'request-hash',
        bookId: item.bookId,
        kind: 'status',
        value: 'read',
        semanticSlot: 'reading-status',
        explanation: 'The user explicitly said they finished it.',
      });
    });
    assert.deepEqual(await listPendingProposals(item.registry, item.conversationId), []);
  } finally {
    dispose(item);
  }
});

test('rejects a proposal without changing approved library state', async () => {
  const item = fixture();
  try {
    const created = await proposal(item, 'abandoned');
    const rejected = await rejectProposal(item.registry, item.conversationId, created.id);
    assert.equal(rejected.state, 'rejected');
    assert.equal(item.library.getBook(item.bookId)?.status, 'recommended');
    assert.deepEqual(await listPendingProposals(item.registry, item.conversationId), []);
    const again = await rejectProposal(item.registry, item.conversationId, created.id);
    assert.equal(again.state, 'rejected');
  } finally {
    dispose(item);
  }
});

test('reconstructs pending proposals after restart and excludes them from approved state', async () => {
  const item = fixture();
  try {
    const created = await proposal(item, 'read');
    await item.registry.withConversation(item.conversationId, (manager: SessionManager) => {
      manager.appendCustomEntry('book-explorer-proposal-decision', {
        proposalId: created.id,
        state: 'applying',
        value: 'read',
      });
    });
    item.registry.close();
    const reopened = new ConversationRegistry(item.db, { cwd: item.root, sessionDir: join(item.root, 'sessions') });
    assert.equal((await listPendingProposals(reopened, item.conversationId))[0]?.state, 'completion-required');
    assert.equal(item.library.getBook(item.bookId)?.status, 'recommended');
    await acceptProposal(reopened, item.library, item.conversationId, created.id);
    assert.equal(item.library.getBook(item.bookId)?.status, 'read');
    reopened.close();
  } finally {
    dispose(item);
  }
});
