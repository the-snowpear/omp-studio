import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseConversationRuntimeEvent } from "@omp-studio/studio-protocol";

// Type-only path resolves from this source file; the runtime path resolves
// from the package working directory so the compiled dist/test layout works.
type BridgeClientModule = typeof import("../../studio-host/dist/src/bridge-client.js");
const { StudioBridgeClient } = (await import(
  pathToFileURL(resolve(process.cwd(), "../studio-host/dist/src/bridge-client.js")).href
)) as BridgeClientModule;

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
      onEvent: event => events.push(event),
    });

    const hello = await client.connect();
    assert.equal(hello.capabilityManifest.profile, "limited");

    await client.requestSnapshot();

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

    client.disconnect();
  } finally {
    child.kill();
  }
});
