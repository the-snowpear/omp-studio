import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConversationRuntimeEvent } from "../src/conversation-validation.js";

test("parser rollback performs full validation while preserving the same immutable event contract", () => {
  const original = { kind: "conversation.tool.updated", sessionId: "s", turnId: "t", toolCallId: "call", updateMode: "append", output: "safe" };
  const parsed = parseConversationRuntimeEvent(original);
  assert.equal(parseConversationRuntimeEvent(parsed, undefined, true), parsed);
  const reparsed = parseConversationRuntimeEvent(parsed, undefined, false);
  assert.notEqual(reparsed, parsed);
  assert.deepEqual(reparsed, parsed);
  assert.equal(Object.isFrozen(reparsed), true);
  for (const reuse of [true, false]) {
    assert.throws(() => parseConversationRuntimeEvent({ ...parsed, unexpected: true }, undefined, reuse));
    assert.throws(() => parseConversationRuntimeEvent({ ...parsed, output: 10 }, undefined, reuse));
  }
});
