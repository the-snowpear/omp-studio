import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ClientBootstrap, ClientEvent, ClientTransport, WorkspaceId } from "@omp-studio/client-contract";
import type { WebAdapterHost } from "@omp-studio/transport-web";
import { WebSocket } from "ws";
import { startMobileAccess } from "../src/mobile-access.js";

const workspaceId = "work-local" as WorkspaceId;
const sessionId = "visible-session";
const threadId = "visible-thread";
const approval = { kind: "approval", approvalType: "bash", interactionId: "approval", leaseGeneration: 12, sessionId, title: "Run tests", detail: {} };

function fakeHost() {
  const calls: string[] = [];
  let publish: ((event: ClientEvent) => void) | undefined;
  let pending = true;
  const state = {
    runtime: { status: "connected" },
    snapshot: { sessionId, isStreaming: false },
  };
  const context = {
    bootstrap: async () => ({ ...state, ...(pending ? { pendingInteraction: approval } : {}) }) as ClientBootstrap,
    async query(call: { queryName: string }) {
      assert.equal(call.queryName, "session.transcript.read");
      return { ok: true, result: { sessionId, items: [] } };
    },
    async command(command: { commandName: string }) {
      calls.push(command.commandName);
      return {};
    },
    subscribe(_scope: unknown, listener: (event: ClientEvent) => void) { publish = listener; return () => { publish = undefined; }; },
    close: async () => { calls.push("close"); },
  } as unknown as ClientTransport;
  const host = {
    query: async (call: { input: { workspaceId: string; status: string; offset?: number; sessionId?: string } }) => {
      assert.equal(call.input.workspaceId, workspaceId);
      assert.equal(call.input.status, "active");
      const older = { sessionId, threadId };
      const recent = { sessionId: "recent-session", threadId: "recent-thread" };
      const entries = call.input.sessionId === undefined
        ? [call.input.offset === 1 ? older : recent]
        : [older, recent].filter(entry => entry.sessionId === call.input.sessionId);
      return { ok: true, result: { entries, total: 2 } };
    },
    openContext: async (scope: { sessionId: string }) => { assert.equal(scope.sessionId, sessionId); return context; },
  } as unknown as WebAdapterHost;
  return { calls, host, emit: (event: ClientEvent) => publish?.(event), resolveOnDesktop: () => { pending = false; } };
}

test("the HTTPS phone can pair, stream and command only the selected conversation", { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "omp-mobile-test-"));
  await writeFile(join(directory, "mobile.html"), "<title>OMP Studio</title>");
  const fake = fakeHost();
  let pairedClients = 0;
  const access = await startMobileAccess({
    host: fake.host, ip: "127.0.0.1", workspaceId, workspaceName: "Workspace",
    profileDirectory: directory, rendererDirectory: directory,
    onPaired: async () => { pairedClients++; },
  });
  t.after(() => access.close());
  const ca = `-----BEGIN CERTIFICATE-----\n${access.certificate.toString("base64")}\n-----END CERTIFICATE-----\n`;
  let cookie: string | undefined;
  let csrf: string | undefined;
  let contextId: string | undefined;
  const call = (path: string, body?: unknown) => new Promise<{ status: number; data: any; cookie?: string }>((resolve, reject) => {
    const req = request(new URL(path, access.origin), {
      ca,
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(contextId ? { "X-Studio-Context": contextId } : {}),
        ...(csrf ? { "X-Studio-CSRF": csrf } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json", origin: access.origin }),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        const data = response.headers["content-type"] === "application/json" ? JSON.parse(text) : text;
        const setCookie = response.headers["set-cookie"]?.[0];
        resolve({ status: response.statusCode!, data, ...(setCookie ? { cookie: setCookie } : {}) });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  assert.equal((await call("/")).status, 200);
  assert.equal((await call("/api/v1/session")).status, 401);
  const pair = await access.pair();
  const code = new URLSearchParams(new URL(pair.url).hash.slice(1)).get("pair");
  const paired = await call("/api/v1/pair", { code });
  assert.equal(paired.status, 200);
  assert.equal(pairedClients, 1);
  assert.match(paired.cookie!, /HttpOnly; SameSite=Strict; Path=\/; Secure/);
  cookie = paired.cookie!.split(";")[0]!;
  csrf = (await call("/api/v1/session")).data.csrf as string;
  assert.equal(access.paired(), true);
  assert.equal((await call("/api/v1/pair", { code })).status, 401);
  assert.equal(pairedClients, 1);
  assert.equal((await call("/api/v1/context/open", { workspaceId: "another", sessionId })).status, 400);
  assert.equal((await call("/api/v1/context/open", { workspaceId, sessionId: "another" })).status, 400);
  const recent = await call("/api/v1/query", { queryName: "history.list", input: {} });
  const older = await call("/api/v1/query", { queryName: "history.list", input: { offset: 1 } });
  assert.equal(recent.data.result.entries[0].sessionId, "recent-session");
  assert.equal(older.data.result.entries[0].sessionId, sessionId);
  const opened = await call("/api/v1/context/open", { workspaceId, sessionId });
  assert.equal(opened.status, 200);
  contextId = opened.data.contextId as string;
  const prompt = { commandName: "core.prompt", input: { text: "Continue" } };
  assert.equal((await call("/api/v1/command", prompt)).status, 409);
  const previousPage = await call("/api/v1/query", { queryName: "session.transcript.read", input: { cursor: "older" } });
  assert.equal(previousPage.status, 200);
  assert.equal(previousPage.data.result.sessionId, sessionId);
  const websocket = new WebSocket(`${access.origin.replace("https:", "wss:")}/api/v1/events?contextId=${contextId}`, {
    ca, origin: access.origin, headers: { cookie },
  });
  const [ready] = await once(websocket, "message");
  assert.deepEqual(JSON.parse(String(ready)), { kind: "mobile.ready" });
  const message = once(websocket, "message");
  fake.emit({ kind: "conversation.changed", sessionId, cursor: "4" } as ClientEvent);
  assert.equal(JSON.parse(String((await message)[0])).cursor, "4");
  assert.equal((await call("/api/v1/command", prompt)).status, 202);
  const approve = { commandName: "interaction.respond", input: { interactionId: approval.interactionId, leaseGeneration: 12, decision: "submit", value: true } };
  assert.equal((await call("/api/v1/command", approve)).status, 202);
  fake.resolveOnDesktop();
  assert.equal((await call("/api/v1/command", approve)).status, 400);
  assert.equal((await call("/api/v1/query", { queryName: "fs.places", input: {} })).status, 400);
  assert.deepEqual(fake.calls, ["core.prompt", "interaction.respond"]);

  const rePair = await access.pair();
  const newCode = new URLSearchParams(new URL(rePair.url).hash.slice(1)).get("pair");
  const closed = once(websocket, "close");
  assert.equal((await call("/api/v1/pair", { code: newCode })).status, 200);
  await closed;
  assert.equal((await call("/api/v1/session")).status, 401);
  assert.ok(fake.calls.includes("close"));
  await access.revoke();
  assert.equal(access.paired(), false);
});
