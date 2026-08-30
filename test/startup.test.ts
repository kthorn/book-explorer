import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  createApplication,
  ensureApplicationStorage,
  resolveStartupPaths,
  startApplication,
  type Application,
  type StartupPaths,
} from "../src/main.js";
import { closeDatabase, openDatabase } from "../src/db.js";
import type { AgentRuntimeState } from "../src/agent-runtime.js";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function permissionBits(path: string): number {
  return statSync(path).mode & 0o7777;
}

function fixture(): { root: string; paths: StartupPaths } {
  const root = mkdtempSync(join(tmpdir(), "book-explorer-startup-"));
  return { root, paths: resolveStartupPaths({ dataDir: root }) };
}

function libraryOnlyRuntime(paths: StartupPaths): AgentRuntimeState {
  return {
    runtime: {
      getModel: () => undefined,
      checkAuth: async () => ({ type: "oauth" as const }),
      refresh: async () => ({ aborted: false, errors: new Map() }),
    } as never,
    paths,
    dependencies: {},
    libraryOnlyReason: "offline",
    oauthReady: true,
  };
}

function fakeApplicationDependencies(paths: StartupPaths) {
  return {
    initializeRuntime: async () => libraryOnlyRuntime(paths),
  };
}

async function cleanupApplication(
  application: Application | undefined,
): Promise<void> {
  if (application) await application.shutdown();
}

test("startup resolves XDG and default data roots", () => {
  const xdg = mkdtempSync(join(tmpdir(), "book-explorer-xdg-"));
  const home = mkdtempSync(join(tmpdir(), "book-explorer-home-"));
  const fromXdg = resolveStartupPaths({
    env: { XDG_DATA_HOME: xdg },
    homeDir: home,
  });
  assert.equal(fromXdg.dataDir, join(xdg, "book-explorer"));

  const fromDefault = resolveStartupPaths({ env: {}, homeDir: home });
  assert.equal(
    fromDefault.dataDir,
    join(home, ".local", "share", "book-explorer"),
  );
  assert.equal(fromDefault.sessionDir, join(fromDefault.dataDir, "sessions"));
  assert.equal(
    fromDefault.databasePath,
    join(fromDefault.dataDir, "book-explorer.sqlite"),
  );
});

test("startup clears stale cache before recreating its private directory", () => {
  const item = fixture();
  const cache = item.paths.webSearchCacheDir;
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  writeFileSync(join(cache, "stale.json"), "stale");
  ensureApplicationStorage(item.paths, { platform: "linux" });
  assert.equal(existsSync(join(cache, "stale.json")), false);
  assert.equal(mode(cache), 0o700);
});

test("startup applies every POSIX storage mode", () => {
  const item = fixture();
  ensureApplicationStorage(item.paths, { platform: "linux" });
  for (const directory of [
    item.paths.dataDir,
    item.paths.agentDir,
    item.paths.sessionDir,
    item.paths.webSearchCacheDir,
  ]) {
    assert.equal(mode(directory), 0o700, directory);
  }
  for (const file of [
    item.paths.databasePath,
    item.paths.modelsPath,
    item.paths.modelsStorePath,
    item.paths.webSearchConfigPath,
  ]) {
    assert.equal(mode(file), 0o600, file);
  }
});

test("startup fails rather than repairing unsafe existing permissions", () => {
  const item = fixture();
  mkdirSync(item.paths.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(item.paths.dataDir, 0o755);
  assert.throws(
    () => ensureApplicationStorage(item.paths, { platform: "linux" }),
    /permission|mode|private|unsafe/i,
  );
});

test("startup rejects POSIX special bits instead of masking them away", () => {
  const directory = fixture();
  ensureApplicationStorage(directory.paths, { platform: "linux" });
  chmodSync(directory.paths.dataDir, 0o2700);
  assert.equal(permissionBits(directory.paths.dataDir), 0o2700);
  assert.throws(
    () => ensureApplicationStorage(directory.paths, { platform: "linux" }),
    /permission|mode|unsafe/i,
  );

  const file = fixture();
  ensureApplicationStorage(file.paths, { platform: "linux" });
  chmodSync(file.paths.modelsPath, 0o1600);
  assert.equal(permissionBits(file.paths.modelsPath), 0o1600);
  assert.throws(
    () => ensureApplicationStorage(file.paths, { platform: "linux" }),
    /permission|mode|unsafe/i,
  );
});

test("startup warns about broadly accessible Windows data through injected platform checks", () => {
  const item = fixture();
  const warnings: string[] = [];
  ensureApplicationStorage(item.paths, {
    platform: "win32",
    isBroadlyAccessible: () => true,
    warn: (message: string) => warnings.push(message),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Windows|ACL|accessible/i);
});

test("startup verifies real JSONL and SQLite WAL/SHM files as private files", () => {
  const item = fixture();
  ensureApplicationStorage(item.paths, { platform: "linux" });
  const manager = SessionManager.create(item.paths.cwd, item.paths.sessionDir);
  const sessionPath = manager.getSessionFile();
  const header = manager.getHeader();
  assert.ok(sessionPath && header);
  writeFileSync(sessionPath, `${JSON.stringify(header)}\n`, { mode: 0o600 });
  manager.setSessionFile(sessionPath);
  manager.appendCustomEntry("startup-test", { ok: true });

  const db = openDatabase(item.paths.databasePath);
  try {
    db.prepare("INSERT INTO series (name, normalized_name) VALUES (?, ?)").run(
      "Test",
      "test",
    );
    for (const file of [
      sessionPath,
      `${item.paths.databasePath}-wal`,
      `${item.paths.databasePath}-shm`,
    ]) {
      assert.equal(permissionBits(file), 0o600, file);
    }
    chmodSync(sessionPath, 0o640);
    assert.throws(
      () => ensureApplicationStorage(item.paths, { platform: "linux" }),
      /permission|mode|unsafe/i,
    );
    chmodSync(sessionPath, 0o600);
    for (const sidecar of [
      `${item.paths.databasePath}-wal`,
      `${item.paths.databasePath}-shm`,
    ]) {
      chmodSync(sidecar, 0o640);
      assert.throws(
        () => ensureApplicationStorage(item.paths, { platform: "linux" }),
        /permission|mode|unsafe/i,
      );
      chmodSync(sidecar, 0o600);
    }
  } finally {
    closeDatabase(db);
  }
});

test("startup rejects dangling symlinks for database, config, and sidecars", () => {
  for (const target of ["database", "config", "sidecar"]) {
    const item = fixture();
    ensureApplicationStorage(item.paths, { platform: "linux" });
    const path =
      target === "database"
        ? item.paths.databasePath
        : target === "config"
          ? item.paths.webSearchConfigPath
          : `${item.paths.databasePath}-wal`;
    if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
    unlinkSync(path);
    symlinkSync(join(item.root, "missing-target"), path);
    assert.throws(
      () => ensureApplicationStorage(item.paths, { platform: "linux" }),
      /symbolic|symlink|regular|safe/i,
      target,
    );
  }
});

test("startup propagates migration failure before composing the application", async () => {
  const item = fixture();
  await assert.rejects(
    () =>
      createApplication(
        { paths: item.paths },
        {
          openDatabase: () => {
            throw new Error("migration failed");
          },
          initializeRuntime: async () => {
            throw new Error("must not run");
          },
        },
      ),
    /migration failed/i,
  );
});

test("startup rejects missing and corrupt referenced sessions", async () => {
  for (const corrupt of [false, true]) {
    const item = fixture();
    ensureApplicationStorage(item.paths, { platform: "linux" });
    const db = openDatabase(item.paths.databasePath);
    db.prepare(
      "INSERT INTO conversations (name, session_filename) VALUES (?, ?)",
    ).run("Broken", "broken.jsonl");
    if (corrupt)
      writeFileSync(join(item.paths.sessionDir, "broken.jsonl"), "not json\n", {
        mode: 0o600,
      });
    closeDatabase(db);
    await assert.rejects(
      () =>
        createApplication(
          { paths: item.paths },
          fakeApplicationDependencies(item.paths),
        ),
      /data recovery|session|header|missing|valid/i,
    );
  }
});

test("startup fails when OAuth is unavailable", async () => {
  const item = fixture();
  await assert.rejects(
    () =>
      createApplication(
        { paths: item.paths },
        {
          initializeRuntime: async () => {
            throw new Error("missing OAuth credential");
          },
        },
      ),
    /OAuth/i,
  );
});

test("startup turns an injected catalog refresh failure into library-only state", async () => {
  const item = fixture();
  const runtime = {
    getModel: () => ({ provider: "openai-codex", id: "gpt-5.6-sol" }),
    checkAuth: async () => ({ type: "oauth" as const }),
    refresh: async () => ({
      aborted: false,
      errors: new Map([["openai-codex", new Error("catalog unavailable")]]),
    }),
  };
  const application = await createApplication({
    paths: item.paths,
    runtimeDependencies: {
      runtimeFactory: async () => runtime as never,
      credentialReader: () =>
        ({
          type: "oauth",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        }) as never,
    },
  });
  try {
    assert.equal(application.runtime.model, undefined);
    assert.match(
      application.runtime.libraryOnlyReason ?? "",
      /catalog|refresh/i,
    );
  } finally {
    await cleanupApplication(application);
  }
});

test("startup rejects an invalid port before opening application resources", async () => {
  const item = fixture();
  let composed = false;
  await assert.rejects(
    () =>
      startApplication(
        { paths: item.paths, port: 65_536 },
        {
          openDatabase: () => {
            composed = true;
            throw new Error("composition should not run");
          },
        },
      ),
    /port/i,
  );
  assert.equal(composed, false);
});

test("startup rejects a second active composition until the first is closed", async () => {
  const firstItem = fixture();
  const secondItem = fixture();
  const first = await createApplication(
    { paths: firstItem.paths },
    fakeApplicationDependencies(firstItem.paths),
  );
  try {
    await assert.rejects(
      () =>
        createApplication(
          { paths: secondItem.paths },
          fakeApplicationDependencies(secondItem.paths),
        ),
      /active|already|application|composition/i,
    );
    await first.shutdown();
    const second = await createApplication(
      { paths: secondItem.paths },
      fakeApplicationDependencies(secondItem.paths),
    );
    await second.shutdown();
  } finally {
    await cleanupApplication(first);
  }
});

test("startup composes one coordinator and binds only loopback", async () => {
  const item = fixture();
  const application = await startApplication(
    { paths: item.paths, port: 0 },
    fakeApplicationDependencies(item.paths),
  );
  try {
    const address = application.server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
    assert.equal(application.server, application.httpServer);
    assert.equal(application.turns, application.coordinator);
    assert.equal(application.db, application.database);
  } finally {
    await application.shutdown();
  }
});

void SessionManager;
