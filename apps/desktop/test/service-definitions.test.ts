import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ServiceDefinitionStore, type SecretCodec } from "../src/service-definitions.js";

function codec(): SecretCodec {
  const key = randomBytes(32);
  return { available: () => true,
    encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    decrypt(value) { const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8"); },
  };
}
test("service definitions are encrypted, scoped, and revision-fenced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-service-defs-"));
  try {
    const file = join(directory, "services.enc"); const store = new ServiceDefinitionStore(file, codec());
    const original = await store.save({ workspaceId: "workspace-a", spec: { name: "server", command: "npm run dev", env: { TEST_SECRET: "secret-value" } } });
    assert.equal((await readFile(file)).includes("secret-value"), false);
    assert.deepEqual(await store.list("workspace-b"), []);
    assert.equal((await store.list("workspace-a"))[0]!.spec.env!.TEST_SECRET, "secret-value");
    const inputs = { workspaceId: "workspace-a", id: original.id, revision: original.revision, spec: { name: "server", command: "npm run preview" } };
    const outcomes = await Promise.allSettled([store.save(inputs), store.save(inputs)]);
    assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 1);
    await assert.rejects(store.remove({ workspaceId: "workspace-b", id: original.id, revision: 2 }), /changed/);
    await store.remove({ workspaceId: "workspace-a", id: original.id, revision: 2 });
    assert.deepEqual(await store.list("workspace-a"), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("unavailable secret storage fails without writing plaintext", async () => {
  const store = new ServiceDefinitionStore("unused", { ...codec(), available: () => false });
  await assert.rejects(store.save({ workspaceId: "w", spec: { name: "s", command: "echo hi" } }), /unavailable/);
});
