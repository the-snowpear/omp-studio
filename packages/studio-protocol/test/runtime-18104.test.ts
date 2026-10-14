import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkbenchOperation, validateWorkbenchResult } from "../src/contracts/workbench.js";
import { validatePredictionInput, validatePredictionEvent } from "../src/contracts/prediction-channel.js";

test("new settings reject unsafe nested fields, excessive inventories and unknown keys", () => {
  const base = { kind: "preferences.features.set", sessionId: "session", key: "task.agentAccountPools", scope: "session" };
  assert.throws(() => validateWorkbenchOperation({ ...base, value: JSON.parse('{"reviewer":{"__proto__":[]}}') }));
  assert.throws(() => validateWorkbenchOperation({ ...base, key: "unregistered.secret", value: "value" }));
  assert.throws(() => validateWorkbenchOperation({ ...base, value: { reviewer: { provider: Array(257).fill("account") } } }));
  assert.throws(() => validateWorkbenchResult("accounts.pool.options", { accounts: [{ provider: "p", identityKey: "account", label: "account", accessToken: "secret" }], truncated: false }));
});

test("plan roles require approval and refinement requires actual feedback", () => {
  const base = { kind: "mode.plan.review.resolve", sessionId: "session", reviewId: "review" };
  assert.throws(() => validateWorkbenchOperation({ ...base, decision: "refine", feedback: " " }));
  assert.throws(() => validateWorkbenchOperation({ ...base, decision: "dismiss", role: "slow" }));
  assert.throws(() => validateWorkbenchOperation({ ...base, decision: "execute", role: "x".repeat(129) }));
});

test("imports preserve local sessions and cannot claim a replaced result", () => {
  assert.throws(() => validateWorkbenchResult("session.portability.import", { sessionId: "session", mode: "replaced", workspaceId: "workspace" }));
  assert.throws(() => validateWorkbenchOperation({ kind: "session.portability.prepare", sessionId: "session", artifactId: "../../private" }));
  assert.throws(() => validateWorkbenchOperation({ kind: "worktrees.session.remove.apply", sessionId: "session", token: "directory-path" }));
});

test("next-message predictions carry only editor state on input and keep the longer reply bounded", () => {
  validatePredictionInput({ kind: "next", revision: 1, empty: true });
  assert.throws(() => validatePredictionInput({ kind: "next", revision: 1, empty: true, text: "private draft" }));
  validatePredictionEvent({ kind: "next", channelId: "00000000-0000-4000-8000-000000000001", revision: 1, suffix: "x".repeat(500) });
  assert.throws(() => validatePredictionEvent({ kind: "next", channelId: "00000000-0000-4000-8000-000000000001", revision: 1, suffix: "x".repeat(501) }));
});
