import assert from "node:assert/strict";
import { test } from "node:test";
import { tailUtf8, truncateUtf8, utf8ByteLength } from "../src/conversation-text.js";

test("tailUtf8 keeps the newest bytes and never splits a codepoint", () => {
  assert.deepEqual(tailUtf8("abcdef", 3), { text: "def", truncated: true });
  assert.deepEqual(tailUtf8("abc", 8), { text: "abc", truncated: false });
  assert.deepEqual(tailUtf8("", 8), { text: "", truncated: false });
  assert.deepEqual(tailUtf8("abc", 0), { text: "", truncated: true });

  // 3-byte CJK: a 4-byte budget must drop the partial leading character
  // rather than decode a continuation byte on its own.
  const cjk = tailUtf8("你好世界", 4);
  assert.equal(cjk.truncated, true);
  assert.equal(cjk.text, "界");
  assert.ok(utf8ByteLength(cjk.text) <= 4);

  // 4-byte astral plane characters must survive whole.
  const astral = tailUtf8("𝄞𝄞𝄞", 5);
  assert.equal(astral.text, "𝄞");
  assert.ok(utf8ByteLength(astral.text) <= 5);
});

test("tailUtf8 is the mirror of truncateUtf8, not a copy of it", () => {
  const source = "你好世界";
  assert.equal(truncateUtf8(source, 6).text, "你好");
  assert.equal(tailUtf8(source, 6).text, "世界");
});

test("tailUtf8 stays linear on large multibyte input", () => {
  // The previous renderer-local implementation re-encoded the whole candidate
  // once per dropped character: 120k CJK chars took ~14s and froze the UI.
  const source = "国".repeat(120_000);
  const started = process.hrtime.bigint();
  const result = tailUtf8(source, 64 * 1024);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(utf8ByteLength(result.text) <= 64 * 1024);
  assert.equal(result.truncated, true);
  assert.ok(elapsedMs < 250, `tailUtf8 took ${elapsedMs.toFixed(1)}ms on 120k CJK chars`);
});
