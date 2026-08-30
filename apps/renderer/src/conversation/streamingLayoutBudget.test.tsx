import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, type RefObject } from "react";
import type { RuntimeEpoch, SessionId } from "@omp-studio/studio-protocol";
import { ConversationPane } from "./ConversationPane";
import { ConversationMinimap, MEASURE_INTERVAL_MS, MEASURE_INTERVAL_STREAMING_MS } from "./ConversationMinimap";
import { useConversationScroll } from "./useConversationScroll";
import type { ConversationSnapshot } from "./conversationEngine";
import { resetConversation, tailStreaming, timelineRowKey, type AssistantSegment, type TimelineRow } from "./conversationViewModel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const AT = "2026-08-30T00:00:00.000Z";
const TEXT: AssistantSegment = { type: "text", key: "t0", text: "正在回答…" };

function userRow(id: string): TimelineRow {
  return { type: "user", itemId: id, createdAt: AT, text: id };
}
function assistantRow(id: string, status: "streaming" | "completed"): TimelineRow {
  return { type: "assistant", itemId: id, createdAt: AT, segments: [TEXT], status, ...(status === "streaming" ? { turnOpen: true } : {}) };
}

describe("tailStreaming", () => {
  it("只认尾部：正在产出的末行为真，收束后为假", () => {
    expect(tailStreaming([userRow("u1"), assistantRow("a1", "streaming")])).toBe(true);
    expect(tailStreaming([userRow("u1"), assistantRow("a1", "completed")])).toBe(false);
    expect(tailStreaming([])).toBe(false);
  });
  it("末尾跟着压缩行时仍然算流式", () => {
    expect(tailStreaming([assistantRow("a1", "streaming"), { type: "compacting" }])).toBe(true);
  });
  it("末尾跟着待发送用户行时仍然算流式", () => {
    const pending: Extract<TimelineRow, { type: "user" }> = {
      type: "user",
      itemId: "pending:u1",
      createdAt: AT,
      text: "queued",
      pending: "pending",
      requestId: "u1",
    };
    expect(tailStreaming([
      assistantRow("a1", "streaming"),
      pending,
    ])).toBe(true);
  });
  it("历史里的流式行不会让整屏一直被判为流式", () => {
    const rows: TimelineRow[] = [assistantRow("old", "streaming")];
    for (let index = 0; index < 6; index += 1) rows.push(userRow(`u${index}`), assistantRow(`a${index}`, "completed"));
    expect(tailStreaming(rows)).toBe(false);
  });
  it("只要后面已有实质行就不会命中过期的流式行", () => {
    expect(tailStreaming([assistantRow("stale", "streaming"), userRow("next")])).toBe(false);
    expect(tailStreaming([
      assistantRow("stale", "streaming"),
      userRow("next"),
      assistantRow("done", "completed"),
    ])).toBe(false);
  });
});

function snapshot(rows: readonly TimelineRow[]): ConversationSnapshot {
  const identity = { sessionId: "s1" as SessionId, runtimeEpoch: 1 as RuntimeEpoch };
  return { state: resetConversation(0, identity, "ready"), rows, demo: false, loadingOlder: false, identityKey: "s1:1:" };
}

describe("流式期间的布局预算", () => {
  it("scroller 上带出流式标记，CSS 据此把工具卡高度过渡收成瞬时", () => {
    // 高度过渡（0fr→1fr）是布局属性：每帧都要把卡内正文重排一遍，而流式期间主线程
    // 已经没有空闲帧。标记挂在 scroller 上，收束后必须立刻摘掉，否则展开动画从此消失。
    const view = render(<ConversationPane snapshot={snapshot([userRow("u1"), assistantRow("a1", "streaming")])} onLoadOlder={() => {}} />);
    const scroller = () => view.container.querySelector(".convo-scroll");
    expect(scroller()?.getAttribute("data-live-stream")).toBe("1");
    act(() => { view.rerender(<ConversationPane snapshot={snapshot([userRow("u1"), assistantRow("a1", "completed")])} onLoadOlder={() => {}} />); });
    expect(scroller()?.hasAttribute("data-live-stream")).toBe(false);
  });
});

type ScrollHandle = ReturnType<typeof useConversationScroll>;

function ScrollHarness({ scrollerRef, contentKey, onHandle }: {
  scrollerRef: RefObject<HTMLElement | null>;
  contentKey: string;
  onHandle: (handle: ScrollHandle) => void;
}) {
  onHandle(useConversationScroll({ scrollerRef, identityKey: "s1", itemCount: 1, loadingOlder: false, contentKey }));
  return null;
}

describe("对话跟底的唯一写入者", () => {
  it("内容提交不直接写，等最终文档尺寸回调后只写一次", () => {
    // 虚拟列表测量会在 React 提交之后再改一次容器高度。跟底只订阅最终 `.convo-doc`
    // 尺寸，不能在 contentKey effect 与虚拟列表 onChange 各写一次。
    let resize: (() => void) | null = null;
    const observed: Element[] = [];
    class StubResizeObserver {
      constructor(callback: () => void) { resize = callback; }
      observe(element: Element) { observed.push(element); }
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    const el = document.createElement("div");
    const doc = document.createElement("div");
    doc.className = "convo-doc";
    el.append(doc);
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 900 });
    let writes = 0;
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => 0, set: () => { writes += 1; } });
    const ref = { current: el as HTMLElement | null };
    let handle: ScrollHandle | null = null;
    const view = render(<ScrollHarness scrollerRef={ref} contentKey="a" onHandle={(value) => { handle = value; }} />);
    expect(handle).not.toBeNull();
    expect(observed).toEqual([doc, el]);
    writes = 0;
    act(() => { view.rerender(<ScrollHarness scrollerRef={ref} contentKey="b" onHandle={(value) => { handle = value; }} />); });
    expect(writes).toBe(0);
    act(() => { resize?.(); });
    expect(writes).toBe(1);
  });

  it("读者已经离开尾部时不写", () => {
    let resize: (() => void) | null = null;
    class StubResizeObserver {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    const el = document.createElement("div");
    const doc = document.createElement("div");
    doc.className = "convo-doc";
    el.append(doc);
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 900 });
    let writes = 0;
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => 0, set: () => { writes += 1; } });
    const ref = { current: el as HTMLElement | null };
    let handle: ScrollHandle | null = null;
    render(<ScrollHarness scrollerRef={ref} contentKey="a" onHandle={(value) => { handle = value; }} />);
    act(() => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); });
    writes = 0;
    expect(handle).not.toBeNull();
    act(() => { resize?.(); });
    expect(writes).toBe(0);
  });
});

function MinimapHarness({ rows, busy }: { rows: readonly TimelineRow[]; busy: boolean }) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  return (
    <div>
      <div data-testid="scroller" ref={(element) => { scrollerRef.current = element; }}>
        <div className="convo-doc">
          {rows.map((row) => <div key={timelineRowKey(row)} data-item-id={timelineRowKey(row)} className="ev" />)}
        </div>
      </div>
      <ConversationMinimap rows={rows} scrollerRef={scrollerRef} busy={busy} />
    </div>
  );
}

/** 每次全量重测都会对 scroller 做一次 `querySelectorAll`；数它就是数重测次数。 */
function countMeasures(busy: boolean, interval: number): { readonly measures: number; readonly activeSyncs: number } {
  let clock = 0;
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const rows = () => [userRow("u1"), assistantRow(`a${clock}`, "streaming")];
  const view = render(<MinimapHarness rows={rows()} busy={busy} />);
  const scroller = view.container.querySelector<HTMLElement>("[data-testid='scroller']")!;
  let height = 1000;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
  scroller.getBoundingClientRect = () => ({ top: 0, height: 400 } as DOMRect);
  const inner = scroller.querySelectorAll.bind(scroller);
  let measures = 0;
  scroller.querySelectorAll = ((selector: string) => {
    if (selector === "[data-item-id]") measures += 1;
    return inner(selector);
  }) as HTMLElement["querySelectorAll"];
  const track = view.container.querySelector<HTMLElement>(".minimap-track")!;
  const trackQuery = track.querySelectorAll.bind(track);
  let activeSyncs = 0;
  track.querySelectorAll = ((selector: string) => {
    if (selector === ".mm-mark") activeSyncs += 1;
    return trackQuery(selector);
  }) as HTMLElement["querySelectorAll"];
  // 逼近真实流式节奏：每 50ms 一次内容变化，持续 1 秒。
  const step = 50;
  for (let tick = 0; tick < 20; tick += 1) {
    clock += step;
    height += 120;
    act(() => { vi.advanceTimersByTime(step); view.rerender(<MinimapHarness rows={rows()} busy={busy} />); });
  }
  clock += interval;
  act(() => { vi.advanceTimersByTime(interval); });
  return { measures, activeSyncs };
}

describe("流式期间的小地图测量", () => {
  it("流式时把全量重测退到更宽的闸门", () => {
    // 圆点位置是导航用的近似量；流式的每一帧都在换尾行圆点、改 scrollHeight，两道跳过
    // 条件全部失效，200ms 一次的全子树 querySelectorAll + 逐节点 rect 正好压在最忙的
    // 主线程上。
    const idle = countMeasures(false, MEASURE_INTERVAL_MS);
    cleanup();
    const streaming = countMeasures(true, MEASURE_INTERVAL_STREAMING_MS);
    expect(idle.measures).toBeGreaterThanOrEqual(5);
    expect(streaming.measures * 2).toBeLessThanOrEqual(idle.measures);
    // rows 与 ResizeObserver 仍可每帧请求同步，但活跃点遍历必须跟全量测量走同一道闸门。
    expect(streaming.activeSyncs).toBeLessThanOrEqual(streaming.measures + 1);
    expect(streaming.activeSyncs).toBeLessThan(10);
  });
});
