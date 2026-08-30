import { createRequire } from "node:module";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AuthCheck,
  Credential,
  Model,
  ModelsRefreshOptions,
  ModelsRefreshResult,
} from "@earendil-works/pi-ai";

import {
  ensureWebSearchCache,
  isPiOffline,
  prepareWebSearchEnvironment,
  scrubWebSearchEnvironment,
  writeWebSearchConfig,
  type ApplicationPaths,
  type ApplicationPathsInput,
} from "./config.js";
import {
  ACTIVE_TOOL_NAMES,
  assertExactToolSurface,
  createSearchGuardFactory,
  type CitationCapture,
  type SearchGuardRuntime,
} from "./search-guard.js";

const require = createRequire(import.meta.url);
const PINNED_PROVIDER = "openai-codex";
const PINNED_MODEL_ID = "gpt-5.6-sol";
const PINNED_THINKING_LEVEL = "medium" as const;
const REFRESH_TIMEOUT_MS = 10_000;

export const PINNED_MODEL = `${PINNED_PROVIDER}/${PINNED_MODEL_ID}`;
export const THINKING_LEVEL = PINNED_THINKING_LEVEL;

export const COMPLETE_SYSTEM_PROMPT = [
  "You are Book Explorer, a local book recommendation assistant.",
  "Use the library tools for authoritative book state and never use tools outside the supplied allowlist.",
  "For web research, use web_search with provider omitted or exactly openai and workflow omitted or exactly none.",
  "Do not send includeContent and never send a provider array.",
  "Search and record_recommendation are separate tool rounds so search citations can be captured first.",
  "Distinguish model-memory suggestions from researched claims and never invent citations.",
].join(" ");

export interface AgentModelRuntime extends SearchGuardRuntime {
  refresh(options: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
}

export interface RuntimeOptions {
  authPath: string;
  modelsPath: string;
  modelsStorePath: string;
  refreshOnCreate: false;
}

export interface RuntimeDependencies {
  runtimeFactory?: (options: RuntimeOptions) => Promise<AgentModelRuntime>;
  modelRuntimeFactory?: (options: RuntimeOptions) => Promise<AgentModelRuntime>;
  loaderFactory?: (options: Record<string, unknown>) => ResourceLoader;
  resourceLoaderFactory?: (options: Record<string, unknown>) => ResourceLoader;
  sessionFactory?: (options: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
  agentSessionFactory?: (options: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
  credentialReader?: (providerId: string, authPath: string) => Credential | undefined;
  extensionImporter?: (extensionPath: string) => void | Promise<void> | string | Promise<string>;
  dynamicExtensionImport?: (extensionPath: string) => void | Promise<void> | string | Promise<string>;
  extensionPath?: string;
  extensionImported?: boolean;
}

export interface AgentRuntimeState {
  runtime: AgentModelRuntime;
  model?: Model<Api>;
  thinkingLevel?: typeof PINNED_THINKING_LEVEL;
  oauthReady?: boolean;
  libraryOnlyReason?: string;
  paths: ApplicationPaths;
  dependencies: RuntimeDependencies;
}

export interface TurnSession {
  session: AgentSession;
  loader: ResourceLoader;
}

export interface TurnSessionOptions {
  sessionManager?: CreateAgentSessionOptions["sessionManager"];
}

export class AgentRuntimeError extends Error {
  readonly code = "agent_runtime_unavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}

function runtimeLike(value: unknown): value is AgentModelRuntime {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { getModel?: unknown }).getModel === "function" &&
    typeof (value as { checkAuth?: unknown }).checkAuth === "function" &&
    typeof (value as { refresh?: unknown }).refresh === "function",
  );
}

function dependencyOptions(value: RuntimeDependencies | undefined): RuntimeDependencies {
  if (!value) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Runtime dependencies must be an object");
  }
  return value;
}

function credentialIsFresh(credential: Credential | undefined, now = Date.now()): boolean {
  if (!credential || credential.type !== "oauth") return false;
  return typeof credential.access === "string" && credential.access.length > 0 &&
    typeof credential.refresh === "string" && credential.refresh.length > 0 &&
    Number.isFinite(credential.expires) && credential.expires > now;
}

function credentialFailure(credential: Credential | undefined, now = Date.now()): never {
  if (!credential) {
    throw new AgentRuntimeError(`Missing OAuth credential for ${PINNED_PROVIDER}; sign in with Pi Codex OAuth first`);
  }
  if (credential.type !== "oauth") {
    throw new AgentRuntimeError(`Non-OAuth credential for ${PINNED_PROVIDER} is not accepted`);
  }
  if (!credentialIsFresh(credential, now)) {
    throw new AgentRuntimeError(`Expired or invalid OAuth credential for ${PINNED_PROVIDER}; restart after refreshing authentication`);
  }
  throw new AgentRuntimeError(`OAuth credential for ${PINNED_PROVIDER} is unavailable`);
}

function authFailure(auth: AuthCheck | undefined): never {
  if (!auth) {
    throw new AgentRuntimeError(`OAuth authentication for ${PINNED_PROVIDER} is unavailable`);
  }
  if (auth.type !== "oauth") {
    throw new AgentRuntimeError(`Only OAuth authentication for ${PINNED_PROVIDER} is accepted`);
  }
  throw new AgentRuntimeError(`OAuth authentication for ${PINNED_PROVIDER} is unavailable`);
}

function libraryOnly(
  runtime: AgentModelRuntime,
  paths: ApplicationPaths,
  dependencies: RuntimeDependencies,
  reason: string,
): AgentRuntimeState {
  return { runtime, paths, dependencies, libraryOnlyReason: reason, oauthReady: true };
}

async function refreshCatalog(runtime: AgentModelRuntime): Promise<{ result?: ModelsRefreshResult; reason?: string }> {
  const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  try {
    const result = await runtime.refresh({
      allowNetwork: true,
      providers: [PINNED_PROVIDER],
      signal,
    });
    if (result.aborted) return { reason: "model catalog refresh aborted" };
    if (result.errors.size > 0) {
      const error = result.errors.get(PINNED_PROVIDER) ?? result.errors.values().next().value;
      return { reason: `model catalog refresh failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { result };
  } catch (error) {
    return { reason: `model catalog refresh failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function loadConfiguredExtension(dependencies: RuntimeDependencies): Promise<void> {
  const importer = dependencies.extensionImporter ?? dependencies.dynamicExtensionImport;
  if (!importer || dependencies.extensionImported) return;
  const extensionPath = dependencies.extensionPath ?? defaultExtensionPath();
  const importedPath = await importer(extensionPath);
  if (typeof importedPath === "string") dependencies.extensionPath = importedPath;
  dependencies.extensionImported = true;
}

function defaultExtensionPath(): string {
  try {
    return require.resolve("pi-web-access/index.ts");
  } catch (error) {
    throw new AgentRuntimeError("Pinned pi-web-access extension is not installed", { cause: error });
  }
}

function stateFrom(
  value: AgentRuntimeState | AgentModelRuntime,
): AgentRuntimeState {
  if (value && typeof value === "object" && "runtime" in value && "paths" in value) {
    return value as AgentRuntimeState;
  }
  throw new AgentRuntimeError("Turn creation requires the initialized AgentRuntimeState");
}

export async function initializeAgentRuntime(
  input: ApplicationPaths | ApplicationPathsInput,
  dependencies?: RuntimeDependencies,
): Promise<AgentRuntimeState> {
  const paths = prepareWebSearchEnvironment(input);
  const deps = dependencyOptions(dependencies);
  const credential = deps.credentialReader
    ? deps.credentialReader(PINNED_PROVIDER, paths.authPath)
    : readStoredCredential(PINNED_PROVIDER, paths.authPath);
  if (!credentialIsFresh(credential)) credentialFailure(credential);

  const runtimeFactory = deps.runtimeFactory ?? deps.modelRuntimeFactory ?? ((options: RuntimeOptions) => ModelRuntime.create(options));
  const runtime = await runtimeFactory({
    authPath: paths.authPath,
    modelsPath: paths.modelsPath,
    modelsStorePath: paths.modelsStorePath,
    refreshOnCreate: false,
  });
  if (!runtimeLike(runtime)) {
    throw new AgentRuntimeError("ModelRuntime factory returned an invalid runtime");
  }

  let auth: unknown;
  try {
    auth = await runtime.checkAuth(PINNED_PROVIDER);
  } catch (error) {
    throw new AgentRuntimeError(`OAuth authentication for ${PINNED_PROVIDER} could not be checked`, { cause: error });
  }
  if (!auth || typeof auth !== "object" || (auth as AuthCheck).type !== "oauth") {
    authFailure(auth as AuthCheck | undefined);
  }

  await loadConfiguredExtension(deps);
  if (isPiOffline()) {
    return libraryOnly(runtime, paths, deps, "offline");
  }

  const refreshed = await refreshCatalog(runtime);
  if (refreshed.reason) return libraryOnly(runtime, paths, deps, refreshed.reason);

  const model = runtime.getModel(PINNED_PROVIDER, PINNED_MODEL_ID) as Model<Api> | undefined;
  if (!model || model.provider !== PINNED_PROVIDER || model.id !== PINNED_MODEL_ID) {
    return libraryOnly(runtime, paths, deps, `Pinned model ${PINNED_MODEL} is unavailable`);
  }
  return {
    runtime,
    model,
    thinkingLevel: PINNED_THINKING_LEVEL,
    oauthReady: true,
    paths,
    dependencies: deps,
  };
}

export async function createTurnLoader(
  runtime: AgentRuntimeState | AgentModelRuntime,
  customTools: readonly ToolDefinition[],
  citationCapture: CitationCapture,
): Promise<ResourceLoader> {
  const state = stateFrom(runtime);
  if (!Array.isArray(customTools)) throw new TypeError("Custom tools must be an array");
  if (!state.model || state.libraryOnlyReason) {
    throw new AgentRuntimeError(state.libraryOnlyReason ?? "Model turns are unavailable in library-only mode");
  }
  const paths = scrubWebSearchEnvironment(state.paths);
  writeWebSearchConfig(paths);
  ensureWebSearchCache(paths);
  await loadConfiguredExtension(state.dependencies);
  const resolvedExtensionPath = state.dependencies.extensionPath ?? defaultExtensionPath();
  const loaderOptions: Record<string, unknown> = {
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [resolvedExtensionPath],
    extensionFactories: [createSearchGuardFactory(state, citationCapture)],
    systemPromptOverride: () => COMPLETE_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  };
  const loaderFactory = state.dependencies.loaderFactory ?? state.dependencies.resourceLoaderFactory;
  const loader = loaderFactory
    ? loaderFactory(loaderOptions)
    : new DefaultResourceLoader(loaderOptions as never);
  await loader.reload();
  return loader;
}

export async function createTurnSession(
  runtime: AgentRuntimeState,
  customTools: readonly ToolDefinition[],
  citationCapture: CitationCapture,
  options: TurnSessionOptions = {},
): Promise<TurnSession> {
  if (!runtime.model || runtime.libraryOnlyReason) {
    throw new AgentRuntimeError(runtime.libraryOnlyReason ?? "Model turns are unavailable in library-only mode");
  }
  const loader = await createTurnLoader(runtime, customTools, citationCapture);
  const sessionOptions = {
    cwd: runtime.paths.cwd,
    agentDir: runtime.paths.agentDir,
    model: runtime.model,
    thinkingLevel: runtime.thinkingLevel,
    modelRuntime: runtime.runtime as ModelRuntime,
    noTools: "builtin" as const,
    tools: [...ACTIVE_TOOL_NAMES],
    customTools: [...customTools],
    resourceLoader: loader,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(runtime.paths.cwd),
  } satisfies CreateAgentSessionOptions;
  const sessionFactory = runtime.dependencies.sessionFactory ?? runtime.dependencies.agentSessionFactory;
  const sessionResult = sessionFactory
    ? await sessionFactory(sessionOptions)
    : await createAgentSession(sessionOptions);
  try {
    assertExactToolSurface(sessionResult.session);
  } catch (error) {
    await disposeTurnSession(sessionResult.session);
    throw error;
  }
  return { session: sessionResult.session, loader };
}

export async function disposeTurnSession(session: AgentSession): Promise<void> {
  try {
    await session.abort();
  } catch {
    // Disposal must still run after an abort failure.
  }
  session.dispose();
}

export async function createStartupProbe(
  runtime: AgentRuntimeState,
  customTools: readonly ToolDefinition[],
  citationCapture: CitationCapture,
): Promise<void> {
  const turn = await createTurnSession(runtime, customTools, citationCapture);
  try {
    // Session creation and active-tool inspection are the probe; no prompt is sent.
  } finally {
    turn.session.dispose();
  }
}

export const startupProbe = createStartupProbe;
export const createAgentTurnSession = createTurnSession;
