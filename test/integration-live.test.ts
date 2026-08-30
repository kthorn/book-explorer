import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { startApplication } from "../src/main.js";
import { PINNED_MODEL } from "../src/agent-runtime.js";
import type { BrowserStreamEvent } from "../src/turns.js";

const live = process.env.BOOK_EXPLORER_LIVE_TEST === "1";

test(
  "live Pi OAuth, Codex search citations, streaming, and refresh locking",
  {
    skip: !live,
  },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "book-explorer-live-"));
    let application: Awaited<ReturnType<typeof startApplication>> | undefined;
    try {
      application = await startApplication({ port: 0, dataDir });
      assert.equal(application.runtime.oauthReady, true);
      assert.equal(
        `${application.runtime.model?.provider}/${application.runtime.model?.id}`,
        PINNED_MODEL,
      );

      const address = application.server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const headers = {
        "content-type": "application/json",
        host: `127.0.0.1:${address.port}`,
        origin,
        "x-csrf-token": application.server.csrfToken,
      };
      const conversationResponse = await fetch(`${origin}/api/conversations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "live integration" }),
      });
      assert.equal(conversationResponse.status, 201);
      const conversation = (await conversationResponse.json()) as {
        id: number;
      };

      const cliPath =
        process.env.PI_CLI_PATH ??
        resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
      const child = spawn(
        process.execPath,
        [cliPath, "auth", "check", "--provider", "openai-codex"],
        {
          cwd: dataDir,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: dirname(application.paths.authPath),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const refresh = application.runtime.runtime.refresh({
        allowNetwork: true,
        providers: ["openai-codex"],
        signal: AbortSignal.timeout(10_000),
      });
      const [childResult, refreshResult] = await Promise.all([
        once(child, "exit"),
        refresh,
      ]);
      assert.equal((childResult as [number | null])[0], 0);
      assert.equal(refreshResult.aborted, false);
      assert.equal(refreshResult.errors.size, 0);

      const response = await fetch(
        `${origin}/api/conversations/${conversation.id}/messages`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            text: "Use web search to recommend one science-fiction book, then record the recommendation with its researched citations.",
          }),
        },
      );
      assert.equal(response.status, 200);
      const body = await response.text();
      const events = body
        .split("\n\n")
        .filter((block) => block.startsWith("data: "))
        .map(
          (block) =>
            JSON.parse(block.slice("data: ".length)) as BrowserStreamEvent,
        );
      assert.ok(events.some((event) => event.type === "text_delta"));
      assert.ok(events.some((event) => event.type === "citation"));
      assert.ok(events.some((event) => event.type === "complete"));
    } finally {
      await application?.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
