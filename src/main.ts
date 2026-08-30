import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Server } from "node:http";

import {
  initializeAgentRuntime,
  createStartupProbe,
  type AgentRuntimeState,
  type RuntimeDependencies,
} from "./agent-runtime.js";
import {
  PINNED_WEB_SEARCH_CONFIG,
  resolveApplicationPaths,
  type ApplicationPaths,
  type ApplicationPathsInput,
} from "./config.js";
import { closeDatabase, openDatabase, type Database } from "./db.js";
import {
  ConversationRegistry,
  type ConversationRegistryOptions,
} from "./conversations.js";
import {
  createHttpServer,
  type HttpDependencies,
  type HttpServer,
} from "./http.js";
import { LibraryRepository } from "./library.js";
import { OpenLibraryClient } from "./open-library.js";
import {
  createBookExplorerTools,
  type BookExplorerToolContext,
} from "./tools.js";
import { TurnCoordinator, type TurnCoordinatorOptions } from "./turns.js";
import { validateWebSearchConfig } from "./config.js";

const DEFAULT_DATABASE_FILENAME = "book-explorer.sqlite";
const DEFAULT_PORT = 3000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface StartupPaths extends ApplicationPaths {
  databasePath: string;
  sessionDir: string;
}

export interface PlatformChecks {
  platform?: string;
  getPlatform?: () => string;
  isWindows?: () => boolean;
  isBroadlyAccessible?: (path: string) => boolean;
  checkWindowsAcl?: (path: string) => boolean;
}

export interface StorageOptions extends PlatformChecks {
  warn?: (message: string) => void;
  platformChecks?: PlatformChecks;
}

export interface StartupPathInput extends ApplicationPathsInput {
  paths?: StartupPaths | ApplicationPaths;
  databasePath?: string;
  dbPath?: string;
  sessionDir?: string;
  sessionsDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface StartupDependencies extends StorageOptions {
  openDatabase?: (path: string) => Database;
  databaseFactory?: (path: string) => Database;
  createLibrary?: (db: Database) => LibraryRepository;
  libraryFactory?: (db: Database) => LibraryRepository;
  createRegistry?: (
    db: Database,
    options: ConversationRegistryOptions,
  ) => ConversationRegistry;
  registryFactory?: (
    db: Database,
    options: ConversationRegistryOptions,
  ) => ConversationRegistry;
  createOpenLibrary?: (db: Database) => OpenLibraryClient;
  openLibraryFactory?: (db: Database) => OpenLibraryClient;
  initializeRuntime?: (
    paths: StartupPaths,
    dependencies?: RuntimeDependencies,
  ) => Promise<AgentRuntimeState>;
  runtimeInitializer?: (
    paths: StartupPaths,
    dependencies?: RuntimeDependencies,
  ) => Promise<AgentRuntimeState>;
  runtimeDependencies?: RuntimeDependencies;
  createTurnCoordinator?: (options: TurnCoordinatorOptions) => TurnCoordinator;
  turnCoordinatorFactory?: (options: TurnCoordinatorOptions) => TurnCoordinator;
  createHttpServer?: (dependencies: HttpDependencies) => HttpServer;
  httpServerFactory?: (dependencies: HttpDependencies) => HttpServer;
  startupProbe?: (
    runtime: AgentRuntimeState,
    customTools: ReturnType<typeof createBookExplorerTools>,
    citationCapture: Map<string, unknown>,
  ) => Promise<void>;
  probe?: (
    runtime: AgentRuntimeState,
    customTools: ReturnType<typeof createBookExplorerTools>,
    citationCapture: Map<string, unknown>,
  ) => Promise<void>;
}

export interface ApplicationOptions extends StartupPathInput, StorageOptions {
  host?: string;
  port?: number;
  dependencies?: StartupDependencies;
  runtimeDependencies?: RuntimeDependencies;
}

export interface Application {
  readonly paths: StartupPaths;
  readonly db: Database;
  readonly database: Database;
  readonly library: LibraryRepository;
  readonly registry: ConversationRegistry;
  readonly conversations: ConversationRegistry;
  readonly openLibrary: OpenLibraryClient;
  readonly openLibraryClient: OpenLibraryClient;
  readonly runtime: AgentRuntimeState;
  readonly turns: TurnCoordinator;
  readonly coordinator: TurnCoordinator;
  readonly server: HttpServer;
  readonly httpServer: HttpServer;
  readonly host?: string;
  readonly port?: number;
  readonly shutdown: () => Promise<void>;
}

function configurationError(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "ConfigurationError";
  return error;
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configurationError("Startup options must be an object");
  }
  return value as Record<string, unknown>;
}

function platformName(options: PlatformChecks = {}): string {
  if (options.getPlatform) return options.getPlatform();
  if (options.platform) return options.platform;
  return process.platform;
}

function isWindows(options: StorageOptions = {}): boolean {
  const checks = options.platformChecks ?? options;
  return checks.isWindows?.() === true || platformName(checks) === "win32";
}

function isPosix(options: StorageOptions = {}): boolean {
  return !isWindows(options);
}

function pathInside(
  root: string,
  candidate: string,
  label: string,
  allowRoot = false,
): string {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const path = relative(normalizedRoot, normalizedCandidate);
  if (
    (!allowRoot && !path) ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  ) {
    throw configurationError(
      `${label} must remain under the application data directory`,
    );
  }
  return normalizedCandidate;
}

function defaultDataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.XDG_DATA_HOME?.trim();
  const base = configured
    ? resolve(configured)
    : resolve(home, ".local", "share");
  return join(base, "book-explorer");
}

function pathInputValue(input: StartupPathInput): StartupPathInput {
  const nested = input.paths;
  if (!nested) return input;
  return { ...input, ...nested };
}

function startupPaths(input: StartupPathInput = {}): StartupPaths {
  const value = pathInputValue(input);
  const env = input.env ?? process.env;
  const home = resolve(input.homeDir ?? homedir());
  const dataDir = value.dataDir ?? defaultDataDirectory(env, home);
  const app = resolveApplicationPaths({
    ...value,
    dataDir,
    authPath: value.authPath ?? join(home, ".pi", "agent", "auth.json"),
    cwd: value.cwd ?? dataDir,
  });
  const databasePath = resolve(
    value.databasePath ??
      value.dbPath ??
      join(app.dataDir, DEFAULT_DATABASE_FILENAME),
  );
  const sessionDir = resolve(
    value.sessionDir ?? value.sessionsDir ?? join(app.dataDir, "sessions"),
  );

  pathInside(app.dataDir, app.agentDir, "Agent directory");
  pathInside(app.dataDir, app.cwd, "Application cwd", true);
  pathInside(app.agentDir, app.modelsPath, "Models path");
  pathInside(app.agentDir, app.modelsStorePath, "Models store path");
  pathInside(app.agentDir, app.webSearchConfigPath, "Web search config path");
  pathInside(app.agentDir, app.webSearchCacheDir, "Web search cache directory");
  pathInside(app.dataDir, sessionDir, "Session directory");
  pathInside(app.dataDir, databasePath, "Database path");

  return { ...app, databasePath, sessionDir };
}

export function resolveStartupPaths(
  input: StartupPathInput = {},
): StartupPaths {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw configurationError("Startup options must be an object");
  }
  return startupPaths(input);
}

export const resolveDataPaths = resolveStartupPaths;
export const computeApplicationPaths = resolveStartupPaths;
export const defaultDataRoot = defaultDataDirectory;

function permissionError(
  path: string,
  expected: number,
  actual: number,
): Error {
  return configurationError(
    `Unsafe permissions for ${path}: expected ${expected.toString(8)}, found ${actual.toString(8)}; correct the mode and restart`,
  );
}

function ensureDirectory(
  path: string,
  label: string,
  options: StorageOptions,
): void {
  try {
    mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw configurationError(`${label} is not a safe directory: ${path}`);
    }
    if (isPosix(options)) {
      const actual = info.mode & 0o777;
      if (actual !== PRIVATE_DIRECTORY_MODE) {
        throw permissionError(path, PRIVATE_DIRECTORY_MODE, actual);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "ConfigurationError")
      throw error;
    throw configurationError(`Cannot secure ${label}: ${path}`, error);
  }
}

function ensureExistingFile(
  path: string,
  label: string,
  options: StorageOptions,
): boolean {
  if (!existsSync(path)) return false;
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    throw configurationError(`Cannot inspect ${label}: ${path}`, error);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw configurationError(`${label} is not a regular file: ${path}`);
  }
  if (isPosix(options)) {
    const actual = info.mode & 0o777;
    if (actual !== PRIVATE_FILE_MODE) {
      throw permissionError(path, PRIVATE_FILE_MODE, actual);
    }
  }
  return true;
}

function createPrivateFile(
  path: string,
  label: string,
  content: string,
  options: StorageOptions,
): void {
  if (!existsSync(path)) {
    try {
      writeFileSync(path, content, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
        flag: "wx",
      });
    } catch (error) {
      throw configurationError(`Cannot create ${label}: ${path}`, error);
    }
  }
  ensureExistingFile(path, label, options);
}

function precreateDatabase(path: string, options: StorageOptions): void {
  if (!existsSync(path)) {
    try {
      const descriptor = openSync(path, "wx", PRIVATE_FILE_MODE);
      closeSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw configurationError(`Cannot create database: ${path}`, error);
      }
    }
  }
  ensureExistingFile(path, "Database", options);
}

function checkTree(path: string, label: string, options: StorageOptions): void {
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    const info = lstatSync(child);
    if (info.isSymbolicLink()) {
      throw configurationError(`${label} contains a symbolic link: ${child}`);
    }
    if (info.isDirectory()) {
      if (isPosix(options) && (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw permissionError(child, PRIVATE_DIRECTORY_MODE, info.mode & 0o777);
      }
      checkTree(child, label, options);
    } else if (info.isFile()) {
      if (isPosix(options) && (info.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw permissionError(child, PRIVATE_FILE_MODE, info.mode & 0o777);
      }
    } else {
      throw configurationError(
        `${label} contains a non-regular entry: ${child}`,
      );
    }
  }
}

function resetPrivateCache(path: string, options: StorageOptions): void {
  if (existsSync(path)) {
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      throw configurationError(
        `Cannot inspect web search cache: ${path}`,
        error,
      );
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw configurationError(
        `Web search cache is not a safe directory: ${path}`,
      );
    }
    if (isPosix(options) && (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw permissionError(path, PRIVATE_DIRECTORY_MODE, info.mode & 0o777);
    }
  }
  try {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    throw configurationError(
      `Cannot clear and recreate web search cache: ${path}`,
      error,
    );
  }
  ensureDirectory(path, "web search cache directory", options);
}

function warnBroadWindowsDirectory(
  paths: StartupPaths,
  options: StorageOptions,
): void {
  if (!isWindows(options)) return;
  const checks = options.platformChecks ?? options;
  const checker = checks.isBroadlyAccessible ?? checks.checkWindowsAcl;
  if (!checker?.(paths.dataDir)) return;
  (options.warn ?? console.warn)(
    `Windows data directory ${paths.dataDir} appears broadly accessible; review its ACL because Book Explorer stores private data there`,
  );
}

/** Create the private application layout and reject unsafe existing POSIX modes. */
export function ensureApplicationStorage(
  input: StartupPaths | StartupPathInput,
  options: StorageOptions = {},
): StartupPaths {
  const paths =
    typeof (input as Partial<StartupPaths>).databasePath === "string" &&
    typeof (input as Partial<StartupPaths>).sessionDir === "string"
      ? (input as StartupPaths)
      : resolveStartupPaths(input as StartupPathInput);
  ensureDirectory(paths.dataDir, "application data directory", options);
  ensureDirectory(paths.agentDir, "application agent directory", options);
  ensureDirectory(paths.sessionDir, "session directory", options);

  precreateDatabase(paths.databasePath, options);
  for (const sidecar of [
    `${paths.databasePath}-wal`,
    `${paths.databasePath}-shm`,
  ]) {
    ensureExistingFile(sidecar, "SQLite sidecar", options);
  }
  createPrivateFile(
    paths.modelsPath,
    "models file",
    '{"providers":{}}\n',
    options,
  );
  createPrivateFile(paths.modelsStorePath, "models store", "{}\n", options);
  ensureExistingFile(paths.webSearchConfigPath, "web search config", options);
  ensureDirectory(
    paths.webSearchCacheDir,
    "web search cache directory",
    options,
  );
  resetPrivateCache(paths.webSearchCacheDir, options);

  // Preserve the runtime's fail-closed checks before replacing an existing config.
  if (existsSync(paths.webSearchConfigPath)) {
    let current: unknown;
    try {
      current = JSON.parse(
        readFileSync(paths.webSearchConfigPath, "utf8"),
      ) as unknown;
    } catch (error) {
      throw configurationError(
        `Cannot parse web search config: ${paths.webSearchConfigPath}`,
        error,
      );
    }
    if (current && typeof current === "object" && !Array.isArray(current)) {
      if (Object.hasOwn(current, "openaiApiKey")) {
        throw configurationError(
          "web-search.json must not contain openaiApiKey",
        );
      }
      const config = current as Record<string, unknown>;
      if (
        ["provider", "openaiSearchProviders", "workflow", "tools"].some((key) =>
          Object.hasOwn(config, key),
        )
      ) {
        try {
          validateWebSearchConfig(config);
        } catch (error) {
          throw configurationError(
            "Existing web-search.json is not pinned to the required configuration",
            error,
          );
        }
      }
    }
  }
  try {
    const serialized = `${JSON.stringify(PINNED_WEB_SEARCH_CONFIG, null, 2)}\n`;
    writeFileSync(paths.webSearchConfigPath, serialized, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
    });
    if (isPosix(options))
      chmodSync(paths.webSearchConfigPath, PRIVATE_FILE_MODE);
    validateWebSearchConfig(JSON.parse(serialized) as unknown);
  } catch (error) {
    throw configurationError(
      `Cannot create validated web search config: ${paths.webSearchConfigPath}`,
      error,
    );
  }
  ensureExistingFile(paths.webSearchConfigPath, "web search config", options);
  checkTree(paths.sessionDir, "Session directory", options);
  warnBroadWindowsDirectory(paths, options);
  return paths;
}

export const prepareApplicationStorage = ensureApplicationStorage;
export const ensureStoragePermissions = ensureApplicationStorage;

function secureDatabaseSidecars(path: string, options: StorageOptions): void {
  if (!isPosix(options)) return;
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    if (!existsSync(sidecar)) continue;
    const info = lstatSync(sidecar);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw configurationError(
        `SQLite sidecar is not a regular file: ${sidecar}`,
      );
    }
    chmodSync(sidecar, PRIVATE_FILE_MODE);
    ensureExistingFile(sidecar, "SQLite sidecar", options);
  }
}

function dependencyValue<T>(
  first: T | undefined,
  second: T | undefined,
  fallback: T,
): T {
  return first ?? second ?? fallback;
}

function normalizeApplicationArguments(
  options: ApplicationOptions | StartupPaths | undefined,
  supplied: StartupDependencies | undefined,
): { options: ApplicationOptions; dependencies: StartupDependencies } {
  const value = (options ?? {}) as ApplicationOptions;
  inputRecord(value);
  const nested = value.dependencies ?? {};
  const dependencies = { ...nested, ...(supplied ?? {}) };
  return { options: value, dependencies };
}

function makeProbeTools(
  library: LibraryRepository,
  registry: ConversationRegistry,
): ReturnType<typeof createBookExplorerTools> {
  return createBookExplorerTools({
    library,
    proposalRegistry: registry,
    conversationId: 0,
    requestId: "startup-probe",
    citationCapture: new Map(),
  } as BookExplorerToolContext);
}

function noOpCitationCapture(): Map<string, unknown> {
  return new Map<string, unknown>();
}

async function closeServer(server: Server): Promise<void> {
  if (typeof server.close !== "function") return;
  let called = false;
  let callbackCalled = false;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const done = (error?: Error): void => {
      if (callbackCalled) return;
      callbackCalled = true;
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    try {
      const result = server.close(done);
      called = true;
      if (
        (server as Server & { listening?: boolean }).listening === false &&
        !callbackCalled
      ) {
        done();
      }
      if (result && typeof (result as { then?: unknown }).then === "function") {
        // SAFETY: Server.close's thenable, when supplied by a test double, resolves after the callback contract.
        void (result as unknown as Promise<void>).then(
          () => done(),
          (error) => done(error),
        );
      }
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
    if (!called && !callbackCalled) done();
  });
}

async function composeApplication(
  options: ApplicationOptions,
  dependencies: StartupDependencies,
): Promise<Application> {
  const paths = resolveStartupPaths(options);
  ensureApplicationStorage(paths, {
    ...dependencies,
    ...options,
    platformChecks: options.platformChecks ?? dependencies.platformChecks,
    warn: options.warn ?? dependencies.warn,
  });

  let db: Database | undefined;
  let registry: ConversationRegistry | undefined;
  let server: HttpServer | undefined;
  try {
    const dbFactory = dependencyValue(
      dependencies.openDatabase,
      dependencies.databaseFactory,
      openDatabase,
    );
    db = dbFactory(paths.databasePath);
    secureDatabaseSidecars(paths.databasePath, {
      ...dependencies,
      ...options,
      platformChecks: options.platformChecks ?? dependencies.platformChecks,
    });

    const libraryFactory = dependencyValue(
      dependencies.createLibrary,
      dependencies.libraryFactory,
      (database: Database) => new LibraryRepository(database),
    );
    const library = libraryFactory(db);
    const registryFactory = dependencyValue(
      dependencies.createRegistry,
      dependencies.registryFactory,
      (database: Database, registryOptions: ConversationRegistryOptions) =>
        new ConversationRegistry(database, registryOptions),
    );
    registry = registryFactory(db, {
      cwd: paths.cwd,
      sessionDir: paths.sessionDir,
    });
    const openLibraryFactory = dependencyValue(
      dependencies.createOpenLibrary,
      dependencies.openLibraryFactory,
      (database: Database) => new OpenLibraryClient(database),
    );
    const openLibrary = openLibraryFactory(db);
    const runtimeFactory =
      dependencies.initializeRuntime ?? dependencies.runtimeInitializer;
    const runtime = runtimeFactory
      ? await runtimeFactory(
          paths,
          options.runtimeDependencies ?? dependencies.runtimeDependencies,
        )
      : await initializeAgentRuntime(
          paths,
          options.runtimeDependencies ?? dependencies.runtimeDependencies,
        );

    const turnOptions: TurnCoordinatorOptions = {
      registry,
      library,
      runtime,
      proposalRegistry: registry,
    };
    const turns = dependencies.createTurnCoordinator
      ? dependencies.createTurnCoordinator(turnOptions)
      : dependencies.turnCoordinatorFactory
        ? dependencies.turnCoordinatorFactory(turnOptions)
        : new TurnCoordinator(turnOptions);

    const probeTools = makeProbeTools(library, registry);
    const probe = dependencies.startupProbe ?? dependencies.probe;
    if (runtime.model && !runtime.libraryOnlyReason) {
      if (probe) {
        await probe(runtime, probeTools, noOpCitationCapture());
      } else {
        await createStartupProbe(
          runtime,
          probeTools,
          noOpCitationCapture() as never,
        );
      }
    }

    const httpDependencies: HttpDependencies = {
      library,
      registry,
      proposalRegistry: registry,
      openLibrary,
      turns,
    };
    const httpFactory =
      dependencies.createHttpServer ?? dependencies.httpServerFactory;
    server = httpFactory
      ? httpFactory(httpDependencies)
      : createHttpServer(httpDependencies);

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        let failure: unknown;
        try {
          if (server) await closeServer(server);
        } catch (error) {
          failure = error;
        }
        try {
          registry?.close();
        } catch (error) {
          failure ??= error;
        }
        try {
          if (db) closeDatabase(db);
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
      })();
      return shutdownPromise;
    };

    return {
      paths,
      db,
      database: db,
      library,
      registry,
      conversations: registry,
      openLibrary,
      openLibraryClient: openLibrary,
      runtime,
      turns,
      coordinator: turns,
      server: server as HttpServer,
      httpServer: server as HttpServer,
      shutdown,
    };
  } catch (error) {
    try {
      registry?.close();
    } finally {
      if (db) closeDatabase(db);
    }
    throw error;
  }
}

export async function createApplication(
  options: ApplicationOptions | StartupPaths = {},
  dependencies?: StartupDependencies,
): Promise<Application> {
  const normalized = normalizeApplicationArguments(options, dependencies);
  return composeApplication(normalized.options, normalized.dependencies);
}

function requestedPort(options: ApplicationOptions): number {
  const value =
    options.port ??
    (process.env.PORT === undefined ? DEFAULT_PORT : Number(process.env.PORT));
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw configurationError("Port must be an integer from 0 through 65535");
  }
  return value;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      rejectPromise(error);
    };
    server.once("error", onError);
    try {
      server.listen(port, host, () => {
        server.off("error", onError);
        resolvePromise();
      });
    } catch (error) {
      server.off("error", onError);
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function startApplication(
  options: ApplicationOptions | StartupPaths = {},
  dependencies?: StartupDependencies,
): Promise<Application> {
  const normalized = normalizeApplicationArguments(options, dependencies);
  const host = normalized.options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw configurationError("Book Explorer may bind only to 127.0.0.1");
  }
  const application = await composeApplication(
    normalized.options,
    normalized.dependencies,
  );
  const port = requestedPort(normalized.options);
  try {
    await listen(application.server, port, host);
  } catch (error) {
    await application.shutdown().catch(() => undefined);
    throw error;
  }
  const address = application.server.address();
  const actualPort =
    address && typeof address !== "string" ? address.port : port;
  return { ...application, host, port: actualPort };
}

export async function shutdownApplication(
  application: Application,
): Promise<void> {
  await application.shutdown();
}

export const bootstrap = createApplication;
export const startServer = startApplication;

async function runMain(): Promise<void> {
  const application = await startApplication();
  const address = application.server.address();
  const port =
    address && typeof address !== "string"
      ? address.port
      : (application.port ?? DEFAULT_PORT);
  console.log(`Book Explorer listening at http://127.0.0.1:${port}`);
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void application.shutdown().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))
) {
  void runMain().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
