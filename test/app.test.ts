import assert from "node:assert/strict";
import test from "node:test";

import { FakeDocument } from "./fake-dom.js";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async (): Promise<string> => JSON.stringify(body),
  };
}

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

class StreamReader {
  private readonly queued: Array<
    { done: false; value: Uint8Array } | { done: true }
  > = [];
  private waiting?: (
    result: { done: false; value: Uint8Array } | { done: true },
  ) => void;

  read(): Promise<{ done: false; value: Uint8Array } | { done: true }> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  emit(event: unknown): void {
    this.push({
      done: false,
      value: new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
    });
  }

  finish(): void {
    this.push({ done: true });
  }

  private push(
    result: { done: false; value: Uint8Array } | { done: true },
  ): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(result);
    } else {
      this.queued.push(result);
    }
  }
}

test("streaming submissions preserve steering chronology without dropping messages", async () => {
  const document = new FakeDocument();
  document.getElementById("csrf-token").textContent = JSON.stringify("csrf");
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const pendingSteers: Array<(response: ReturnType<typeof jsonResponse>) => void> =
    [];
  const stream = new StreamReader();
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  Object.assign(globalThis, {
    document,
    window: { setTimeout: () => 0 },
    fetch: async (path: string, options?: RequestInit) => {
      calls.push({ path, options });
      if (path.endsWith("/messages")) {
        return {
          ok: true,
          status: 200,
          body: { getReader: () => stream },
          text: async (): Promise<string> => "",
        };
      }
      if (path.endsWith("/steer")) {
        const steeringCount = calls.filter((call) =>
          call.path.endsWith("/steer"),
        ).length;
        if (steeringCount > 2) {
          return jsonResponse(
            { error: { message: "Turn no longer active" } },
            409,
          );
        }
        return new Promise((resolve) => pendingSteers.push(resolve));
      }
      if (path === "/api/conversations?archived=false&limit=100&offset=0") {
        return jsonResponse({ items: [{ id: 1, name: "Books" }] });
      }
      if (path === "/api/conversations/1") {
        return jsonResponse({ id: 1, name: "Books", transcript: [] });
      }
      if (path === "/api/conversations/1/proposals") return jsonResponse([]);
      throw new Error(`Unexpected request: ${path}`);
    },
  });

  try {
    await import(new URL("../../public/app.js", import.meta.url).href);
    while (
      !calls.some(
        ({ path }) => path === "/api/conversations/1/proposals",
      )
    ) {
      await nextTurn();
    }

    const form = document.getElementById("message-form");
    const input = document.getElementById("message-input");
    const transcript = document.getElementById("transcript");
    input.value = "first";
    const first = form.dispatch("submit");
    while (
      !calls.some(({ path }) => path === "/api/conversations/1/messages")
    ) {
      await nextTurn();
    }
    stream.emit({ type: "text_delta", delta: "Before steering" });
    await nextTurn();
    const originalTranscriptLength = transcript.children.length;
    assert.match(transcript.children[1]!.textContent, /Before steering/u);

    input.value = "focus on sequels";
    const second = form.dispatch("submit");
    await nextTurn();
    input.value = "and compare the adaptations";
    const third = form.dispatch("submit");
    await nextTurn();

    const steeringCalls = calls.filter(({ path }) => path.endsWith("/steer"));
    assert.deepEqual(
      steeringCalls.map(({ options }) => ({
        method: options?.method,
        body: options?.body,
      })),
      [
        { method: "POST", body: JSON.stringify({ text: "focus on sequels" }) },
        {
          method: "POST",
          body: JSON.stringify({ text: "and compare the adaptations" }),
        },
      ],
    );

    pendingSteers[0]!(jsonResponse({ steered: true }, 202));
    await second;
    assert.equal(transcript.children.length, originalTranscriptLength);
    assert.equal(input.value, "and compare the adaptations");
    stream.emit({
      type: "assistant_start",
      steering: ["focus on sequels"],
    });
    await nextTurn();
    stream.emit({ type: "text_delta", delta: "After first steering" });
    await nextTurn();

    pendingSteers[1]!(jsonResponse({ steered: true }, 202));
    await third;
    assert.equal(transcript.children.length, originalTranscriptLength + 2);
    assert.equal(input.value, "");
    stream.emit({
      type: "assistant_start",
      steering: ["and compare the adaptations"],
    });
    await nextTurn();
    stream.emit({ type: "text_delta", delta: "After second steering" });
    await nextTurn();

    assert.deepEqual(
      transcript.children.map(
        (child) => child.attributes["data-role"] ?? "assistant",
      ),
      ["user", "assistant", "user", "assistant", "user", "assistant"],
    );
    assert.match(transcript.children[1]!.textContent, /Before steering/u);
    assert.match(transcript.children[2]!.textContent, /focus on sequels/u);
    assert.match(transcript.children[3]!.textContent, /After first steering/u);
    assert.match(
      transcript.children[4]!.textContent,
      /and compare the adaptations/u,
    );
    assert.match(transcript.children[5]!.textContent, /After second steering/u);

    input.value = "preserve this";
    await form.dispatch("submit");
    assert.equal(input.value, "preserve this");
    assert.equal(
      document.getElementById("toast-message").textContent,
      "Turn no longer active",
    );

    stream.finish();
    await first;
  } finally {
    Object.assign(globalThis, {
      document: originalDocument,
      window: originalWindow,
      fetch: originalFetch,
    });
  }
});
