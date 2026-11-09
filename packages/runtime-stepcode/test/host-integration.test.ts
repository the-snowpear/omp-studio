import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseConversationRuntimeEvent } from "@omp-studio/studio-protocol";

// Type-only path resolves from this source file. The runtime path resolves
// relative to the compiled test, so the suite behaves the same under
// `npm test` in this package and under the repo-wide gate from the root.
type BridgeClientModule = typeof import("../../studio-host/dist/src/bridge-client.js");
const studioHostClient = () => {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../studio-host/dist/src/bridge-client.js"),
    resolve(process.cwd(), "../studio-host/dist/src/bridge-client.js"),
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (found === undefined) throw new Error("studio-host is not built; run the workspace build first");
  return pathToFileURL(found).href;
};
const { StudioBridgeClient } = (await import(studioHostClient())) as BridgeClientModule;

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

async function waitFor<T>(fn: () => T | undefined, label: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("real studio-host client negotiates and streams a prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "step-studio-host-"));
  const token = "host-token";
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, token);
  const socketPath = join(dir, "bridge.sock");
  const fakeStep = here("../../test/fake-step.mjs");

  const child = spawn(
    process.execPath,
    [
      here("../src/main.js"),
      "--mode", "studio-host",
      "--bridge-endpoint", socketPath,
      "--bridge-token-file", tokenFile,
      "--bridge-runtime-epoch", "7",
      "--cwd", dir,
    ],
    {
      env: { ...process.env, STEP_STUDIO_RUNTIME_CMD: `${process.execPath} ${fakeStep}` },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

  try {
    await waitFor(() => (existsSync(socketPath) ? true : undefined), "bridge socket");

    const events: any[] = [];
    const client = new StudioBridgeClient({
      endpoint: socketPath,
      token,
      // A missing receipt fails here instead of hanging the runner.
      requestTimeoutMs: 8000,
      onEvent: event => events.push(event),
    });

    const hello = await client.connect();
    assert.equal(hello.capabilityManifest.profile, "limited");

    const snapshot = await client.requestSnapshot();

    const receipt = await client.invoke({
      type: "studio.request",
      requestId: randomUUID(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "core.prompt", text: "hi" },
    });
    assert.equal(receipt.status, "completed");

    const deltas = events
      .filter(event => event.event?.kind === "conversation.message.delta")
      .map(event => event.event.delta)
      .join("");
    assert.equal(deltas, "hello!");

    // Every conversation event must parse under the real contract, and the
    // completed item must reuse the id the started event announced.
    const conversation = events.filter(event => String(event.event?.kind ?? "").startsWith("conversation."));
    assert.ok(conversation.length > 0, "expected conversation events");
    const started: string[] = [];
    for (const event of conversation) {
      const parsed = parseConversationRuntimeEvent(event.event);
      if (parsed.kind === "conversation.message.started") started.push(parsed.messageId);
      if (parsed.kind === "conversation.message.completed") {
        assert.equal(parsed.item.itemId, parsed.messageId);
        assert.ok(started.includes(parsed.messageId), "completed a message that never started");
      }
    }
    assert.equal(started.length, 2, "expected user and assistant messages");

    // Both selector forms must reach the same model. The id itself contains a
    // slash, so splitting on the first one would read provider `zed`.
    for (const selector of ["zed/claude-haiku-5-5", "local-gateway/zed/claude-haiku-5-5"]) {
      const receipt = await client.invoke({
        type: "studio.request",
        requestId: randomUUID(),
        runtimeEpoch: hello.runtimeEpoch,
        operation: { kind: "session.model.set", selector },
      });
      assert.equal(receipt.status, "completed", `${selector} was rejected`);
    }
    const afterModel = await client.requestSnapshot();
    assert.equal(afterModel.snapshot.sessionId, snapshot.snapshot.sessionId);
    assert.equal(afterModel.snapshot.model?.selector, "local-gateway/zed/claude-haiku-5-5");
    assert.equal(afterModel.snapshot.model?.id, "zed/claude-haiku-5-5");

    const unknown = await client.invoke({
      type: "studio.request",
      requestId: randomUUID(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "session.model.set", selector: "no/such-model" },
    });
    assert.equal(unknown.status, "failed");

    await client.invoke({
      type: "studio.request",
      requestId: randomUUID(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "session.thinking.set", level: "high" },
    });
    const afterThinking = await client.requestSnapshot();
    assert.equal(afterThinking.snapshot.model?.configuredThinking, "high");
    assert.equal(afterThinking.snapshot.model?.thinking, "high");

    await client.invoke({
      type: "studio.request",
      requestId: randomUUID(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "session.fork" },
    });
    await client.invoke({
      type: "studio.request",
      requestId: randomUUID(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "core.steer", text: "keep going" },
    });

    // The transcript page carries the turn that just ran, and a cursor from
    // another generation is refused instead of silently returning a page.
    const page = await client.invoke({
      type: "studio.request",
      requestId: randomUUID(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "session.transcript.read" },
    });
    const items = (page.result as { items: Array<{ kind: string; itemId: string; role: string }> }).items;
    assert.deepEqual(
      items.map(item => `${item.kind}:${item.role}`),
      ["message:user", "message:assistant"],
    );
    assert.equal(items[1]?.itemId, items[1]?.itemId);
    assert.ok(items.every(item => item.itemId.length > 0), "every item carries an entry id");

    // A cursor from another generation is refused under its own code: the Host
    // turns CURSOR_STALE into a resync, which a generic failure would not.
    const stale = await client.invoke({
      type: "studio.request",
      requestId: randomUUID(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "session.transcript.read", cursor: "step-1:someone-elses-leaf" },
    });
    assert.equal(stale.status, "failed");
    assert.equal(stale.error?.code, "CURSOR_STALE");

    client.disconnect();
  } finally {
    child.kill();
  }
});
