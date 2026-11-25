import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { ClientTransport } from "@omp-studio/client-contract";
import { startWebServer, lanAddresses } from "../src/web/server.js";
import { request as httpsRequest } from "node:https";
import { HostControl } from "../src/web/control.js";
import { SharedTerminals } from "../src/web/terminals.js";
import type { PtyProcess } from "../src/terminal-pty.js";

test("paired devices survive Host restart, transfer control and revoke a live connection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "studio-web-"));
  await writeFile(
    join(directory, "web.html"),
    "<!doctype html><title>Workbench</title>",
  );
  let commands = 0;
  const host = {
    bootstrap: async () => ({ contractVersion: 2 }),
    query: async () => ({ ok: true }),
    command: async () => {
      commands++;
      return { status: "accepted" };
    },
    subscribe: () => () => {},
    close: async () => {},
  } as unknown as ClientTransport;
  const control = new HostControl();
  const terminals = new SharedTerminals(async () => directory, {
    spawn: () => {
      throw new Error("No terminal needed");
    },
  });
  const options = {
    host,
    control,
    terminals,
    stateDirectory: directory,
    rendererDirectory: directory,
  };
  let server = await startWebServer(options);
  t.after(async () => {
    await server.close();
    terminals.close();
    await rm(directory, { recursive: true, force: true });
  });
  const pair = async (name: string) => {
    server.adapter.rotatePairingCode();
    const response = await fetch(`${server.origin}/api/v1/pair`, {
      method: "POST",
      headers: { Origin: server.origin, "content-type": "application/json" },
      body: JSON.stringify({ code: server.adapter.pairingCode, name }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie")!, /^studio_web_/);
    const { csrf } = (await response.json()) as { csrf: string };
    return {
      Cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      "X-Studio-CSRF": csrf,
      Origin: server.origin,
      "content-type": "application/json",
    };
  };
  const first = await pair("Laptop"),
    second = await pair("Phone");
  const post = (
    headers: Record<string, string>,
    path: string,
    body: unknown = {},
  ) =>
    fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: { ...headers, Origin: server.origin },
      body: JSON.stringify(body),
    });
  const taken = (await (await post(first, "/api/web/control")).json()) as {
    version: string;
    deviceId: string;
  };
  assert.equal(
    (
      await post(
        { ...first, "X-Studio-Control": taken.version },
        "/api/v1/command",
        { commandName: "session.send" },
      )
    ).status,
    202,
  );
  const next = (await (await post(second, "/api/web/control")).json()) as {
    version: string;
  };
  assert.equal(
    (
      await post(
        { ...first, "X-Studio-Control": taken.version },
        "/api/v1/command",
        { commandName: "session.send" },
      )
    ).status,
    409,
  );
  assert.equal(commands, 1);
  assert.equal((await post(first, "/api/v1/command", {
    commandName: "session.resume", input: { threadId: "existing-thread" },
  })).status, 202);
  assert.equal((await post(first, "/api/v1/command", {
    commandName: "session.resume", input: { threadId: "existing-thread", model: "different-model" },
  })).status, 409);
  assert.equal(commands, 2);
  const socket = new WebSocket(
    `${server.origin.replace("http:", "ws:")}/api/web/events`,
    { headers: { Cookie: first.Cookie, Origin: server.origin } },
  );
  await once(socket, "open");
  const closed = once(socket, "close");
  await post(
    { ...second, "X-Studio-Control": next.version },
    "/api/web/devices/revoke",
    { id: taken.deviceId },
  );
  await closed;
  assert.equal(server.adapter.devices().length, 1);
  const saved = await readFile(
    join(directory, "web", "local-devices.json"),
    "utf8",
  );
  assert.ok(!saved.includes(second.Cookie.split("=")[1]!));
  await server.close();
  server = await startWebServer(options);
  const restored = await fetch(`${server.origin}/api/v1/session`, {
    headers: { Cookie: second.Cookie, "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(restored.status, 200);
  const revoked = await fetch(`${server.origin}/api/v1/session`, {
    headers: { Cookie: first.Cookie, "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(revoked.status, 401);
  assert.equal(
    (
      await fetch(`${server.origin}/`, {
        headers: { Host: new URL(server.origin).host },
      })
    ).status,
    200,
  );
});

test("shared terminal survives a view detach and another view can continue the same process", async () => {
  let onData: (value: string) => void = () => {};
  const writes: string[] = [];
  let killed = 0;
  const proc: PtyProcess = {
    write: (data) => {
      writes.push(data);
    },
    resize: () => {},
    kill: () => {
      killed++;
    },
    onData: (listener) => {
      onData = listener;
    },
    onExit: () => {},
  };
  const terminals = new SharedTerminals(async () => tmpdir(), {
    spawn: () => proc,
  });
  const terminal = await terminals.create({ cols: 80, rows: 24 });
  const first = terminals.subscribe(() => {});
  onData("before detach\r\n");
  first();
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(killed, 0);
  assert.match(terminals.list()[0]!.output, /before detach/);
  terminals.write({ id: terminal.id, data: "echo resumed\r" });
  assert.deepEqual(writes, ["echo resumed\r"]);
  terminals.close();
  assert.equal(killed, 1);
});

test("LAN workbench authenticates with its exported CA and issues a Secure pairing cookie", async (t) => {
  const ip = lanAddresses()[0];
  if (!ip) {
    t.skip("No LAN interface is available");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "studio-web-tls-"));
  await writeFile(
    join(directory, "web.html"),
    "<!doctype html><title>Secure workbench</title>",
  );
  const host = {
    bootstrap: async () => ({ contractVersion: 2 }),
    subscribe: () => () => {},
  } as unknown as ClientTransport;
  const terminals = new SharedTerminals(async () => directory, {
    spawn: () => {
      throw new Error("No terminal needed");
    },
  });
  const server = await startWebServer({
    host,
    terminals,
    control: new HostControl(),
    stateDirectory: directory,
    rendererDirectory: directory,
    ip,
  });
  t.after(async () => {
    await server.close();
    terminals.close();
    await rm(directory, { recursive: true, force: true });
  });
  const material = JSON.parse(
    await readFile(join(directory, "web/mobile-https.json"), "utf8"),
  ) as { authority: string };
  const request = (
    path: string,
    body?: string,
  ): Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: string;
  }> =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        server.origin + path,
        {
          ca: material.authority,
          method: body ? "POST" : "GET",
          headers: {
            Origin: server.origin,
            "content-type": "application/json",
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              body: text,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  assert.equal((await request("/")).status, 200);
  const paired = await request(
    "/api/v1/pair",
    JSON.stringify({ code: server.adapter.pairingCode, name: "LAN device" }),
  );
  assert.equal(paired.status, 200);
  assert.match(paired.headers["set-cookie"]![0]!, /; Secure/);
  assert.ok(server.fingerprint);
});
