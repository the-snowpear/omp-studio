import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeSkillshareToken } from "../src/chrome-skillshare.js";
test("token secrets are session-scoped, expire, and may be revealed exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-skill-token-"));
  try {
    await mkdir(join(root, "skillshare", "secrets"), { recursive: true });
    const secretId = randomUUID(); const file = join(root, "skillshare", "secrets", secretId + ".json");
    await writeFile(file, JSON.stringify({ sessionId: "s", token: "sks_fake_fixture", name: "test", expiresAt: Date.now() + 100000 }));
    await assert.rejects(() => takeSkillshareToken(root, { sessionId: "other", secretId }), /another session/u);
    const results = await Promise.allSettled([takeSkillshareToken(root, { sessionId: "s", secretId }), takeSkillshareToken(root, { sessionId: "s", secretId })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    await assert.rejects(() => takeSkillshareToken(root, { sessionId: "s", secretId }));
    await writeFile(file, JSON.stringify({ sessionId: "s", token: "sks_fake_fixture", name: "test", expiresAt: Date.now() - 1 }));
    await assert.rejects(() => takeSkillshareToken(root, { sessionId: "s", secretId }), /expired/u);
    await assert.rejects(() => takeSkillshareToken(root, { sessionId: "s", secretId: "../../outside" }), /identity/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
