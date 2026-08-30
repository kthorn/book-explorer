import { randomUUID } from "node:crypto";

import type {
  AgentSessionEvent,
  ResourceLoader,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createTurnSession, type AgentRuntimeState } from "./agent-runtime.js";
import {
  ConversationBusyError,
  ConversationNotFoundError,
  type Conversation,
  type ConversationRegistry,
} from "./conversations.js";
import type { LibraryRepository } from "./library.js";
import type { ProposalRegistry, ProposalSession } from "./proposals.js";
import {
  createCitationCapture,
  type CapturedCitation,
  type CitationCapture,
} from "./search-guard.js";
import {
  createBookExplorerTools,
  type BookExplorerToolContext,
} from "./tools.js";

export type BrowserToolStatus = "started" | "updated" | "completed";

export interface BrowserTextDeltaEvent {
  type: "text_delta";
  delta: string;
}

export interface BrowserToolStatusEvent {
  type: "tool_status";
  toolCallId: string;
  toolName: string;
  status: BrowserToolStatus;
  isError?: boolean;
}

export interface BrowserCitationEvent {
  type: "citation";
  token: string;
  citation: CapturedCitation;
}

export interface BrowserCompleteEvent {
  type: "complete";
  incomplete: boolean;
}

export interface BrowserErrorEvent {
  type: "error";
  code: BrowserErrorCode;
  message: string;
  retryable: boolean;
  incomplete?: boolean;
}

export type BrowserErrorCode =
  | "global_busy"
  | "cancelled"
  | "authentication_error"
  | "quota_error"
  | "concurrency_error"
  | "search_error"
  | "internal_error";

export type BrowserStreamEvent =
  | BrowserTextDeltaEvent
  | BrowserToolStatusEvent
  | BrowserCitationEvent
  | BrowserCompleteEvent
  | BrowserErrorEvent;

export interface AgentSessionLike {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | PromiseLike<void>;
}

export interface TurnSessionLike {
  session: AgentSessionLike;
  loader: ResourceLoader;
}

export type TurnSessionFactory = (
  customTools: readonly ToolDefinition[],
  citationCapture: CitationCapture,
  sessionManager: SessionManager,
) => Promise<TurnSessionLike>;

export interface TurnSubmitInput {
  conversationId: number;
  text: string;
  retryRequestId?: string;
  signal?: AbortSignal;
}

export type BrowserStreamEmitter = (event: BrowserStreamEvent) => Promise<void>;

export interface TurnCoordinatorOptions {
  registry: ConversationRegistry;
  library: LibraryRepository;
  runtime: AgentRuntimeState;
  proposalRegistry?: BookExplorerToolContext["proposalRegistry"];
  toolsFactory?: (
    context: BookExplorerToolContext,
  ) => readonly ToolDefinition[];
  sessionFactory?: TurnSessionFactory;
  requestIdFactory?: () => string;
}

export class TurnBusyError extends Error {
  readonly code = "global_busy";

  constructor() {
    super("Another model turn is active");
    this.name = "TurnBusyError";
  }
}

class TurnCancelledError extends Error {
  constructor() {
    super("Model turn cancelled");
    this.name = "TurnCancelledError";
  }
}

type ActiveRequestPhase = "running" | "settling" | "terminal";

interface ActiveRequest {
  requestId: string;
  phase: ActiveRequestPhase;
  conversationId: number;
  cancelled: boolean;
  disconnect: boolean;
  normal: boolean;
  errorEmitted: boolean;
  sawText: boolean;
  incomplete: boolean;
  failure?: unknown;
  pendingFailure?: unknown;
  agentEndSeen: boolean;
  modelCompleted: boolean;
  toolFailure?: unknown;
  citationTokens?: Set<string>;
  session?: AgentSessionLike;
  unsubscribe?: () => void;
  abortPromise?: Promise<void>;
  cleanupPromise?: Promise<void>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.trim() || "Model turn failed";
  return message
    .replace(
      /((?:(?:api[_ -]?key|authorization|token)\b\s*(?::|=)\s*(?:bearer\s+)?|bearer\s+))(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[redacted]",
    )
    .slice(0, 1000);
}

function errorCode(error: unknown): string | undefined {
  const value = record(error);
  return stringValue(value?.code)?.toLowerCase();
}

function errorStatus(error: unknown): number | undefined {
  const value = record(error);
  const status = value?.status ?? value?.statusCode;
  return typeof status === "number" ? status : undefined;
}

function errorText(error: unknown): string {
  return `${errorCode(error) ?? ""} ${safeMessage(error)}`.toLowerCase();
}

function classifyError(error: unknown): {
  code: BrowserErrorCode;
  retryable: boolean;
} {
  if (error instanceof TurnCancelledError) {
    return { code: "cancelled", retryable: true };
  }
  const status = errorStatus(error);
  const code = errorCode(error);
  const text = errorText(error);
  if (
    status === 401 ||
    status === 403 ||
    code === "auth" ||
    code?.startsWith("auth_") ||
    code === "authentication_error" ||
    code?.startsWith("authentication_") ||
    code === "unauthorized" ||
    code === "forbidden" ||
    /\b(?:unauthori[sz]ed|authentication|oauth|credential|api key)\b/iu.test(
      text,
    )
  ) {
    return { code: "authentication_error", retryable: false };
  }
  if (
    status === 429 ||
    code === "quota" ||
    code?.startsWith("quota_") ||
    code === "quota_error" ||
    code === "rate_limited" ||
    code?.startsWith("rate_limit") ||
    /\b(?:quota|rate[ -]?limit|too many requests|429)\b/iu.test(text)
  ) {
    return { code: "quota_error", retryable: true };
  }
  if (
    code === "concurrency" ||
    code?.startsWith("concurrency_") ||
    code === "concurrency_error" ||
    /\b(?:concurren(?:cy|t)|already in use|busy)\b/iu.test(text)
  ) {
    return { code: "concurrency_error", retryable: true };
  }
  if (
    code === "search" ||
    code?.startsWith("search_") ||
    code === "search_error" ||
    /\b(?:web[ _-]?search|search unavailable|search failed|citation)\b/iu.test(
      text,
    )
  ) {
    return { code: "search_error", retryable: true };
  }
  if (/\b(?:abort(?:ed|ing)?|cancel(?:led|lation)?)\b/iu.test(text)) {
    return { code: "cancelled", retryable: true };
  }
  return { code: "internal_error", retryable: true };
}

function assistantRecord(value: unknown): Record<string, unknown> | undefined {
  const message = record(value);
  return message?.role === "assistant" ? message : undefined;
}

function stopReason(value: unknown): string | undefined {
  return stringValue(assistantRecord(value)?.stopReason);
}

function failureFromToolResult(result: unknown): Error {
  const resultRecord = record(result);
  const details = record(resultRecord?.details);
  const detailError = record(details?.error) ?? record(resultRecord?.error);
  const content = Array.isArray(resultRecord?.content)
    ? resultRecord.content
        .map((part) => stringValue(record(part)?.text))
        .find((text): text is string => text !== undefined)
    : undefined;
  const message =
    stringValue(detailError?.message) ?? content ?? "Tool execution failed";
  const error = new Error(message);
  const detailCode = stringValue(detailError?.code);
  if (detailCode) Object.assign(error, { code: detailCode });
  return error;
}

function assistantFailure(message: unknown): Error {
  const value = assistantRecord(message);
  return new Error(stringValue(value?.errorMessage) ?? "Model turn failed");
}

function lastAssistant(messages: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const assistant = assistantRecord(messages[index]);
    if (assistant) return assistant;
  }
  return undefined;
}

function isTextDeltaEvent(value: unknown): value is { delta: string } {
  const event = record(value);
  return event?.type === "text_delta" && typeof event.delta === "string";
}

function statusEvent(
  event: Record<string, unknown>,
  status: BrowserToolStatus,
): BrowserToolStatusEvent | undefined {
  const toolCallId = stringValue(event.toolCallId);
  const toolName = stringValue(event.toolName);
  if (!toolCallId || !toolName) return undefined;
  const isError = event.isError;
  return {
    type: "tool_status",
    toolCallId,
    toolName,
    status,
    ...(typeof isError === "boolean" ? { isError } : {}),
  };
}

export class TurnCoordinator {
  private readonly registry: ConversationRegistry;
  private readonly library: LibraryRepository;
  private readonly runtime: AgentRuntimeState;
  private readonly proposalRegistry: BookExplorerToolContext["proposalRegistry"];
  private readonly toolsFactory: (
    context: BookExplorerToolContext,
  ) => readonly ToolDefinition[];
  private readonly sessionFactory: TurnSessionFactory;
  private readonly requestIdFactory: () => string;
  private active?: ActiveRequest;

  constructor(options: TurnCoordinatorOptions) {
    this.registry = options.registry;
    this.library = options.library;
    this.runtime = options.runtime;
    this.proposalRegistry = options.proposalRegistry ?? options.registry;
    this.toolsFactory = options.toolsFactory ?? createBookExplorerTools;
    this.sessionFactory =
      options.sessionFactory ??
      ((tools, capture, manager) =>
        createTurnSession(this.runtime, tools, capture, {
          sessionManager: manager,
        }));
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  get activeRequestId(): string | undefined {
    return this.active?.requestId;
  }

  async cancel(requestId: string): Promise<boolean> {
    const active = this.active;
    if (!active || active.requestId !== requestId || active.phase !== "running")
      return false;
    active.cancelled = true;
    void this.abortActive(active);
    return true;
  }

  submit(input: TurnSubmitInput, emit: BrowserStreamEmitter): Promise<void> {
    if (!input || typeof input !== "object") {
      return emit({
        type: "error",
        code: "internal_error",
        message: "Invalid turn input",
        retryable: false,
        incomplete: false,
      });
    }
    if (typeof input.text !== "string") {
      return emit({
        type: "error",
        code: "internal_error",
        message: "Turn text must be a string",
        retryable: false,
        incomplete: false,
      });
    }
    if (this.active) {
      return emit({
        type: "error",
        code: "global_busy",
        message: "Another model turn is active",
        retryable: true,
      });
    }

    const requestId = input.retryRequestId ?? this.requestIdFactory();
    const active: ActiveRequest = {
      requestId,
      phase: "running",
      conversationId: input.conversationId,
      cancelled: input.signal?.aborted ?? false,
      disconnect: false,
      normal: false,
      errorEmitted: false,
      sawText: false,
      incomplete: false,
      agentEndSeen: false,
      modelCompleted: false,
    };
    this.active = active;
    const abortListener = () => {
      if (active.phase !== "running") return;
      active.cancelled = true;
      void this.abortActive(active);
    };
    input.signal?.addEventListener("abort", abortListener, { once: true });

    return this.run(active, input, emit).finally(() => {
      input.signal?.removeEventListener("abort", abortListener);
      if (this.active === active) this.active = undefined;
    });
  }

  private async run(
    active: ActiveRequest,
    input: TurnSubmitInput,
    emit: BrowserStreamEmitter,
  ): Promise<void> {
    try {
      await this.registry.withConversation(
        active.conversationId,
        async (manager, conversation) => {
          try {
            manager.appendCustomEntry("book-explorer-request", {
              requestId: active.requestId,
            });
            if (input.retryRequestId !== undefined) {
              manager.appendCustomEntry("book-explorer-retry", {
                requestId: active.requestId,
              });
            }
            if (active.cancelled) throw new TurnCancelledError();

            const citationCapture = createCitationCapture();
            const customTools = this.toolsFactory({
              library: this.library,
              proposalRegistry: this.scopedProposalRegistry(
                active,
                manager,
                conversation,
              ),
              conversationId: active.conversationId,
              requestId: active.requestId,
              citationCapture,
            });
            const turn = await this.sessionFactory(
              customTools,
              citationCapture,
              manager,
            );
            active.session = turn.session;
            if (active.cancelled) {
              await this.abortActive(active);
              throw new TurnCancelledError();
            }

            let eventChain = Promise.resolve();
            active.unsubscribe = active.session.subscribe((event) => {
              eventChain = eventChain.then(() =>
                this.handleEvent(active, event, citationCapture, emit),
              );
            });
            let promptFailure: unknown;
            try {
              await active.session.prompt(input.text);
            } catch (error) {
              promptFailure = error;
            }
            let eventFailure: unknown;
            try {
              await eventChain;
            } catch (error) {
              eventFailure = error;
            }
            if (eventFailure !== undefined) throw eventFailure;
            if (promptFailure !== undefined && active.failure === undefined) {
              active.failure = promptFailure;
            }
            if (
              active.failure === undefined &&
              active.pendingFailure !== undefined &&
              !active.agentEndSeen
            ) {
              active.failure = active.pendingFailure;
            }
            if (active.cancelled) active.failure = new TurnCancelledError();
            if (active.failure !== undefined) {
              await this.emitError(active, active.failure, emit);
              return;
            }
            if (active.toolFailure !== undefined && !active.modelCompleted) {
              await this.emitError(active, active.toolFailure, emit);
              return;
            }
            active.incomplete = active.incomplete || active.cancelled;
            active.phase = "settling";
            try {
              await this.deliver(
                active,
                {
                  type: "complete",
                  incomplete: active.incomplete,
                },
                emit,
              );
              active.normal = true;
            } finally {
              active.phase = "terminal";
            }
          } catch (error) {
            if (active.disconnect) throw error;
            if (error instanceof TurnCancelledError) {
              active.failure = error;
            } else if (active.failure === undefined) {
              active.failure = error;
            }
            if (!active.errorEmitted)
              await this.emitError(active, active.failure, emit);
          } finally {
            await this.cleanup(active);
          }
        },
      );
    } catch (error) {
      if (active.disconnect) throw error;
      if (!active.errorEmitted) {
        if (
          error instanceof ConversationBusyError ||
          error instanceof ConversationNotFoundError
        ) {
          await this.emitError(active, error, emit);
        } else {
          await this.emitError(active, error, emit);
        }
      }
    } finally {
      if (!active.cleanupPromise) await this.cleanup(active);
    }
  }

  private scopedProposalRegistry(
    active: ActiveRequest,
    manager: SessionManager,
    conversation: Conversation,
  ): ProposalRegistry {
    const registry = this.proposalRegistry;
    return {
      withConversation<T>(
        conversationId: number,
        fn: (
          session: ProposalSession,
          currentConversation?: Conversation,
        ) => T | PromiseLike<T>,
      ): Promise<T> {
        if (conversationId === active.conversationId) {
          return Promise.resolve(fn(manager, conversation));
        }
        return registry.withConversation(conversationId, fn);
      },
    };
  }

  private async handleEvent(
    active: ActiveRequest,
    rawEvent: AgentSessionEvent,
    citationCapture: CitationCapture,
    emit: BrowserStreamEmitter,
  ): Promise<void> {
    const event = record(rawEvent);
    if (!event) return;
    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;
      if (isTextDeltaEvent(assistantEvent)) {
        active.sawText = true;
        await this.deliver(
          active,
          { type: "text_delta", delta: assistantEvent.delta },
          emit,
        );
      } else {
        const assistant = record(assistantEvent);
        if (assistant?.type === "error") {
          active.incomplete = true;
          active.pendingFailure = assistantFailure(
            assistant.error ?? event.message,
          );
        }
      }
    } else if (event.type === "tool_execution_start") {
      const status = statusEvent(event, "started");
      if (status) await this.deliver(active, status, emit);
    } else if (event.type === "tool_execution_update") {
      const status = statusEvent(event, "updated");
      if (status) await this.deliver(active, status, emit);
    } else if (event.type === "tool_execution_end") {
      const status = statusEvent(event, "completed");
      if (status) await this.deliver(active, status, emit);
      if (event.isError === true)
        active.toolFailure = failureFromToolResult(event.result);
    } else if (event.type === "message_end" || event.type === "turn_end") {
      const reason = stopReason(event.message);
      if (reason === "length") active.incomplete = true;
      if (reason === "error")
        active.pendingFailure = assistantFailure(event.message);
      if (reason === "aborted")
        active.pendingFailure = new TurnCancelledError();
    } else if (event.type === "agent_end") {
      active.agentEndSeen = true;
      const message = lastAssistant(event.messages);
      const reason = stopReason(message);
      if (reason === "length") active.incomplete = true;
      if (event.willRetry === true) {
        active.pendingFailure = undefined;
      } else if (reason === "error") {
        active.failure = assistantFailure(message);
      } else if (reason === "aborted") {
        active.failure = new TurnCancelledError();
      } else if (active.pendingFailure !== undefined) {
        active.failure = active.pendingFailure;
      } else {
        active.modelCompleted = true;
      }
    }

    if (event.type !== "tool_execution_end") return;
    for (const [token, citation] of citationCapture) {
      if (active.citationTokens?.has(token)) continue;
      active.citationTokens ??= new Set();
      active.citationTokens.add(token);
      await this.deliver(active, { type: "citation", token, citation }, emit);
    }
  }

  private async emitError(
    active: ActiveRequest,
    error: unknown,
    emit: BrowserStreamEmitter,
  ): Promise<void> {
    if (active.errorEmitted) return;
    active.errorEmitted = true;
    const classified = active.cancelled
      ? { code: "cancelled" as const, retryable: true }
      : classifyError(error);
    await this.deliver(
      active,
      {
        type: "error",
        code: classified.code,
        message: active.cancelled ? "Model turn cancelled" : safeMessage(error),
        retryable: classified.retryable,
        incomplete: active.sawText || active.incomplete || active.cancelled,
      },
      emit,
    );
  }

  private async deliver(
    active: ActiveRequest,
    event: BrowserStreamEvent,
    emit: BrowserStreamEmitter,
  ): Promise<void> {
    try {
      await emit(event);
    } catch (error) {
      active.disconnect = true;
      void this.abortActive(active);
      throw error;
    }
  }

  private abortActive(active: ActiveRequest): Promise<void> {
    if (!active.session) return Promise.resolve();
    if (!active.abortPromise) {
      active.abortPromise = (async () => {
        try {
          await active.session?.abort();
        } catch {
          // Disposal still runs when Pi cannot complete an abort cleanly.
        }
      })();
    }
    return active.abortPromise;
  }

  private cleanup(active: ActiveRequest): Promise<void> {
    if (active.cleanupPromise) return active.cleanupPromise;
    active.cleanupPromise = (async () => {
      active.phase = "terminal";
      try {
        active.unsubscribe?.();
      } catch {
        // Cleanup continues even if a driver rejects an unsubscribe.
      }
      if (!active.normal) await this.abortActive(active);
      try {
        await active.session?.dispose();
      } catch {
        // The global gate must be released even when disposal reports an error.
      }
    })();
    return active.cleanupPromise;
  }
}

export const createTurnCoordinator = (
  options: TurnCoordinatorOptions,
): TurnCoordinator => new TurnCoordinator(options);
