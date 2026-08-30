import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
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

function cleanupApplication(application: Application | undefined): void {
  if (application) {
    void application.shutdown();
  }
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

test("startup fails when OAuth is unavailable but allows catalog failure as library-only", async () => {
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

  const application = await createApplication(
    { paths: item.paths },
    fakeApplicationDependencies(item.paths),
  );
  assert.equal(application.runtime.libraryOnlyReason, "offline");
  cleanupApplication(application);
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
