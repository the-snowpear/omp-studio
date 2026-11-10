import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { contractFixtures } from "@omp-studio/testkit";
import { createConversationEngine } from "./conversationEngine";
import { timelineRowKey } from "./conversationViewModel";
import { useConversationReading, type ConversationReadingMemory } from "./useConversationReading";

vi.mock("./conversationReveal", async original => ({ ...await original<typeof import("./conversationReveal")>(), revealConversationTarget: vi.fn(async () => false) }));
const engines: ReturnType<typeof createConversationEngine>[] = [];
const scrollers: HTMLElement[] = [];
afterEach(() => { cleanup(); engines.splice(0).forEach(engine => engine.dispose()); scrollers.splice(0).forEach(node => node.remove()); });
function snapshot() {
  const page = contractFixtures.queryResponses["session.transcript.readPage"];
  if (!page.ok) throw new Error("Expected transcript fixture");
  const engine = createConversationEngine({ preview: true, client: null, identity: null, canRead: false, runtimeConnected: false, previewItems: page.result.items });
  engines.push(engine); engine.start(); return engine.getSnapshot();
}
function scroller(item: string) {
  const node = document.createElement("section"), row = document.createElement("div");
  row.dataset.itemId = item; node.append(row); document.body.append(node); scrollers.push(node);
  Object.defineProperty(node, "scrollHeight", { value: 1200 });
  return { current: node };
}

it("keeps only a scalar reading anchor and restores it after the old view is released", async () => {
  const value = snapshot(), memory: ConversationReadingMemory = {};
  const previous = scroller(timelineRowKey(value.rows[0]!));
  previous.current.scrollTop = 350;
  let saveBeforeDetach = () => {};
  const mounted = renderHook(() => useConversationReading({ memory, visible: true, snapshot: value, scrollerRef: previous, follow: false, detachFromLatest: vi.fn(), loadOlder: vi.fn(), beforeDetach: save => { saveBeforeDetach = save; return () => {}; } }));
  saveBeforeDetach();
  previous.current.remove(); previous.current.scrollTop = 0;
  mounted.unmount();
  expect(memory.reading?.anchor?.scrollTop).toBe(350);
  expect(memory.reading?.rows).toBe(value.rows.length);
  const next = scroller(timelineRowKey(value.rows[0]!)), detach = vi.fn();
  renderHook(() => useConversationReading({ memory, visible: true, snapshot: value, scrollerRef: next, follow: true, detachFromLatest: detach, loadOlder: vi.fn() }));
  await waitFor(() => expect(next.current.scrollTop).toBe(350));
  expect(detach).toHaveBeenCalledOnce();
  expect(memory.reading).not.toHaveProperty("snapshot");
});

it("backfills an old anchor without repeatedly reading when Store retention stops growing", async () => {
  const value = snapshot();
  const memory: ConversationReadingMemory = { reading: { anchor: { itemId: "older-item", offset: 0, scrollTop: 80, scrollHeight: 1200 }, following: false, rows: value.rows.length } };
  const node = scroller(timelineRowKey(value.rows[0]!)), loadOlder = vi.fn(), detach = vi.fn();
  const current = { ...value, state: { ...value.state, hasMoreBefore: true } };
  const mounted = renderHook(({ value }) => useConversationReading({ memory, visible: true, snapshot: value, scrollerRef: node, follow: true, detachFromLatest: detach, loadOlder }), { initialProps: { value: current } });
  expect(loadOlder).toHaveBeenCalledOnce();
  mounted.rerender({ value: { ...current, loadingOlder: true } });
  mounted.rerender({ value: { ...current, loadingOlder: false } });
  await waitFor(() => expect(detach).toHaveBeenCalledOnce());
  expect(loadOlder).toHaveBeenCalledOnce();
});

it("restores an anchor from cached rows before the refresh completes", async () => {
  const value = snapshot(), itemId = timelineRowKey(value.rows[0]!);
  const memory: ConversationReadingMemory = { reading: { anchor: { itemId, offset: 0, scrollTop: 350, scrollHeight: 1200 }, following: false, rows: value.rows.length } };
  const node = scroller(itemId), detach = vi.fn(), loadOlder = vi.fn();
  const cached = { ...value, state: { ...value.state, hydrateStatus: "resyncing" as const } };
  const mounted = renderHook(({ current }) => useConversationReading({ memory, visible: true, snapshot: current, scrollerRef: node, follow: false, detachFromLatest: detach, loadOlder }), { initialProps: { current: cached as typeof value } });
  await waitFor(() => expect(node.current.scrollTop).toBe(350));
  mounted.rerender({ current: value });
  expect(detach).toHaveBeenCalledOnce(); expect(loadOlder).not.toHaveBeenCalled();
});
