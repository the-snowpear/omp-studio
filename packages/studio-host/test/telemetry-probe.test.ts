import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createNodeSessionTelemetryProbe, type SpawnFunction } from "../src/index.js";
import type { SessionId, SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";

function telemetrySnapshot(sessionId: string): SessionTelemetrySnapshot {
  return {
    sessionId: sessionId as SessionId,
    capturedAt: "2026-08-16T00:00:00.000Z",
    tokens: { input: 10, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 0, total: 14, cost: 0.12 },
    context: null,
    unavailableReason: "model_context_unknown",
  };
}

interface FakeChild extends EventEmitter {
  readonly stdin: EventEmitter & { end: (data?: string) => void; writes: string[] };
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  kill(): void;
}

interface FakeSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

function fakeSpawnBehaviour(script: {
  readonly reply?: (requestId: string) => string;
  readonly exitCode?: number;
  readonly stdoutChunks?: readonly string[];
  readonly delayMs?: number;
}): { spawn: SpawnFunction; calls: FakeSpawnCall[]; children: FakeChild[] } {
  const calls: FakeSpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as FakeChild;
    const stdin = Object.assign(new EventEmitter(), {
      writes: [] as string[],
      end(data?: string) {
        if (data !== undefined) stdin.writes.push(data);
      },
    });
    Object.assign(child, {
      stdin,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill() {},
    });
    children.push(child);
    void (async () => {
      const delay = script.delayMs ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      // Extract the requestId from the pushed stdin payload once available.
      setImmediate(() => {
        const payload = stdin.writes[0];
        const parsed = payload === undefined ? { requestId: "req-unknown" } : (JSON.parse(payload) as { requestId: string });
        if (script.stdoutChunks !== undefined) {
          for (const chunk of script.stdoutChunks) child.stdout.emit("data", Buffer.from(chunk, "utf8"));
        } else if (script.reply !== undefined) {
          child.stdout.emit("data", Buffer.from(script.reply(parsed.requestId), "utf8"));
        }
        child.stderr.emit("data", Buffer.from("diagnostic", "utf8"));
        child.emit("close", script.exitCode ?? 0);
      });
    })();
    return child as never;
  }) as unknown as SpawnFunction;
  return { spawn, calls, children };
}

const okReply = (requestId: string): string =>
  `${JSON.stringify({ schemaVersion: 1, requestId, ok: true, telemetry: telemetrySnapshot("session-1") })}\n`;

const baseInput = {
  sessionId: "session-1",
  sessionFile: "C:\\probe\\copy.jsonl",
  allowedCwd: "C:\\workspace",
  transcriptRevision: "sha256:rev-1",
};

test("telemetry probe spawns the hidden arg safely and parses the single JSON reply", async () => {
  const fake = fakeSpawnBehaviour({ reply: okReply });
  const probe = createNodeSessionTelemetryProbe({ executablePath: () => "C:\\omp\\omp.exe", spawnProcess: fake.spawn });
  const outcome = await probe.run(baseInput);
  assert.ok(outcome.ok);
  assert.equal(outcome.telemetry.sessionId, "session-1");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.command, "C:\\omp\\omp.exe");
  assert.deepEqual(fake.calls[0]?.args, ["--studio-session-telemetry-probe"]);
  const options = fake.calls[0]?.options as { shell: boolean; windowsHide: boolean; stdio: readonly string[] } | undefined;
  assert.equal(options?.shell, false);
  assert.equal(options?.windowsHide, true);
  assert.deepEqual(options?.stdio, ["pipe", "pipe", "pipe"]);
  const payload = JSON.parse(fake.children[0]?.stdin.writes[0] ?? "{}") as Record<string, string>;
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.sessionFile, "C:\\probe\\copy.jsonl");
  assert.equal(payload.expectedSessionId, "session-1");
  assert.equal(payload.allowedCwd, "C:\\workspace");
  assert.match(String(payload.requestId ?? ""), /.+/u);
  probe.dispose();
});

test("telemetry probe collapses every failure mode to UNAVAILABLE without leaking stderr", async () => {
  const failures: Array<{ script: Parameters<typeof fakeSpawnBehaviour>[0]; label: string }> = [
    { script: { reply: () => "not json" }, label: "malformed" },
    { script: { reply: (id) => JSON.stringify({ schemaVersion: 1, requestId: `${id}-wrong`, ok: true, telemetry: telemetrySnapshot("session-1") }) }, label: "request echo" },
    { script: { reply: (id) => JSON.stringify({ schemaVersion: 1, requestId: id, ok: false, code: "SESSION_MISMATCH", message: "x" }) }, label: "structured failure" },
    { script: { reply: (id) => JSON.stringify({ schemaVersion: 1, requestId: id, ok: true, telemetry: telemetrySnapshot("session-2") }) }, label: "session mismatch" },
    { script: { reply: (id) => JSON.stringify({ schemaVersion: 2, requestId: id, ok: true, telemetry: telemetrySnapshot("session-1") }) }, label: "schema version" },
    { script: { reply: (id) => `${JSON.stringify({ schemaVersion: 1, requestId: id, ok: true, telemetry: telemetrySnapshot("session-1") })}\nextra line` }, label: "two lines" },
    { script: { reply: okReply, exitCode: 3 }, label: "exit code" },
    { script: { reply: (id) => JSON.stringify({ schemaVersion: 1, requestId: id, ok: true, telemetry: { ...telemetrySnapshot("session-1"), tokens: { input: -5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 } } }) }, label: "negative tokens" },
    { script: { reply: okReply, delayMs: 500 }, label: "timeout" },
  ];
  for (const { script, label } of failures) {
    const fake = fakeSpawnBehaviour(script);
    const probe = createNodeSessionTelemetryProbe({
      executablePath: () => "C:\\omp\\omp.exe",
      timeoutMs: 50,
      spawnProcess: fake.spawn,
    });
    const outcome = await probe.run(baseInput);
    assert.equal(outcome.ok, false, `expected UNAVAILABLE for ${label}`);
    if (!outcome.ok) assert.equal(outcome.reason, "UNAVAILABLE");
    probe.dispose();
  }
  const noExecutable = createNodeSessionTelemetryProbe({ executablePath: () => undefined });
  assert.deepEqual(await noExecutable.run(baseInput), { ok: false, reason: "UNAVAILABLE" });
  noExecutable.dispose();
});

test("telemetry probe deduplicates concurrent runs and caches successes per revision+executable", async () => {
  const fake = fakeSpawnBehaviour({ reply: okReply });
  const probe = createNodeSessionTelemetryProbe({ executablePath: () => "C:\\omp\\omp.exe", spawnProcess: fake.spawn });
  const [first, second] = await Promise.all([probe.run(baseInput), probe.run(baseInput)]);
  assert.ok(first.ok);
  assert.ok(second.ok);
  assert.equal(fake.calls.length, 1, "same cache key must share one in-flight process");
  await probe.run(baseInput);
  assert.equal(fake.calls.length, 1, "TTL cache must avoid a second spawn");
  await probe.run({ ...baseInput, transcriptRevision: "sha256:rev-2" });
  assert.equal(fake.calls.length, 2, "a new revision must bypass the cache");
  probe.dispose();
});

test("telemetry probe output caps kill the child and fail closed", async () => {
  const fake = fakeSpawnBehaviour({ stdoutChunks: ["x".repeat(70_000)] });
  const probe = createNodeSessionTelemetryProbe({ executablePath: () => "C:\\omp\\omp.exe", spawnProcess: fake.spawn });
  const outcome = await probe.run(baseInput);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "UNAVAILABLE");
  probe.dispose();
});

test("telemetry probe reports log-safe diagnostics for successes and failures", async () => {
  const diagnostics: unknown[] = [];
  const okFake = fakeSpawnBehaviour({ reply: okReply });
  const okProbe = createNodeSessionTelemetryProbe({
    executablePath: () => "C:\\omp\\omp.exe",
    spawnProcess: okFake.spawn,
    onDiagnostic: (info) => diagnostics.push(info),
  });
  await okProbe.run(baseInput);
  okProbe.dispose();
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(Object.keys(diagnostics[0] as object).sort(), ["durationMs", "result"]);
  assert.equal((diagnostics[0] as { result: string }).result, "ok");

  const exitFake = fakeSpawnBehaviour({ reply: okReply, exitCode: 3 });
  const exitProbe = createNodeSessionTelemetryProbe({
    executablePath: () => "C:\\omp\\omp.exe",
    spawnProcess: exitFake.spawn,
    onDiagnostic: (info) => diagnostics.push(info),
  });
  await exitProbe.run(baseInput);
  exitProbe.dispose();
  const failure = diagnostics[1] as { result: string; reason?: string; exitCode?: number };
  assert.equal(failure.result, "unavailable");
  assert.equal(failure.reason, "nonzero-exit");
  assert.equal(failure.exitCode, 3);
  const serialized = JSON.stringify(failure);
  assert.ok(!serialized.includes("C:\\"), "diagnostics must not contain paths");
  assert.ok(!serialized.includes("session-1"), "diagnostics must not contain session ids");

  const noExecutable = createNodeSessionTelemetryProbe({
    executablePath: () => undefined,
    onDiagnostic: (info) => diagnostics.push(info),
  });
  await noExecutable.run(baseInput);
  noExecutable.dispose();
  assert.equal((diagnostics[2] as { reason?: string }).reason, "no-executable");
});
