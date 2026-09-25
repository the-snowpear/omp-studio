import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSkillshareAction, validateSkillshareOperation, validateSkillshareResult } from "../src/contracts/skillshare.js";
import { validateLiveAudioOperation, validateLiveAudioResult } from "../src/contracts/live-audio.js";
test("registry actions require exact public fields and explicit review decisions", () => {
  validateSkillshareAction({ type: "install", scope: "project", specs: ["@scope/name@^1.0.0"] });
  for (const action of [
    { type: "publish", scope: "scope", directory: "../private" },
    { type: "import", file: "C:/private/archive.skill" },
    { type: "token.create", name: "x", packages: [], token: "sks_secret" },
    { type: "owner.add", package: "unscoped", username: "other" },
  ]) assert.throws(() => validateSkillshareAction(action));
  assert.throws(() => validateSkillshareOperation({ kind: "skillshare.execute", sessionId: "s", id: "1".repeat(36), digest: "a".repeat(64) }));
  assert.throws(() => validateSkillshareResult("skillshare.tokens", { tokens: [{ id: "a", name: "n", packages: [], createdAt: 1, token: "sks_secret" }] }));
});
test("Live control rejects device credentials and bounded transcripts never carry audio", () => {
  assert.throws(() => validateLiveAudioOperation({ kind: "live.audio.prepare", sessionId: "s", endpoint: "private" }));
  assert.throws(() => validateLiveAudioOperation({ kind: "live.audio.mute", sessionId: "s", audioId: "1".repeat(36) }));
  const state = { available: true, attached: false, voice: "sol", phase: "off", muted: false, inputLevel: 0, outputLevel: 0, transcripts: [] };
  validateLiveAudioResult("live.audio.status", state);
  assert.throws(() => validateLiveAudioResult("live.audio.status", { ...state, samples: [0.5] }));
  assert.throws(() => validateLiveAudioResult("live.audio.status", { ...state, inputLevel: NaN }));
});
