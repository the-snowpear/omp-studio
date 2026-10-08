import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserObservationEvent } from "@omp-studio/studio-protocol";
import { DesktopBrowserObservation } from "../src/browser-observation.js";
import type { TerminalSender } from "../src/terminal-ipc.js";

test("browser frames are window-owned and bounded by acknowledgements, with explicit control required", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-bo-")); const id = randomUUID(); const tabId = randomUUID(); const token = randomBytes(32).toString("hex");
  const endpoint = process.platform === "win32" ? "\\\\.\\pipe\\omp-studio-browser-" + id : join(directory, "b-" + createHash("sha256").update(id).digest("hex").slice(0, 16) + ".sock");
  const events: BrowserObservationEvent[] = []; const inputs: string[] = []; let peer: Socket | undefined;
  const sender: TerminalSender = { id: 7, isDestroyed: () => false, getURL: () => "file:///studio/index.html", send: (_channel, payload) => events.push(payload as BrowserObservationEvent), once: () => {} };
  const server = createServer(socket => { peer = socket; let pending = ""; let auth = false; socket.on("data", chunk => { pending += chunk.toString(); for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) { const line = pending.slice(0, at); pending = pending.slice(at + 1); if (!auth) { assert.equal(line, token); auth = true; socket.write("OK\n"); } else inputs.push(line); } }); });
  const manager = new DesktopBrowserObservation({ directory: () => directory, socketDirectory: async () => directory });
  const until = async (predicate: () => boolean) => { for (let n = 0; n < 100 && !predicate(); n++) await delay(5); assert.ok(predicate()); };
  try {
    await mkdir(join(directory, "browser")); await new Promise<void>(resolve => server.listen(endpoint, resolve));
    await writeFile(join(directory, "browser", id + ".json"), JSON.stringify({ version: 1, observationId: id, tabId, sessionId: "s", endpoint, token, expiresAt: Date.now() + 15000 }));
    await assert.rejects(manager.attach(sender, { observationId: id, tabId, sessionId: "foreign" }), /expired/);
    await manager.attach(sender, { observationId: id, tabId, sessionId: "s" });
    assert.throws(() => manager.input({ ...sender, id: 8 }, { observationId: id, input: { kind: "take" } }), /owned by this window/);
    assert.throws(() => manager.input(sender, { observationId: id, input: { kind: "navigate", url: "https://example.com" } }), /human control/);
    peer!.write(JSON.stringify({ kind: "state", observationId: id, tabId, title: "test", url: "http://localhost", frozen: false, busy: false, control: "human" }) + "\n");
    await until(() => events.some(event => event.kind === "state"));
    assert.throws(() => manager.input(sender, { observationId: id, input: { kind: "navigate", url: "file:///private" } }), /HTTP/);
    manager.input(sender, { observationId: id, input: { kind: "navigate", url: "https://example.com" } });
    await until(() => inputs.length === 1);
    const frame = { kind: "frame", observationId: id, tabId, sequence: 1, data: "YWJj", width: 1000, height: 600, timestamp: Date.now() };
    peer!.write(JSON.stringify(frame) + "\n"); await until(() => events.some(event => event.kind === "frame"));
    assert.throws(() => manager.input(sender, { observationId: id, input: { kind: "ack", sequence: 2 } }), /stale/);
    peer!.write(JSON.stringify({ ...frame, sequence: 2 }) + "\n"); await until(() => events.some(event => event.kind === "closed"));
    assert.equal(events.filter(event => event.kind === "frame").length, 1);
    assert.throws(() => manager.input(sender, { observationId: id, input: { kind: "take" } }), /owned by this window/);
    assert.ok(!JSON.stringify(events).includes(token)); assert.ok(!JSON.stringify(events).includes(endpoint));
  } finally { manager.dispose(); peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
