import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  validatePredictionEvent,
  type PredictionEvent,
} from "@omp-studio/studio-protocol";
import type { TerminalSender } from "../src/terminal-ipc.js";
import { DesktopPrediction } from "../src/prediction.js";
test("prediction transport isolates windows and imports only a selected private file", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-prediction-ipc-")),
    channelId = randomUUID(),
    token = randomBytes(32).toString("hex");
  const endpoint =
    process.platform === "win32"
      ? "\\\\.\\pipe\\omp-studio-predict-" + channelId
      : join(
          root,
          "p-" +
            createHash("sha256").update(channelId).digest("hex").slice(0, 16) +
            ".sock",
        );
  const events: PredictionEvent[] = [],
    inputs: Record<string, unknown>[] = [];
  let peer: Socket | undefined;
  const sender: TerminalSender = {
    id: 7,
    isDestroyed: () => false,
    getURL: () => "file:///studio/index.html",
    send: (_channel, value) => events.push(value as PredictionEvent),
    once: () => {},
  };
  const selected = join(root, "chosen-history.jsonl");
  await writeFile(
    selected,
    JSON.stringify({ text: "local prompt fixture" }) + "\n",
  );
  const server = createServer((socket) => {
    peer = socket;
    socket.setEncoding("utf8");
    let pending = "",
      auth = false;
    socket.on("data", (part: string) => {
      pending += part;
      for (
        let at = pending.indexOf("\n");
        at >= 0;
        at = pending.indexOf("\n")
      ) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (!auth) {
          assert.equal(line, token);
          auth = true;
          socket.write("OK\n");
          continue;
        }
        const input = JSON.parse(line) as Record<string, unknown>;
        inputs.push(input);
        if (input.kind === "import")
          void readFile(
            join(
              root,
              "prediction-imports",
              String(input.transferId) + ".jsonl",
            ),
            "utf8",
          ).then((text) => {
            assert.ok(text.includes("local prompt fixture"));
            socket.write(
              JSON.stringify({
                kind: "imported",
                channelId,
                requestId: input.requestId,
                count: 1,
                truncated: false,
              }) + "\n",
            );
          });
      }
    });
  });
  const manager = new DesktopPrediction({
    directory: () => root,
    socketDirectory: async () => root,
    chooseHistory: async () => selected,
  });
  try {
    await mkdir(join(root, "prediction"));
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    await writeFile(
      join(root, "prediction", channelId + ".json"),
      JSON.stringify({
        version: 1,
        channelId,
        sessionId: "main",
        token,
        endpoint,
        expiresAt: Date.now() + 15000,
      }),
    );
    await assert.rejects(
      () => manager.attach(sender, { channelId, sessionId: "foreign" }),
      /expired or changed/,
    );
    await manager.attach(sender, { channelId, sessionId: "main" });
    assert.throws(
      () =>
        manager.input(
          { ...sender, id: 8 },
          {
            channelId,
            input: { kind: "update", revision: 1, text: "private", caret: 7 },
          },
        ),
      /owned by this window/,
    );
    assert.throws(
      () =>
        manager.input(sender, {
          channelId,
          input: {
            kind: "import",
            requestId: randomUUID(),
            transferId: randomUUID(),
          },
        }),
      /file picker/,
    );
    assert.throws(
      () =>
        manager.input(sender, {
          channelId,
          input: { kind: "update", revision: 1, text: "x", caret: 2 },
        }),
      /prediction number/,
    );
    assert.deepEqual(await manager.importHistory(sender, { channelId }), {
      ok: true,
      count: 1,
      truncated: false,
    });
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.kind, "import");
    assert.ok(!JSON.stringify(inputs).includes(selected));
    assert.ok(!JSON.stringify(events).includes(token));
    assert.ok(!JSON.stringify(events).includes(endpoint));
    assert.ok(!JSON.stringify(events).includes("local prompt fixture"));
    manager.disposeWindow(sender.id);
    for (let attempt = 0; attempt < 100 && !peer?.destroyed; attempt++)
      await delay(5);
    assert.throws(
      () => manager.input(sender, { channelId, input: { kind: "ping" } }),
      /owned by this window/,
    );
    assert.equal(
      await readFile(selected, "utf8"),
      JSON.stringify({ text: "local prompt fixture" }) + "\n",
    );
  } finally {
    manager.dispose();
    peer?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
test("prediction events reject cross-kind draft payloads and malformed import identities", () => {
  const channelId = randomUUID();
  assert.throws(
    () =>
      validatePredictionEvent({
        kind: "closed",
        channelId,
        message: "draft text",
      }),
    /Invalid prediction data/,
  );
  assert.throws(
    () =>
      validatePredictionEvent({
        kind: "error",
        channelId,
        message: "Import failed",
        requestId: { path: "private" },
      }),
    /Invalid prediction identity/,
  );
  assert.throws(
    () =>
      validatePredictionEvent({
        kind: "suggestion",
        channelId,
        revision: 1,
        suffix: "x",
        count: 50,
      }),
    /Invalid prediction data/,
  );
});
