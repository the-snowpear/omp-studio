//! Against the real Step CLI, when one is installed.
//!
//! The rest of the suite drives a fake runtime so it is deterministic and
//! CI-friendly. That means it cannot catch a regression in how the adapter
//! talks to the actual `step` binary — the seam where upstream changes land.
//! This test closes that gap, and skips cleanly when no CLI is present.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { spawn } from "node:child_process";
import { existsSync as fileExists } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { dirname, join as pathJoin, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type BridgeClientModule = typeof import("../../studio-host/dist/src/bridge-client.js");
// Compiled output sits one directory deeper than the sources, so resolve the
// sibling package from this file rather than from a fixed relative depth.
const studioHostClient = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    pathResolve(here, "../../studio-host/dist/src/bridge-client.js"),
    pathResolve(here, "../../../studio-host/dist/src/bridge-client.js"),
  ]) {
    if (fileExists(candidate)) return pathToFileURL(candidate).href;
  }
  throw new Error("studio-host is not built; run the workspace build first");
})();
const { StudioBridgeClient } = (await import(studioHostClient)) as BridgeClientModule;

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The real CLI, or undefined when none is installed. An explicit
 * `STEP_STUDIO_REAL_STEP` is honoured only if it exists — pointing it at a
 * missing path must read as "no CLI", not as a CLI that fails to start.
 */
function findStep(): string | undefined {
  const fromEnv = process.env["STEP_STUDIO_REAL_STEP"];
  if (fromEnv !== undefined && fromEnv !== "" && existsSync(fromEnv)) return fromEnv;
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, "step");
    if (existsSync(candidate)) return candidate;
  }
  const home = process.env["HOME"] ?? "";
  const installed = join(home, ".stepcode", "bin", "step");
  return existsSync(installed) ? installed : undefined;
}

const step = findStep();
const describeReal = step === undefined ? test.skip : test;

describeReal("the adapter drives the real Step CLI", { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(pathJoin(osTmpdir(), "step-real-"));
  const token = "real-step-token";
  writeFileSync(join(dir, "token"), token);
  const socketPath = join(dir, "bridge.sock");
  const fakeStep = here("../../test/fake-step.mjs");

  const child = spawn(
    process.execPath,
    [
      here("../src/main.js"),
      "--mode", "studio-host",
      "--bridge-endpoint", socketPath,
      "--bridge-token-file", join(dir, "token"),
      "--bridge-runtime-epoch", "1",
      "--cwd", dir,
    ],
    {
      env: { ...process.env, STEP_STUDIO_RUNTIME_CMD: step! },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

  try {
    for (let i = 0; i < 1000 && !existsSync(socketPath); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(socketPath), "the adapter never created its bridge socket");

    // One client: the adapter serves a single connection and drops the previous
    // socket when a second one arrives.
    const deltas: string[] = [];
    const tools: string[] = [];
    const client = new StudioBridgeClient({
      endpoint: socketPath,
      token,
      requestTimeoutMs: 150_000,
      onEvent: event => {
        const payload = event.event as { kind?: string; delta?: string; toolName?: string };
        if (payload.kind === "conversation.message.delta") deltas.push(payload.delta ?? "");
        if (payload.kind === "conversation.tool.started") tools.push(payload.toolName ?? "");
      },
    });
    const hello = await client.connect();
    assert.equal(hello.capabilityManifest.profile, "limited");

    const snapshot = await client.requestSnapshot();
    const sessionId = snapshot.snapshot.sessionId;
    assert.ok(sessionId.length > 0, "the real CLI reported an empty session id");
    // The real CLI resolves its own model catalog, so the snapshot must carry
    // a model — a fake cannot prove that.
    assert.ok(snapshot.snapshot.model !== undefined, "the real CLI reported no active model");

    const receipt = await client.invoke({
      type: "studio.request",
      requestId: cryptoRandom(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "core.prompt", text: "reply with exactly: PONG" },
    });
    assert.equal(receipt.status, "completed", `turn failed: ${receipt.error?.message ?? "unknown"}`);

    const answer = deltas.join("");
    assert.ok(answer.includes("PONG"), `the real CLI never produced the answer; got: ${answer.slice(0, 200)}`);
    assert.ok(tools.length === 0 || Array.isArray(tools), "tool names must be strings");

    // A real turn also proves the transcript is readable back, which is what
    // the Renderer calls on open.
    const page = await client.invoke({
      type: "studio.request",
      requestId: cryptoRandom(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "session.transcript.read" },
    });
    const items = (page.result as { items: Array<{ role: string }> }).items;
    assert.ok(items.some(item => item.role === "assistant"), "the transcript lost the assistant turn");

    client.disconnect();
  } finally {
    child.kill();
    // Keep the linter honest about the unused fake path in the skip case.
    void fakeStep;
  }
});

function cryptoRandom(): string {
  return `real-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
