import { createHash } from 'node:crypto';

import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { normalizeName, READING_STATUSES, type ReadingStatus, ValidationError } from './normalize.js';
import type { Conversation } from './conversations.js';
import type { BookNote } from './library.js';

export const PROPOSAL_CUSTOM_TYPE = 'book-explorer-proposed-change';
export const PROPOSAL_DECISION_CUSTOM_TYPE = 'book-explorer-proposal-decision';

export const PROPOSAL_KINDS = ['status', 'rating', 'note'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export type ProposalValue = ReadingStatus | number | string;
export type ProposalState = 'pending' | 'completion-required';

export interface CreateProposalInput {
  requestId: string;
  bookId: number;
  kind: ProposalKind;
  value: unknown;
  semanticSlot: string;
  explanation: string;
}

export interface Proposal {
  id: string;
  proposalId: string;
  conversationId: number;
  requestId: string;
  bookId: number;
  kind: ProposalKind;
  value: ProposalValue;
  semanticSlot: string;
  explanation: string;
  createdAt?: string;
}

export interface PendingProposal extends Proposal {
  state: ProposalState;
}

export type ProposalDecisionState = 'applying' | 'accepted' | 'rejected';

export interface ProposalDecision {
  proposalId: string;
  state: ProposalDecisionState;
  value?: ProposalValue;
}

export interface ProposalResult {
  proposalId: string;
  state: 'accepted' | 'rejected';
  value?: ProposalValue;
  bookId?: number;
  kind?: ProposalKind;
  note?: BookNote;
}

export interface ProposalSession {
  getEntries(): SessionEntry[];
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface ProposalRegistry {
  withConversation<T>(
    conversationId: number,
    fn: (manager: ProposalSession, conversation?: Conversation) => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface ProposalBook {
  notes: BookNote[];
}

export interface ProposalLibrary {
  getBook?: (bookId: number) => ProposalBook | null;
  updateBook(bookId: number, input: { status?: ReadingStatus; rating?: number }, owner?: 'user'): object | null;
  addNote?: (bookId: number, note: string, sourceConversationId?: number | null, sourceProposalId?: string | null) => BookNote;
}

export class ProposalNotFoundError extends Error {
  readonly code = 'proposal_not_found';

  constructor(proposalId: string) {
    super(`Proposal ${proposalId} was not found`);
    this.name = 'ProposalNotFoundError';
  }
}

export class ProposalAlreadyDecidedError extends Error {
  readonly code = 'proposal_already_decided';

  constructor(proposalId: string, state: ProposalDecisionState) {
    super(`Proposal ${proposalId} already has a ${state} decision`);
    this.name = 'ProposalAlreadyDecidedError';
  }
}

function registryLike(value: unknown): value is ProposalRegistry {
  return Boolean(value && typeof (value as { withConversation?: unknown }).withConversation === 'function');
}

function libraryLike(value: unknown): value is ProposalLibrary {
  return Boolean(value && typeof (value as { updateBook?: unknown }).updateBook === 'function');
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
  const text = value.trim();
  if (!text) throw new ValidationError(`${label} must not be empty`);
  if (text.length > maximum) throw new ValidationError(`${label} must be at most ${maximum} characters`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new ValidationError(`${label} must be a positive integer`);
  return Number(value);
}

function normalizeProposalKind(value: unknown): ProposalKind {
  if (typeof value !== 'string' || !(PROPOSAL_KINDS as readonly string[]).includes(value)) {
    throw new ValidationError('Proposal kind must be status, rating, or note');
  }
  return value as ProposalKind;
}

function normalizeProposalValue(kind: ProposalKind, value: unknown): ProposalValue {
  if (kind === 'status') {
    if (typeof value !== 'string' || !(READING_STATUSES as readonly string[]).includes(value)) {
      throw new ValidationError('Proposal status must be a valid reading status');
    }
    return value as ReadingStatus;
  }
  if (kind === 'rating') {
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 5) {
      throw new ValidationError('Proposal rating must be an integer from 1 through 5');
    }
    return Number(value);
  }
  return requiredText(value, 'Proposal note', 4000);
}

function proposalInput(input: CreateProposalInput): {
  requestId: string;
  bookId: number;
  kind: ProposalKind;
  value: ProposalValue;
  semanticSlot: string;
  explanation: string;
} {
  if (!input || typeof input !== 'object') throw new ValidationError('Proposal must be an object');
  const kind = normalizeProposalKind(input.kind);
  return {
    requestId: requiredText(input.requestId, 'Request ID', 200),
    bookId: positiveInteger(input.bookId, 'Book ID'),
    kind,
    value: normalizeProposalValue(kind, input.value),
    semanticSlot: requiredText(input.semanticSlot, 'Semantic slot', 100),
    explanation: requiredText(input.explanation, 'Proposal explanation', 2000),
  };
}

export function deterministicProposalId(
  requestId: string,
  kind: ProposalKind,
  bookId: number,
  semanticSlot: string,
): string {
  const normalizedTarget = String(positiveInteger(bookId, 'Book ID'));
  const normalizedSlot = normalizeName(requiredText(semanticSlot, 'Semantic slot', 100));
  return createHash('sha256')
    .update(JSON.stringify([requiredText(requestId, 'Request ID', 200), kind, normalizedTarget, normalizedSlot]))
    .digest('hex');
}

function isCustomEntry(entry: SessionEntry, customType: string): entry is Extract<SessionEntry, { type: 'custom' }> {
  return entry.type === 'custom' && entry.customType === customType;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function proposalFromEntry(entry: Extract<SessionEntry, { type: 'custom' }>, conversationId: number): Proposal | null {
  const data = record(entry.data);
  if (!data || typeof data.proposalId !== 'string' || typeof data.requestId !== 'string') return null;
  if (!Number.isSafeInteger(data.bookId) || typeof data.kind !== 'string' || typeof data.semanticSlot !== 'string' || typeof data.explanation !== 'string') return null;
  let proposalId: string;
  let requestId: string;
  let semanticSlot: string;
  let explanation: string;
  let kind: ProposalKind;
  let value: ProposalValue;
  try {
    proposalId = requiredText(data.proposalId, 'Proposal ID', 200);
    requestId = requiredText(data.requestId, 'Request ID', 200);
    semanticSlot = requiredText(data.semanticSlot, 'Semantic slot', 100);
    explanation = requiredText(data.explanation, 'Proposal explanation', 2000);
    kind = normalizeProposalKind(data.kind);
    value = normalizeProposalValue(kind, data.value);
    positiveInteger(data.bookId, 'Book ID');
  } catch {
    return null;
  }
  return {
    id: proposalId,
    proposalId,
    conversationId,
    requestId,
    bookId: Number(data.bookId),
    kind,
    value,
    semanticSlot,
    explanation,
    createdAt: entry.timestamp,
  };
}

function decisionFromEntry(entry: Extract<SessionEntry, { type: 'custom' }>): ProposalDecision | null {
  const data = record(entry.data);
  if (!data || typeof data.proposalId !== 'string' || typeof data.state !== 'string') return null;
  if (data.state !== 'applying' && data.state !== 'accepted' && data.state !== 'rejected') return null;
  let value: ProposalValue | undefined;
  if (data.value !== undefined) {
    if (typeof data.value === 'string' || typeof data.value === 'number') value = data.value as ProposalValue;
  }
  return { proposalId: data.proposalId, state: data.state, value };
}

function inspectEntries(entries: SessionEntry[], conversationId: number): {
  proposals: Map<string, Proposal>;
  decisions: Map<string, ProposalDecision[]>;
} {
  const proposals = new Map<string, Proposal>();
  const decisions = new Map<string, ProposalDecision[]>();
  for (const entry of entries) {
    if (isCustomEntry(entry, PROPOSAL_CUSTOM_TYPE)) {
      const proposal = proposalFromEntry(entry, conversationId);
      if (proposal) proposals.set(proposal.proposalId, proposal);
    } else if (isCustomEntry(entry, PROPOSAL_DECISION_CUSTOM_TYPE)) {
      const decision = decisionFromEntry(entry);
      if (decision) decisions.set(decision.proposalId, [...(decisions.get(decision.proposalId) ?? []), decision]);
    }
  }
  return { proposals, decisions };
}

function terminalDecision(decisions: ProposalDecision[] | undefined): ProposalDecision | undefined {
  if (!decisions) return undefined;
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    if (decisions[index].state === 'accepted' || decisions[index].state === 'rejected') return decisions[index];
  }
  return undefined;
}

function latestApplying(decisions: ProposalDecision[] | undefined): ProposalDecision | undefined {
  if (!decisions) return undefined;
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    if (decisions[index].state === 'applying') return decisions[index];
  }
  return undefined;
}

function pendingFromEntries(manager: ProposalSession, conversation: Conversation): PendingProposal[] {
  const { proposals, decisions } = inspectEntries(manager.getEntries(), conversation.id);
  const pending: PendingProposal[] = [];
  for (const proposal of proposals.values()) {
    const proposalDecisions = decisions.get(proposal.proposalId);
    if (terminalDecision(proposalDecisions)) continue;
    pending.push({
      ...proposal,
      state: latestApplying(proposalDecisions) ? 'completion-required' : 'pending',
    });
  }
  return pending;
}

export function createProposal(
  registry: ProposalRegistry,
  conversationId: number,
  input: CreateProposalInput,
): Promise<Proposal>;
export function createProposal(
  conversationId: number,
  registry: ProposalRegistry,
  input: CreateProposalInput,
): Promise<Proposal>;
export function createProposal(
  first: ProposalRegistry | number,
  second: ProposalRegistry | number,
  input: CreateProposalInput,
): Promise<Proposal> {
  const registry = registryLike(first) ? first : second;
  const conversationId = typeof first === 'number' ? first : second;
  if (!registryLike(registry) || typeof conversationId !== 'number') return Promise.reject(new ValidationError('Invalid proposal registry arguments'));
  const normalized = proposalInput(input);
  const proposalId = deterministicProposalId(
    normalized.requestId,
    normalized.kind,
    normalized.bookId,
    normalized.semanticSlot,
  );
  return registry.withConversation(conversationId, (manager, conversation) => {
    const activeConversationId = conversation?.id ?? conversationId;
    const { proposals } = inspectEntries(manager.getEntries(), activeConversationId);
    const existing = proposals.get(proposalId);
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    manager.appendCustomEntry(PROPOSAL_CUSTOM_TYPE, {
      proposalId,
      requestId: normalized.requestId,
      bookId: normalized.bookId,
      kind: normalized.kind,
      value: normalized.value,
      semanticSlot: normalized.semanticSlot,
      explanation: normalized.explanation,
    });
    return {
      id: proposalId,
      proposalId,
      conversationId: activeConversationId,
      ...normalized,
      createdAt: timestamp,
    };
  });
}

export const proposeChange = createProposal;

export function listPendingProposals(
  registry: ProposalRegistry,
  conversationId: number,
): Promise<PendingProposal[]>;
export function listPendingProposals(
  conversationId: number,
  registry: ProposalRegistry,
): Promise<PendingProposal[]>;
export function listPendingProposals(
  first: ProposalRegistry | number,
  second: ProposalRegistry | number,
): Promise<PendingProposal[]> {
  const registry = registryLike(first) ? first : second;
  const conversationId = typeof first === 'number' ? first : second;
  if (!registryLike(registry) || typeof conversationId !== 'number') return Promise.reject(new ValidationError('Invalid proposal registry arguments'));
  return registry.withConversation(conversationId, (manager, conversation) => {
    const activeConversation: Conversation = conversation ?? {
      id: conversationId,
      name: '',
      sessionFilename: '',
      createdAt: '',
      updatedAt: '',
      archived: false,
    };
    return pendingFromEntries(manager, activeConversation);
  });
}

interface AcceptanceArguments {
  registry: ProposalRegistry;
  library: ProposalLibrary;
  conversationId: number;
  proposalId: string;
  hasEditedValue: boolean;
  editedValue: unknown;
}

function acceptanceArguments(args: readonly unknown[]): AcceptanceArguments {
  const registry = args.find(registryLike);
  const library = args.find(libraryLike);
  const conversationId = args.find((value): value is number => typeof value === 'number');
  const proposalIndex = args.findIndex((value) => typeof value === 'string');
  if (!registry || !library || conversationId === undefined || proposalIndex < 0) {
    throw new ValidationError('Invalid proposal acceptance arguments');
  }
  const rawEditedValue = args.slice(proposalIndex + 1).find((value) => value !== library);
  const editedObject = record(rawEditedValue);
  const hasEditedValue = rawEditedValue !== undefined;
  return {
    registry,
    library,
    conversationId,
    proposalId: requiredText(args[proposalIndex], 'Proposal ID', 200),
    hasEditedValue,
    editedValue: editedObject && 'value' in editedObject ? editedObject.value : rawEditedValue,
  };
}

function applyProposal(
  library: ProposalLibrary,
  proposal: Proposal,
  value: ProposalValue,
): BookNote | undefined {
  if (proposal.kind === 'status') {
    if (!library.updateBook(proposal.bookId, { status: value as ReadingStatus })) {
      throw new ProposalNotFoundError(`book-${proposal.bookId}`);
    }
    return undefined;
  }
  if (proposal.kind === 'rating') {
    if (!library.updateBook(proposal.bookId, { rating: value as number })) {
      throw new ProposalNotFoundError(`book-${proposal.bookId}`);
    }
    return undefined;
  }
  if (!library.getBook || !library.addNote) throw new ValidationError('Note proposals require note-capable library methods');
  const book = library.getBook(proposal.bookId);
  if (!book) throw new ProposalNotFoundError(`book-${proposal.bookId}`);
  const existing = book.notes.find((note) => note.sourceProposalId === proposal.proposalId);
  if (existing) return existing;
  return library.addNote(proposal.bookId, value as string, proposal.conversationId, proposal.proposalId);
}

export function acceptProposal(
  registry: ProposalRegistry,
  library: ProposalLibrary,
  conversationId: number,
  proposalId: string,
  editedValue?: unknown,
): Promise<ProposalResult>;
export function acceptProposal(
  registry: ProposalRegistry,
  conversationId: number,
  proposalId: string,
  editedValue: unknown,
  library: ProposalLibrary,
): Promise<ProposalResult>;
export function acceptProposal(...args: unknown[]): Promise<ProposalResult> {
  let parsed: AcceptanceArguments;
  try {
    parsed = acceptanceArguments(args);
  } catch (error) {
    return Promise.reject(error);
  }
  return parsed.registry.withConversation(parsed.conversationId, (manager, conversation) => {
    const activeConversationId = conversation?.id ?? parsed.conversationId;
    const { proposals, decisions } = inspectEntries(manager.getEntries(), activeConversationId);
    const proposal = proposals.get(parsed.proposalId);
    if (!proposal) throw new ProposalNotFoundError(parsed.proposalId);
    const proposalDecisions = decisions.get(proposal.proposalId);
    const terminal = terminalDecision(proposalDecisions);
    if (terminal) {
      if (terminal.state !== 'accepted') throw new ProposalAlreadyDecidedError(proposal.proposalId, terminal.state);
      return {
        proposalId: proposal.proposalId,
        state: 'accepted',
        value: terminal.value ?? proposal.value,
        bookId: proposal.bookId,
        kind: proposal.kind,
      };
    }

    const applying = latestApplying(proposalDecisions);
    const value = normalizeProposalValue(
      proposal.kind,
      parsed.hasEditedValue ? parsed.editedValue : applying?.value ?? proposal.value,
    );
    if (!applying || parsed.hasEditedValue) {
      manager.appendCustomEntry(PROPOSAL_DECISION_CUSTOM_TYPE, {
        proposalId: proposal.proposalId,
        state: 'applying',
        value,
      });
    }
    const note = applyProposal(parsed.library, proposal, value);
    manager.appendCustomEntry(PROPOSAL_DECISION_CUSTOM_TYPE, {
      proposalId: proposal.proposalId,
      state: 'accepted',
      value,
    });
    return {
      proposalId: proposal.proposalId,
      state: 'accepted',
      value,
      bookId: proposal.bookId,
      kind: proposal.kind,
      note,
    };
  });
}

export function rejectProposal(
  registry: ProposalRegistry,
  conversationId: number,
  proposalId: string,
): Promise<ProposalResult>;
export function rejectProposal(
  conversationId: number,
  registry: ProposalRegistry,
  proposalId: string,
): Promise<ProposalResult>;
export function rejectProposal(...args: unknown[]): Promise<ProposalResult> {
  const registry = args.find(registryLike);
  const conversationId = args.find((value): value is number => typeof value === 'number');
  const proposalIndex = args.findIndex((value) => typeof value === 'string');
  if (!registry || conversationId === undefined || proposalIndex < 0) return Promise.reject(new ValidationError('Invalid proposal rejection arguments'));
  const proposalId = requiredText(args[proposalIndex], 'Proposal ID', 200);
  return registry.withConversation(conversationId, (manager, conversation) => {
    const activeConversationId = conversation?.id ?? conversationId;
    const { proposals, decisions } = inspectEntries(manager.getEntries(), activeConversationId);
    const proposal = proposals.get(proposalId);
    if (!proposal) throw new ProposalNotFoundError(proposalId);
    const proposalDecisions = decisions.get(proposalId);
    const terminal = terminalDecision(proposalDecisions);
    if (terminal) {
      if (terminal.state !== 'rejected') throw new ProposalAlreadyDecidedError(proposalId, terminal.state);
      return { proposalId, state: 'rejected', value: proposal.value, bookId: proposal.bookId, kind: proposal.kind };
    }
    if (latestApplying(proposalDecisions)) throw new ProposalAlreadyDecidedError(proposalId, 'applying');
    manager.appendCustomEntry(PROPOSAL_DECISION_CUSTOM_TYPE, { proposalId, state: 'rejected' });
    return { proposalId, state: 'rejected', value: proposal.value, bookId: proposal.bookId, kind: proposal.kind };
  });
}

export function pendingProposalsFromEntries(entries: SessionEntry[], conversationId: number): PendingProposal[] {
  const manager: ProposalSession = {
    getEntries: () => entries,
    appendCustomEntry: () => '',
  };
  const conversation: Conversation = {
    id: conversationId,
    name: '',
    sessionFilename: '',
    createdAt: '',
    updatedAt: '',
    archived: false,
  };
  return pendingFromEntries(manager, conversation);
}
