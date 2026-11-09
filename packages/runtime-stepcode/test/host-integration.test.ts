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
      // eslint-disable-next-line no-console
      endpoint: socketPath,
      token,
      // A missing receipt fails here instead of hanging the runner.
      requestTimeoutMs: 8000,
      onEvent: event => events.push(event),
    });

    const hello = await client.connect();
    assert.equal(hello.capabilityManifest.profile, "limited");

    const snapshot = await client.requestSnapshot();

    const promptId = randomUUID();
    const receipt = await client.invoke({
      type: "studio.request",
      requestId: promptId,
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

    // A snapshot taken after events must report the sequence it has actually
    // emitted. Reporting 0 resets the Host's watermark, and the next event then
    // reads as a gap — which silently stops every later event.
    const midStream = await client.requestSnapshot();
    assert.ok(midStream.lastEventSeq > 0, "snapshot must carry the emitted event sequence");
    const eventsBefore = events.length;
    await client.invoke({
      type: "studio.request",
      requestId: randomUUID(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "core.prompt", text: "again" },
    });
    assert.ok(events.length > eventsBefore, "events after a mid-stream snapshot must still arrive");

    // Tool activity must reach the conversation surface, or a turn that acted
    // looks like a turn that only thought.
    const tools = conversation
      .map(event => parseConversationRuntimeEvent(event.event))
      .filter(parsed => parsed.kind.startsWith("conversation.tool."));
    assert.deepEqual(
      tools.map(parsed => parsed.kind),
      ["conversation.tool.started", "conversation.tool.completed"],
    );
    const completed = tools[1] as Extract<ReturnType<typeof parseConversationRuntimeEvent>, { kind: "conversation.tool.completed" }>;
    assert.equal(completed.result.toolCallId, completed.toolCallId);
    assert.equal(completed.result.toolName, "list_directory");
    assert.equal(completed.result.output, "dir apps/");
    assert.equal(completed.result.isError, false);

    const step = async (label: string, operation: Record<string, unknown>) => {
      console.error(`STEP ${label}`);
      const receipt = await client.invoke({
        type: "studio.request",
        requestId: randomUUID(),
        runtimeEpoch: hello.runtimeEpoch,
        operation,
      } as never);
      console.error(`STEP ${label} -> ${receipt.status}`);
      return receipt;
    };

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
    // The earlier watermark check added a turn, so match the tail rather than
    // the whole page.
    assert.deepEqual(
      items.slice(-2).map(item => `${item.kind}:${item.role}`),
      ["message:user", "message:assistant"],
    );
    assert.equal(items[1]?.itemId, items[1]?.itemId);
    assert.ok(items.every(item => item.itemId.length > 0), "every item carries an entry id");

    // The model picker's catalog. Step ids carry their own slash, so the
    // selector the Host hands back must still read as `provider/id`.
    const models = await client.invoke({
      type: "studio.request",
      requestId: randomUUID(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "session.models.list" },
    });
    const listed = (models.result as { models: Array<{ provider: string; id: string; selector: string }> }).models;
    assert.deepEqual(
      listed.map(model => model.selector),
      ["local-gateway/stepfun-cn/step-3.7-flash", "local-gateway/zed/claude-haiku-5-5"],
    );
    for (const model of listed) assert.equal(model.selector, `${model.provider}/${model.id}`);

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

    // Compaction shortens the transcript; silence would look like lost messages.
    // It is Runtime-initiated, so it arrives without the Host asking.
    await step("compact", { kind: "core.prompt", text: "compact" });
    const compaction = events
      .filter(event => String(event.event?.kind ?? "").startsWith("conversation.compaction."))
      .map(event => parseConversationRuntimeEvent(event.event))
      .filter(parsed => parsed.kind.startsWith("conversation.compaction."));
    assert.deepEqual(
      compaction.map(parsed => parsed.kind),
      ["conversation.compaction.started", "conversation.compaction.completed"],
    );
    assert.equal((compaction[1] as { aborted: boolean }).aborted, false);

    // A CLI that dies mid-turn must fail the prompt, not leave it hanging.
    const doomed = await step("die", { kind: "core.prompt", text: "die" });
    assert.equal(doomed.status, "failed");
    assert.match(doomed.error?.message ?? "", /step runtime exited/u);

    // A reconnect must be able to recover a receipt the dropped socket never
    // delivered: the Host reconciles `terminalReceipts` on refresh.
    const recovered = new StudioBridgeClient({
      endpoint: socketPath,
      token,
      requestTimeoutMs: 8000,
    });
    const rehello = await recovered.connect();
    const refreshed = await recovered.requestSnapshot();
    const replayed = refreshed.terminalReceipts.filter(receipt => receipt.requestId === promptId);
    assert.equal(replayed.length, 1, "the completed prompt receipt must survive a reconnect");
    assert.equal(replayed[0]?.status, "completed");
    assert.ok(rehello.runtimeEpoch === hello.runtimeEpoch, "the runtime instance is unchanged across a reconnect");
    recovered.disconnect();

    client.disconnect();
  } finally {
    child.kill();
  }
});
