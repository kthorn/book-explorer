import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  initializeAgentRuntime,
  createTurnLoader,
  type AgentRuntimeState,
  type RuntimeDependencies,
} from "../src/agent-runtime.js";
import {
  ACTIVE_TOOL_NAMES,
  type CitationCapture,
} from "../src/search-guard.js";
import {
  PINNED_WEB_SEARCH_CONFIG,
  resolveApplicationPaths,
  type ApplicationPaths,
} from "../src/config.js";

interface FakeModel {
  provider: string;
  id: string;
}

interface ExpectedState {
  runtime: FakeRuntime;
  model?: FakeModel;
  thinkingLevel?: string;
  libraryOnlyReason?: string;
  dependencies: RuntimeDependencies;
  paths: ApplicationPaths;
}

interface RuntimeOptions {
  authPath: string;
  modelsPath: string;
  modelsStorePath: string;
  refreshOnCreate: false;
}

interface FakeRuntime {
  getModel(provider: string, id: string): FakeModel | undefined;
  checkAuth(
    provider: string,
  ): Promise<{ type: "oauth" | "api_key" } | undefined>;
  refresh(options: {
    allowNetwork: boolean;
    providers: readonly string[];
    signal: AbortSignal;
  }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
}

function pathsFixture(): { directory: string; paths: ApplicationPaths } {
  const directory = mkdtempSync(join(tmpdir(), "book-explorer-runtime-"));
  const agentDir = join(directory, "agent");
  const authPath = join(directory, "pi-auth.json");
  mkdirSync(agentDir, { recursive: true });
  return {
    directory,
    paths: {
      dataDir: directory,
      agentDir,
      cwd: join(directory, "cwd"),
      authPath,
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      webSearchConfigPath: join(agentDir, "web-search.json"),
      webSearchCacheDir: join(agentDir, "web-search-cache"),
    },
  };
}

function oauthCredential(): Record<string, unknown> {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  };
}

function runtimeFixture(
  options: {
    model?: FakeModel | null;
    auth?: { type: "oauth" | "api_key" };
    refresh?: () => Promise<{
      aborted: boolean;
      errors: ReadonlyMap<string, Error>;
    }>;
  } = {},
): {
  runtime: FakeRuntime;
  dependencies: RuntimeDependencies;
  calls: { runtime: unknown[]; refresh: unknown[] };
} {
  const calls = { runtime: [] as unknown[], refresh: [] as unknown[] };
  const runtime: FakeRuntime = {
    getModel: (provider, id) =>
      provider === "openai-codex" && id === "gpt-5.6-sol"
        ? options.model === null
          ? undefined
          : (options.model ?? { provider, id })
        : undefined,
    checkAuth: async () => options.auth ?? { type: "oauth" },
    refresh: async (refreshOptions) => {
      calls.refresh.push(refreshOptions);
      return options.refresh
        ? options.refresh()
        : { aborted: false, errors: new Map() };
    },
  };
  return {
    runtime,
    calls,
    dependencies: {
      runtimeFactory: async (runtimeOptions: RuntimeOptions) => {
        calls.runtime.push(runtimeOptions);
        return runtime;
      },
      credentialReader: () => oauthCredential() as never,
    },
  };
}

function cleanup(fixture: { directory: string }): void {
  rmSync(fixture.directory, { recursive: true, force: true });
}

async function withOffline<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.PI_OFFLINE;
  if (value === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  }
}

test("runtime selects exactly the Sol model with medium thinking and app-local model paths", async () => {
  const fixture = pathsFixture();
  try {
    const { runtime, dependencies, calls } = runtimeFixture();
    const state = (await withOffline(undefined, () =>
      initializeAgentRuntime(fixture.paths, dependencies),
    )) as unknown as ExpectedState;
    assert.equal(state.runtime, runtime);
    assert.deepEqual(state.model, {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
    });
    assert.equal(state.thinkingLevel, "medium");
    assert.equal(state.libraryOnlyReason, undefined);
    assert.equal(calls.runtime.length, 1);
    assert.deepEqual(calls.runtime[0], {
      authPath: fixture.paths.authPath,
      modelsPath: fixture.paths.modelsPath,
      modelsStorePath: fixture.paths.modelsStorePath,
      refreshOnCreate: false,
    });
    assert.deepEqual(
      JSON.parse(readFileSync(fixture.paths.webSearchConfigPath, "utf8")),
      PINNED_WEB_SEARCH_CONFIG,
    );
    assert.ok(existsSync(fixture.paths.webSearchCacheDir));
  } finally {
    cleanup(fixture);
  }
});

test("PI_OFFLINE accepts the three documented truthy values and starts library-only", async () => {
  for (const value of ["1", "true", "TRUE", "yes", "YeS"]) {
    const fixture = pathsFixture();
    try {
      const { dependencies, calls } = runtimeFixture();
      const state = (await withOffline(value, () =>
        initializeAgentRuntime(fixture.paths, dependencies),
      )) as unknown as ExpectedState;
      assert.equal(state.model, undefined, value);
      assert.equal(state.libraryOnlyReason, "offline", value);
      assert.equal(calls.refresh.length, 0, value);
    } finally {
      cleanup(fixture);
    }
  }
});

test("runtime rejects missing, expired, and non-OAuth Codex credentials before model use", async () => {
  for (const credential of [
    undefined,
    { ...oauthCredential(), expires: Date.now() - 1 },
    { type: "api_key" },
  ]) {
    const fixture = pathsFixture();
    try {
      const { dependencies } = runtimeFixture({
        auth:
          credential?.type === "api_key"
            ? { type: "api_key" }
            : { type: "oauth" },
      });
      dependencies.credentialReader = () => credential as never;
      await assert.rejects(
        () => initializeAgentRuntime(fixture.paths, dependencies),
        (error: unknown) =>
          error instanceof Error &&
          /OAuth|expired|openai-codex/i.test(error.message),
      );
    } finally {
      cleanup(fixture);
    }
  }
});

test("runtime inspects explicit refresh abort and provider errors as library-only", async () => {
  for (const refresh of [
    async () => ({ aborted: true, errors: new Map<string, Error>() }),
    async () => ({
      aborted: false,
      errors: new Map([["openai-codex", new Error("catalog failed")]]),
    }),
    async () => {
      throw new Error("catalog timed out");
    },
  ]) {
    const fixture = pathsFixture();
    try {
      const { dependencies } = runtimeFixture({ refresh });
      const state = (await withOffline(undefined, () =>
        initializeAgentRuntime(fixture.paths, dependencies),
      )) as unknown as ExpectedState;
      assert.equal(state.model, undefined);
      assert.match(state.libraryOnlyReason ?? "", /refresh|catalog/i);
    } finally {
      cleanup(fixture);
    }
  }
});

test("runtime rejects a non-OAuth result even when the catalog model exists", async () => {
  const fixture = pathsFixture();
  try {
    const { dependencies } = runtimeFixture({ auth: { type: "api_key" } });
    await assert.rejects(
      () => initializeAgentRuntime(fixture.paths, dependencies),
      /OAuth/i,
    );
  } finally {
    cleanup(fixture);
  }
});

test("unavailable pinned model is library-only without selecting another model", async () => {
  const fixture = pathsFixture();
  try {
    const { dependencies } = runtimeFixture({ model: null });
    const state = (await initializeAgentRuntime(
      fixture.paths,
      dependencies,
    )) as unknown as ExpectedState;
    assert.equal(state.model, undefined);
    assert.match(state.libraryOnlyReason ?? "", /model/i);
  } finally {
    cleanup(fixture);
  }
});

test("config rejects openaiApiKey and scrubs credentials before extension loading", async () => {
  const fixture = pathsFixture();
  const previousKey = process.env.OPENAI_API_KEY;
  try {
    writeFileSync(
      fixture.paths.webSearchConfigPath,
      JSON.stringify({ openaiApiKey: "must-not-be-used" }),
    );
    const { dependencies } = runtimeFixture();
    let imported = false;
    dependencies.extensionImporter = async () => {
      imported = true;
      assert.equal(process.env.PI_CODING_AGENT_DIR, fixture.paths.agentDir);
      assert.equal(process.env.OPENAI_API_KEY, undefined);
    };
    dependencies.loaderFactory = () => ({ reload: async () => {} }) as never;
    process.env.OPENAI_API_KEY = "must-not-be-used";
    await assert.rejects(
      () => initializeAgentRuntime(fixture.paths, dependencies),
      /openaiApiKey/i,
    );
    assert.equal(imported, false);

    rmSync(fixture.paths.webSearchConfigPath, { force: true });
    const state = (await initializeAgentRuntime(
      fixture.paths,
      dependencies,
    )) as unknown as ExpectedState;
    const capture: CitationCapture = new Map();
    const loader = await createTurnLoader(
      state as unknown as AgentRuntimeState,
      [],
      capture,
    );
    assert.ok(loader);
    assert.equal(imported, true);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    cleanup(fixture);
  }
});

test("web-search config and cache overrides must stay under the application agent directory", () => {
  const fixture = pathsFixture();
  try {
    assert.throws(
      () =>
        resolveApplicationPaths({
          ...fixture.paths,
          webSearchConfigPath: join(
            fixture.directory,
            "outside",
            "web-search.json",
          ),
        }),
      /agent directory|agentDir|web-search/i,
    );
    assert.throws(
      () =>
        resolveApplicationPaths({
          ...fixture.paths,
          webSearchCacheDir: join(
            fixture.directory,
            "outside",
            "web-search-cache",
          ),
        }),
      /agent directory|agentDir|web-search/i,
    );
  } finally {
    cleanup(fixture);
  }
});

test("actual pi-web-access reads the application agent config after env isolation", async () => {
  const fixture = pathsFixture();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const decoyDir = join(fixture.directory, "decoy-agent");
  try {
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(
      join(decoyDir, "web-search.json"),
      JSON.stringify({ tools: { webSearch: { enabled: false } } }),
    );
    process.env.PI_CODING_AGENT_DIR = decoyDir;
    const { dependencies } = runtimeFixture();
    const state = (await initializeAgentRuntime(
      fixture.paths,
      dependencies,
    )) as unknown as AgentRuntimeState;
    const loader = await createTurnLoader(state, [], new Map());
    const result = loader.getExtensions();
    const extension = result.extensions.find((entry) =>
      entry.path.includes("pi-web-access"),
    );
    assert.ok(extension);
    assert.equal(result.errors.length, 0);
    assert.equal(extension.tools.has("web_search"), true);
    assert.equal(
      state.paths.webSearchConfigPath,
      join(state.paths.agentDir, "web-search.json"),
    );
    assert.equal(
      state.paths.webSearchCacheDir,
      join(state.paths.agentDir, "web-search-cache"),
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    cleanup(fixture);
  }
});

test("turn loader uses only the application directories and exact tool allowlist inputs", async () => {
  const fixture = pathsFixture();
  try {
    const { dependencies } = runtimeFixture();
    const state = (await initializeAgentRuntime(
      fixture.paths,
      dependencies,
    )) as unknown as ExpectedState;
    const observed: unknown[] = [];
    state.dependencies = {
      ...state.dependencies,
      extensionPath: "/extension/pi-web-access.ts",
      loaderFactory: (options: Record<string, unknown>) => {
        observed.push(options);
        return {
          reload: async () => {},
        } as never;
      },
    };
    const loader = await createTurnLoader(
      state as unknown as AgentRuntimeState,
      [],
      new Map(),
    );
    assert.ok(loader);
    const options = observed[0] as Record<string, unknown> & {
      appendSystemPromptOverride?: (base: string[]) => string[];
      systemPromptOverride?: () => string;
    };
    assert.equal(options.cwd, fixture.paths.cwd);
    assert.equal(options.agentDir, fixture.paths.agentDir);
    assert.equal(options.noExtensions, true);
    assert.equal(options.noSkills, true);
    assert.equal(options.noContextFiles, true);
    assert.deepEqual(options.additionalExtensionPaths, [
      "/extension/pi-web-access.ts",
    ]);
    assert.deepEqual(options.appendSystemPromptOverride?.([]), []);
    const systemPrompt = (options.systemPromptOverride as () => string)();
    assert.equal(systemPrompt.includes("includeContent"), true);
    assert.match(systemPrompt, /summarize.*library changes/i);
    assert.match(systemPrompt, /correct.*book detail/i);
    assert.deepEqual(ACTIVE_TOOL_NAMES, [
      "search_library",
      "get_book",
      "upsert_book",
      "upsert_series",
      "record_recommendation",
      "update_library",
      "web_search",
    ]);
  } finally {
    cleanup(fixture);
  }
});
