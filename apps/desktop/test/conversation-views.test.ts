import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationViews, parseConversationViewState } from "../src/conversation-views.js";

test("visible-window union preserves siblings, hidden windows do not keep targets foreground and legacy preload stays compatible", () => {
  const views = new ConversationViews();
  const first = {}, second = {};
  let latest: readonly string[] | undefined, epoch = 1;
  const off = views.registerController({ epoch: () => epoch, setVisibleSessions: (ids) => { latest = ids === undefined ? undefined : [...ids].sort(); } });
  views.registerWindow(first, true); views.registerWindow(second, true);
  assert.equal(latest, undefined);
  views.report(first, { runtimeEpoch: 1, visibleSessionIds: ["main"] });
  assert.equal(latest, undefined, "an older second preload keeps the connection foreground");
  views.report(second, { runtimeEpoch: 1, visibleSessionIds: ["child"] });
  assert.deepEqual(latest, ["child", "main"]);
  for (let i = 0; i < 50; i++) {
    views.setVisible(first, false); assert.deepEqual(latest, ["child"]);
    views.setVisible(first, true); assert.deepEqual(latest, ["child", "main"]);
  }
  views.setVisible(second, false); views.setVisible(first, false); assert.deepEqual(latest, []);
  views.setVisible(second, true); assert.deepEqual(latest, ["child"]);
  epoch = 2; views.refresh(); assert.equal(latest, undefined);
  assert.equal(views.report(second, { runtimeEpoch: 1, visibleSessionIds: ["stale"] }), false);
  views.remove(first); views.report(second, { runtimeEpoch: 2, visibleSessionIds: ["new"] }); assert.deepEqual(latest, ["new"]);
  views.reset(second); assert.equal(latest, undefined);
  views.report(second, { runtimeEpoch: 2, visibleSessionIds: [] }); assert.deepEqual(latest, []);
  views.remove(second); assert.deepEqual(latest, []); off(); off();
});
test("reports cannot carry extra fields, invalid epochs, oversize IDs or more than eight targets", () => {
  const good = { runtimeEpoch: 1, visibleSessionIds: ["child"] };
  assert.deepEqual(parseConversationViewState(good), good);
  for (const input of [{ ...good, runtimeEpoch: 0 }, { ...good, runtimeEpoch: NaN }, { ...good, visibleSessionIds: ["x".repeat(257)] },
    { ...good, visibleSessionIds: Array(9).fill("child") }, { ...good, visibleSessionIds: [4] }, { ...good, command: "resume" }]) assert.equal(parseConversationViewState(input), undefined);
});
