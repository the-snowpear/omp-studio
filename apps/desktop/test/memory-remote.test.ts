import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ClientTransport } from "@omp-studio/client-contract";
import { TransientMemoryCredentials } from "../src/memory-credentials.js";
import { connectRemoteEndpoint, serveRemoteHost } from "../src/remote/server.js";
import type { RemoteHost } from "../src/remote/host.js";

test("authenticated remote attachment supplies Hindsight credentials only to memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-remote-memory-"));
  const credentials = new TransientMemoryCredentials();
  const host: RemoteHost = {
    composition: { facade: { hasPendingCommands: false }, isBusy: () => false, transport: { bootstrap: async () => ({ selected: {} }), query: async () => ({ ok: true, result: { workspaces: [] } }), subscribe: () => () => {} } as unknown as ClientTransport } as RemoteHost["composition"],
    workspacePath: () => root, registerWorkspace: async () => ({ workspaces: [] }),
    replaceMemoryCredentials: entries => credentials.replace(entries), close: async () => {},
  };
  const server = await serveRemoteHost(host, root);
  try {
    const peer = await connectRemoteEndpoint(root);
    await peer.request("memory.credentials.replace", [{ url: "https://memory.example", token: "remote-secret" }]);
    assert.equal(await credentials.get("https://memory.example"), "remote-secret");
    assert.equal((await readFile(join(root, "remote-endpoint.json"), "utf8")).includes("remote-secret"), false);
    const cleared = new Promise<void>(resolve => {
      const off = credentials.subscribe(() => { void credentials.get("https://memory.example").then(value => { if (value === undefined) { off(); resolve(); } }); });
    });
    peer.close();
    await cleared;
    const resumed = await connectRemoteEndpoint(root);
    assert.equal(await credentials.get("https://memory.example"), undefined);
    await resumed.request("memory.credentials.replace", [{ url: "https://memory.example", token: "remote-secret" }]);
    assert.equal(await credentials.get("https://memory.example"), "remote-secret");
    await resumed.request("memory.credentials.replace", []);
    assert.equal(await credentials.get("https://memory.example"), undefined);
    resumed.close();
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
