import { strict as assert } from "node:assert";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryCredentialStore, TransientMemoryCredentials, localMemoryCredentialProvider, startMemoryCredentialBroker } from "../src/memory-credentials.js";
import { registerMemoryCredentialIpc } from "../src/memory-credentials-ipc.js";
import { MEMORY_CREDENTIAL_CHANNELS } from "../src/memory-credentials-shared.js";

test("encrypted Hindsight credentials stay scoped to target and URL and reach only an authenticated worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-memory-credentials-"));
  const key = randomBytes(32);
  let unlocked = true;
  const codec = {
    available: () => unlocked,
    encrypt(value: string) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    decrypt(value: Buffer) { const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
  };
  const store = new MemoryCredentialStore(join(directory, "memory.enc"), codec);
  let broker: Awaited<ReturnType<typeof startMemoryCredentialBroker>> | undefined;
  try {
    await store.set("local", "http://localhost:8888/", "local-secret");
    await store.set("ssh:one", "http://localhost:8888", "ssh-secret");
    assert.equal((await readFile(store.file)).includes(Buffer.from("local-secret")), false);
    const reopened = new MemoryCredentialStore(store.file, codec);
    assert.equal(await reopened.has("local", "http://localhost:8888"), true);
    assert.deepEqual(await reopened.list("ssh:one"), [{ url: "http://localhost:8888", token: "ssh-secret" }]);
    assert.deepEqual(await reopened.list("ssh:two"), []);
    unlocked = false;
    await assert.rejects(store.set("local", "http://localhost:8888", "must-not-overwrite"));
    unlocked = true;
    assert.equal(await store.has("local", "http://localhost:8888"), true);

    const handlers = new Map<string, (event: { sender: { getURL(): string; isDestroyed(): boolean } }, input: unknown) => unknown>();
    const ipc = { handle(channel: string, listener: (event: { sender: { getURL(): string; isDestroyed(): boolean } }, input: unknown) => unknown) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } };
    const registration = registerMemoryCredentialIpc({ ipcMain: ipc, store, isTrustedSender: () => true, activeTarget: () => null, supportsSync: () => true });
    const sender = { getURL: () => "app://test", isDestroyed: () => false };
    const status = await handlers.get(MEMORY_CREDENTIAL_CHANNELS.status)!({ sender }, { targetId: null, url: "http://localhost:8888" });
    assert.deepEqual(status, { ok: true, configured: true, syncSupported: true });
    const stale = await handlers.get(MEMORY_CREDENTIAL_CHANNELS.status)!({ sender }, { targetId: "other", url: "http://localhost:8888" }) as { ok: boolean };
    assert.equal(stale.ok, false);
    registration.dispose();

    broker = await startMemoryCredentialBroker(localMemoryCredentialProvider(store, "local"), "worker-auth");
    assert.equal((await fetch(`${broker.url}/credential?url=${encodeURIComponent("http://localhost:8888")}`)).status, 401);
    const headers = { authorization: "Bearer worker-auth" };
    const result = await (await fetch(`${broker.url}/credential?url=${encodeURIComponent("http://localhost:8888")}`, { headers })).json() as { token: string; revision: number };
    assert.equal(result.token, "local-secret");
    const waiting = fetch(`${broker.url}/watch?revision=${result.revision}`, { headers }).then(response => response.json()) as Promise<{ revision: number }>;
    await new Promise(resolve => setTimeout(resolve, 20));
    await store.set("local", "http://localhost:8888", "rotated-secret");
    assert.ok((await waiting).revision > result.revision);
    await store.set("local", "http://localhost:8888", undefined);
    assert.equal(await store.has("local", "http://localhost:8888"), false);
    assert.equal(await store.has("ssh:one", "http://localhost:8888"), true);

    const remote = new TransientMemoryCredentials();
    let provisioned = false;
    const beforeProvisioning = remote.get("http://localhost:8888").then(value => { provisioned = true; return value; });
    await Promise.resolve();
    assert.equal(provisioned, false);
    remote.replace(await store.list("ssh:one"));
    assert.equal(await beforeProvisioning, "ssh-secret");
    assert.equal(await remote.get("http://localhost:8888"), "ssh-secret");
    assert.equal(await remote.get("https://other.example"), undefined);
  } finally {
    await broker?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
