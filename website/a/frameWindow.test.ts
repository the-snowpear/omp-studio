import { test } from "node:test";
import assert from "node:assert/strict";
import { createFrameWindow } from "./frameWindow.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("scrubbing follows the requested frame while old decoded images are released", async () => {
  const retained = new Set<number>();
  let ready = 0;
  const frames = createFrameWindow({
    count: 170,
    async load(index) {
      retained.add(index);
      return { index, close: () => { retained.delete(index); } };
    },
    onReady: () => { ready += 1; },
  });
  frames.setActive(true);
  await flush();
  for (const target of [0, 30, 90, 169, 60]) {
    frames.setTarget(target);
    await flush();
    assert.equal(frames.nearest(target)?.index, target);
    assert.ok(retained.size <= 13);
    assert.ok([...retained].every(index => Math.abs(index - target) <= 6));
  }
  assert.ok(ready > 0);
  frames.setActive(false);
  assert.equal(retained.size, 0);
  assert.equal(frames.nearest(60), undefined);
  frames.setActive(true);
  await flush();
  assert.equal(frames.nearest(60)?.index, 60);
  frames.dispose();
  assert.equal(retained.size, 0);
});

test("a decode that completes after leaving the passage is closed instead of retained", async () => {
  let finish!: (frame: { close(): void }) => void;
  let closed = 0;
  let ready = 0;
  const frames = createFrameWindow({
    count: 1,
    load: () => new Promise<{ close(): void }>(resolve => { finish = resolve; }),
    onReady: () => { ready += 1; },
  });
  frames.setActive(true);
  frames.setActive(false);
  finish({ close: () => { closed += 1; } });
  await flush();
  assert.equal(closed, 1);
  assert.equal(ready, 0);
  assert.equal(frames.nearest(0), undefined);
  frames.dispose();
});
