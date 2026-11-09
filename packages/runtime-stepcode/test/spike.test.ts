import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FrameDecoder, encodeFrame } from "@omp-studio/studio-protocol";

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

test("runtime-stepcode: hello, prompt stream, abort, shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "step-studio-spike-"));
  const token = "spike-token";
  const tokenFile = join(dir, "bridge-token");
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

    const socket: Socket = connect(socketPath);
    const decoder = new FrameDecoder();
    const inbox: any[] = [];
    socket.on("data", chunk => {
      inbox.push(...decoder.push(chunk).map(frame => frame.body));
    });
    const send = (body: unknown) => socket.write(encodeFrame(randomUUID(), 7 as never, body));

    const helloRequestId = randomUUID();
    const challenge = "challenge-1";
    send({
      type: "studio.hello",
      requestId: helloRequestId,
      supportedProtocolVersions: [1],
      requiredProfile: "full-parity-v1",
      challenge,
    });

    const hello: any = await waitFor(() => inbox.find(m => m.type === "studio.hello.result"), "hello");
    assert.equal(hello.requestId, helloRequestId);
    assert.equal(hello.selectedProtocolVersion, 1);
    assert.equal(hello.capabilityManifest.profile, "limited");
    const expected = createHmac("sha256", token)
      .update(challenge)
      .update("\0")
      .update(hello.runtimeInstanceId)
      .digest("base64url");
    assert.equal(hello.challengeProof, expected);

    const promptId = randomUUID();
    send({
      type: "studio.request",
      requestId: promptId,
      runtimeEpoch: 7,
      operation: { kind: "core.prompt", text: "hi" },
    });
    await waitFor(
      () => inbox.find(m => m.type === "studio.receipt" && m.requestId === promptId && m.status === "accepted"),
      "prompt accepted",
    );
    const completed: any = await waitFor(
      () => inbox.find(m => m.type === "studio.receipt" && m.requestId === promptId && m.status === "completed"),
      "prompt completed",
    );
    assert.deepEqual(completed.result, { ok: true });
    const deltas = inbox
      .filter(m => m.type === "studio.event" && m.event?.kind === "conversation.message.delta")
      .map(m => m.event.delta)
      .join("");
    assert.equal(deltas, "hello!");

    const abortId = randomUUID();
    send({
      type: "studio.request",
      requestId: abortId,
      runtimeEpoch: 7,
      operation: { kind: "core.abort" },
    });
    const aborted: any = await waitFor(
      () => inbox.find(m => m.type === "studio.receipt" && m.requestId === abortId && m.status === "completed"),
      "abort receipt",
    );
    assert.deepEqual(aborted.result, { aborted: true });

    const shutdownId = randomUUID();
    send({
      type: "studio.request",
      requestId: shutdownId,
      runtimeEpoch: 7,
      operation: { kind: "runtime.shutdown", drain: true },
    });
    await waitFor(
      () => inbox.find(m => m.type === "studio.receipt" && m.requestId === shutdownId),
      "shutdown receipt",
    );
    socket.end();
  } finally {
    child.kill();
  }
});
