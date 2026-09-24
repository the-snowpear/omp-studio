import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateUtf8 } from "@omp-studio/studio-protocol";
import { ReplayTextBuffer } from "../src/replay-text-buffer.js";

test("incremental byte counts match exact UTF-8 / JSON across surrogate boundaries and compaction", () => {
  const buffer = new ReplayTextBuffer(256 * 1024);
  let expected = "";
  const chunks = ['中', 'a\n\t\u0000"\\', '\ud83d', '\ude80', '\ud800', 'x', '\udc00'];
  for (let i = 0; i < 9000; i++) {
    const chunk = chunks[i % chunks.length]!;
    expected += chunk;
    assert.equal(buffer.append(chunk), false);
    assert.equal(buffer.byteLength, Buffer.byteLength(expected));
    assert.equal(buffer.jsonBytes, Buffer.byteLength(JSON.stringify(expected)) - 2);
    assert.ok(buffer.chunkCount <= 1024);
    if (i % 100 === 0) assert.equal(buffer.materialize(), expected);
  }
  assert.equal(buffer.materialize(), expected);
  buffer.clear();
  assert.equal(buffer.materialize(), "");
  assert.equal(buffer.jsonBytes, 0);
  assert.equal(buffer.chunkCount, 0);
});

test("head truncation and replacement match the original whole-string algorithm", () => {
  for (const limit of [1, 2, 3, 4, 15, 101]) {
    const buffer = new ReplayTextBuffer(limit);
    let expected = "";
    let seed = 31;
    const chunks = ['a', '中', '\ud83d', '\ude80', '🚀', '\u0000', '\ud800', '', 'xx'];
    for (let i = 0; i < 3000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const chunk = chunks[seed % chunks.length]!;
      const replace = seed % 17 === 0;
      const old = truncateUtf8((replace ? "" : expected) + chunk, limit);
      assert.equal(replace ? buffer.replace(chunk) : buffer.append(chunk), old.truncated);
      expected = old.text;
      assert.equal(buffer.materialize(), expected);
      assert.equal(buffer.byteLength, Buffer.byteLength(expected));
      assert.equal(buffer.jsonBytes, Buffer.byteLength(JSON.stringify(expected)) - 2);
    }
  }
});
