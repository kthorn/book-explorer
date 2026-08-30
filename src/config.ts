import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PINNED_WEB_SEARCH_CONFIG = {
  provider: "openai",
  openaiSearchProviders: ["openai-codex"],
  workflow: "none",
  tools: {
    sourceCheck: { enabled: false },
    fetchContent: { enabled: false },
    getSearchContent: { enabled: false },
  },
} as const;

export interface ApplicationPaths {
  dataDir: string;
  agentDir: string;
  cwd: string;
  authPath: string;
  modelsPath: string;
  modelsStorePath: string;
  webSearchConfigPath: string;
  webSearchCacheDir: string;
}

export interface ApplicationPathsInput {
  dataDir?: string;
  appDataDir?: string;
  appDir?: string;
  rootDir?: string;
  agentDir?: string;
  appAgentDir?: string;
  cwd?: string;
  appCwd?: string;
  authPath?: string;
  authFile?: string;
  modelsPath?: string;
  modelsFile?: string;
  modelsStorePath?: string;
  modelsStoreFile?: string;
  webSearchConfigPath?: string;
  configPath?: string;
  webSearchCacheDir?: string;
  cacheDir?: string;
}

export class ConfigurationError extends Error {
  readonly code = "invalid_configuration";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

function requiredPath(value: unknown, label: string, preserveTilde = false): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${label} must be a non-empty path`);
  }
  return preserveTilde ? value.trim() : resolve(value.trim());
}

export function resolveApplicationPaths(input: ApplicationPaths | ApplicationPathsInput): ApplicationPaths {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigurationError("Application paths must be an object");
  }
  const value = input as ApplicationPathsInput;
  const dataDir = requiredPath(
    value.dataDir ?? value.appDataDir ?? value.appDir ?? value.rootDir ?? value.agentDir ?? value.appAgentDir,
    "Application data directory",
  );
  const agentDir = requiredPath(
    value.agentDir ?? value.appAgentDir ?? join(dataDir, "agent"),
    "Application agent directory",
  );
  return {
    dataDir,
    agentDir,
    cwd: requiredPath(value.cwd ?? value.appCwd ?? dataDir, "Application cwd"),
    authPath: requiredPath(
      value.authPath ?? value.authFile ?? join(homedir(), ".pi", "agent", "auth.json"),
      "Pi auth path",
      true,
    ),
    modelsPath: requiredPath(value.modelsPath ?? value.modelsFile ?? join(agentDir, "models.json"), "Application models path"),
    modelsStorePath: requiredPath(
      value.modelsStorePath ?? value.modelsStoreFile ?? join(agentDir, "models-store.json"),
      "Application models store path",
    ),
    webSearchConfigPath: requiredPath(
      value.webSearchConfigPath ?? value.configPath ?? join(agentDir, "web-search.json"),
      "Web search config path",
    ),
    webSearchCacheDir: requiredPath(
      value.webSearchCacheDir ?? value.cacheDir ?? join(agentDir, "web-search-cache"),
      "Web search cache directory",
    ),
  };
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactPinnedConfig(value: Record<string, unknown>, allowMissing = false): void {
  if (Object.hasOwn(value, "openaiApiKey")) {
    throw new ConfigurationError("web-search.json must not contain openaiApiKey");
  }
  if (allowMissing && !Object.hasOwn(value, "provider") && !Object.hasOwn(value, "openaiSearchProviders") && !Object.hasOwn(value, "workflow") && !Object.hasOwn(value, "tools")) {
    return;
  }
  if (value.provider !== PINNED_WEB_SEARCH_CONFIG.provider) {
    throw new ConfigurationError('web-search.json provider must be "openai"');
  }
  if (!Array.isArray(value.openaiSearchProviders) || value.openaiSearchProviders.length !== 1 || value.openaiSearchProviders[0] !== "openai-codex") {
    throw new ConfigurationError('web-search.json openaiSearchProviders must be ["openai-codex"]');
  }
  if (value.workflow !== PINNED_WEB_SEARCH_CONFIG.workflow) {
    throw new ConfigurationError('web-search.json workflow must be "none"');
  }
  const tools = objectRecord(value.tools, "web-search.json tools");
  for (const name of ["sourceCheck", "fetchContent", "getSearchContent"]) {
    const tool = objectRecord(tools[name], `web-search.json tools.${name}`);
    if (tool.enabled !== false) {
      throw new ConfigurationError(`web-search.json tools.${name}.enabled must be false`);
    }
  }
}

export function validateWebSearchConfig(value: unknown): void {
  exactPinnedConfig(objectRecord(value, "web-search.json"));
}

function readConfig(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ConfigurationError(`Web search config path is not a regular file: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigurationError(`Failed to parse ${path}`, { cause: error });
  }
  const config = objectRecord(parsed, path);
  exactPinnedConfig(config, true);
  return config;
}

function ensureDirectory(path: string, label: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ConfigurationError(`${label} is not a safe directory: ${path}`);
    }
    if (process.platform !== "win32") chmodSync(path, 0o700);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`Cannot secure ${label}: ${path}`, { cause: error });
  }
}

export function writeWebSearchConfig(paths: ApplicationPaths | ApplicationPathsInput): ApplicationPaths {
  const resolved = resolveApplicationPaths(paths);
  readConfig(resolved.webSearchConfigPath);
  ensureDirectory(dirname(resolved.webSearchConfigPath), "web search config directory");
  const serialized = `${JSON.stringify(PINNED_WEB_SEARCH_CONFIG, null, 2)}\n`;
  writeFileSync(resolved.webSearchConfigPath, serialized, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(resolved.webSearchConfigPath, 0o600);
  validateWebSearchConfig(JSON.parse(serialized));
  return resolved;
}

export function resetWebSearchCache(paths: ApplicationPaths | ApplicationPathsInput): string {
  const resolved = resolveApplicationPaths(paths);
  try {
    rmSync(resolved.webSearchCacheDir, { recursive: true, force: true });
  } catch (error) {
    throw new ConfigurationError(`Cannot remove stale web search cache: ${resolved.webSearchCacheDir}`, { cause: error });
  }
  ensureDirectory(resolved.webSearchCacheDir, "web search cache directory");
  return resolved.webSearchCacheDir;
}

export function ensureWebSearchCache(paths: ApplicationPaths | ApplicationPathsInput): string {
  const resolved = resolveApplicationPaths(paths);
  ensureDirectory(resolved.webSearchCacheDir, "web search cache directory");
  return resolved.webSearchCacheDir;
}

/** Configure extension paths and scrub API-key fallbacks before extension loading. */
export function prepareWebSearchEnvironment(paths: ApplicationPaths | ApplicationPathsInput): ApplicationPaths {
  const resolved = writeWebSearchConfig(paths);
  resetWebSearchCache(resolved);
  process.env.PI_CODING_AGENT_DIR = resolved.agentDir;
  delete process.env.OPENAI_API_KEY;
  return resolved;
}

export function scrubWebSearchEnvironment(paths: ApplicationPaths | ApplicationPathsInput): ApplicationPaths {
  const resolved = resolveApplicationPaths(paths);
  process.env.PI_CODING_AGENT_DIR = resolved.agentDir;
  delete process.env.OPENAI_API_KEY;
  return resolved;
}

export function isPiOffline(value = process.env.PI_OFFLINE): boolean {
  return typeof value === "string" && ["1", "true", "yes"].includes(value.trim().toLowerCase());
}
