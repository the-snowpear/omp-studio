import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineRow } from "./conversationViewModel";
import { timelineRowKey } from "./conversationViewModel";
import {
  activeMarkId,
  ConversationMinimap,
  deriveMinimapMarks,
  pickNextMark,
  scrollOffsetToCenter,
  spaceMinimapMarks,
  type MinimapMark,
} from "./ConversationMinimap";

const ROWS: TimelineRow[] = [
  { type: "user", itemId: "u1", createdAt: "t1", text: " 帮我修一下登录页 " },
  {
    type: "assistant",
    itemId: "a1",
    createdAt: "t2",
    segments: [{ type: "text", key: "k1", text: "好的，我先看一下相关文件。" }],
    status: "completed",
  },
  {
    type: "assistant",
    itemId: "a2",
    createdAt: "t3",
    segments: [
      {
        type: "batch",
        key: "k2",
        tools: [{ toolCallId: "c1", toolName: "Bash", arguments: { command: "npm test" }, status: "succeeded" }],
      },
    ],
    status: "completed",
    presentation: "process",
  },
  { type: "assistant", itemId: "a3", createdAt: "t4", segments: [], status: "error" },
  {
    type: "compaction",
    item: { kind: "compaction", itemId: "cp1", parentId: null, createdAt: "t5", summary: "早期对话压缩" },
  },
];

function mark(itemId: string, type: MinimapMark["type"]): MinimapMark {
  return { itemId, type, label: type, preview: "", turn: 0 };
}

describe("deriveMinimapMarks", () => {
  it("连续 assistant rows 只派生一个与真实 assistant run 对应的圆点", () => {
    const marks = deriveMinimapMarks(ROWS);
    expect(marks.map((entry) => entry.itemId)).toEqual(["u1", "a1", "cp1"]);
    expect(marks.map((entry) => entry.type)).toEqual(["user", "error", "compact"]);
    expect(marks.map((entry) => entry.turn)).toEqual([1, 2, 3]);
  });

  it("把发送失败的用户行和工具失败的 assistant run 分类为错误", () => {
    const rows: TimelineRow[] = [
      {
        type: "user",
        itemId: "failed-user",
        createdAt: "t1",
        text: "请重试",
        pending: "failed",
        error: "network unavailable",
      },
      {
        type: "assistant",
        itemId: "failed-tool-run",
        createdAt: "t2",
        status: "completed",
        segments: [{
          type: "batch",
          key: "failed-batch",
          tools: [{ toolCallId: "failed-call", toolName: "Bash", status: "failed" }],
        }],
      },
    ];

    const marks = deriveMinimapMarks(rows);
    expect(marks.map((entry) => entry.type)).toEqual(["error", "error"]);
    expect(marks[0]!.preview).toContain("network unavailable");
  });

  it("marks an in-progress compact divider as compact", () => {
    const marks = deriveMinimapMarks([{ type: "compacting", action: "context-full" }]);
    expect(marks).toEqual([
      { itemId: "compacting", type: "compact", label: "压缩中", preview: "正在压缩当前上下文", turn: 1 },
    ]);
  });

  it("预览文本取用户原文 / 工具摘要 / 压缩摘要", () => {
    const marks = deriveMinimapMarks([
      ROWS[0]!,
      ROWS[1]!,
      { type: "user", itemId: "separator", createdAt: "t2.5", text: "继续" },
      ROWS[2]!,
      ROWS[4]!,
    ]);
    expect(marks[0]!.preview).toBe("帮我修一下登录页");
    expect(marks[1]!.preview).toContain("相关文件");
    expect(marks[3]!.preview).toContain("运行 1 条命令");
    expect(marks[4]!.preview).toBe("早期对话压缩");
  });

  it("does not put snapcompact HISTORY into the compact mark preview", () => {
    const marks = deriveMinimapMarks([{
      type: "compaction",
      item: {
        kind: "compaction",
        itemId: "cp-snap",
        parentId: null,
        createdAt: "t",
        summary: [
          "You are resuming a prior conversation. Its earlier turns were archived to reclaim context.",
          "",
          "HISTORY",
          "===================",
        ].join("\n"),
      },
    }]);
    expect(marks[0]!.preview.includes("You are resuming")).toBe(false);
    expect(marks[0]!.preview.includes("HISTORY")).toBe(false);
    expect(marks[0]!.preview.length).toBeLessThan(40);
  });
});

describe("activeMarkId", () => {
  const marks = [mark("early", "user"), mark("late", "error")];
  const fractions = { early: 0.1, late: 0.8 };

  it("滚动后根据内容视口中线更新活跃圆点", () => {
    expect(activeMarkId(marks, fractions, {
      scrollTop: 0,
      scrollHeight: 1000,
      scrollerHeight: 200,
      trackHeight: 500,
    })).toBe("early");
    expect(activeMarkId(marks, fractions, {
      scrollTop: 700,
      scrollHeight: 1000,
      scrollerHeight: 200,
      trackHeight: 500,
    })).toBe("late");
  });
});

describe("spaceMinimapMarks", () => {
  it("间隔足够的圆点全部保留", () => {
    const marks = [mark("m1", "user"), mark("m2", "assistant"), mark("m3", "user")];
    const placed = spaceMinimapMarks(marks, { m1: 0.1, m2: 0.3, m3: 0.5 });
    expect(placed.map((entry) => entry.itemId)).toEqual(["m1", "m2", "m3"]);
  });

  it("过近的圆点折叠为代表点，错误优先", () => {
    const marks = [mark("m1", "user"), mark("m2", "assistant"), mark("m3", "error"), mark("m4", "user")];
    const placed = spaceMinimapMarks(marks, { m1: 0.4, m2: 0.405, m3: 0.41, m4: 0.8 });
    expect(placed.map((entry) => entry.itemId)).toEqual(["m3", "m4"]);
  });

  it("无关键类型时取簇首", () => {
    const marks = [mark("m1", "assistant"), mark("m2", "assistant"), mark("m3", "user")];
    const placed = spaceMinimapMarks(marks, { m1: 0.2, m2: 0.205, m3: 0.6 });
    expect(placed.map((entry) => entry.itemId)).toEqual(["m1", "m3"]);
  });

  it("代表点只从当前簇内挑选，不会跨簇取用更早的错误点", () => {
    /* 簇内扫描曾用 entries.findIndex 从数组头部起扫，既是 O(n²)，也会在谓词
       写错时把前一个簇的点当成本簇代表。这里锁定「只看本簇」的语义。 */
    const marks = [mark("e1", "error"), mark("a1", "assistant"), mark("a2", "assistant")];
    const placed = spaceMinimapMarks(marks, { e1: 0.1, a1: 0.7, a2: 0.705 });
    expect(placed.map((entry) => entry.itemId)).toEqual(["e1", "a1"]);
  });

  it("在 2,000 个圆点上保持线性开销", () => {
    const marks = Array.from({ length: 2000 }, (_, index) => mark(`m${index}`, index % 97 === 0 ? "error" : "assistant"));
    const fractions: Record<string, number> = {};
    for (let index = 0; index < marks.length; index += 1) fractions[`m${index}`] = index / (marks.length - 1);
    const begun = performance.now();
    const placed = spaceMinimapMarks(marks, fractions);
    expect(performance.now() - begun).toBeLessThan(120);
    expect(placed.length).toBeLessThanOrEqual(Math.ceil(1 / 0.018) + 1);
  });
});

describe("pickNextMark", () => {
  const marks = [mark("u1", "user"), mark("a1", "assistant"), mark("u2", "user"), mark("e1", "error")];

  it("从活跃点向后查找", () => {
    expect(pickNextMark(marks, "a1", ["user"])?.itemId).toBe("u2");
    expect(pickNextMark(marks, null, ["error"])?.itemId).toBe("e1");
  });

  it("越过末尾回绕", () => {
    expect(pickNextMark(marks, "e1", ["user"])?.itemId).toBe("u1");
  });

  it("无匹配类型返回 null", () => {
    expect(pickNextMark([mark("a1", "assistant")], null, ["error"])).toBeNull();
  });
});

/** 挂载 minimap + 可滚动宿主；jsdom 布局为零，须在重渲染前手工注入几何。 */
function Harness({ rows }: { rows: readonly TimelineRow[] }) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  return (
    <div>
      <div
        data-testid="scroller"
        ref={(element) => {
          scrollerRef.current = element;
        }}
      >
        <div className="convo-doc">
          {rows.map((row) => {
            const itemId = timelineRowKey(row);
            return <div key={itemId} data-item-id={itemId} className="ev" />;
          })}
        </div>
      </div>
      <ConversationMinimap rows={rows} scrollerRef={scrollerRef} />
    </div>
  );
}

type Geometry = { scrollHeight: number; clientHeight: number; rowHeight: number };

function injectGeometry(container: HTMLElement, geometry: Geometry): void {
  const scroller = screen.getByTestId("scroller");
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => geometry.scrollHeight });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => geometry.clientHeight });
  Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  container.querySelectorAll<HTMLElement>("[data-item-id]").forEach((node, index) => {
    const top = index * geometry.rowHeight;
    node.getBoundingClientRect = () =>
      ({ top, bottom: top + geometry.rowHeight, left: 0, right: 0, height: geometry.rowHeight, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  });
}

function stubScrollerScroll(): ReturnType<typeof vi.fn> {
  const scroller = screen.getByTestId("scroller");
  const scrollTo = vi.fn((arg?: ScrollToOptions | number) => {
    const top = typeof arg === "number" ? arg : arg?.top;
    if (typeof top === "number") {
      Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: top });
    }
  });
  scroller.scrollTo = scrollTo as HTMLElement["scrollTo"];
  return scrollTo;
}

describe("ConversationMinimap 组件", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("渲染带类型的圆点按钮，点击跳转到对应行", () => {
    const view = render(<Harness rows={ROWS} />);
    injectGeometry(view.container, { scrollHeight: 500, clientHeight: 250, rowHeight: 100 });
    // 重渲染触发测量 effect（几何注入发生在首次挂载之后）
    view.rerender(<Harness rows={[...ROWS]} />);

    const userMark = screen.getByRole("button", { name: "#1 用户消息" });
    const assistantRunMark = screen.getByRole("button", { name: "#2 错误" });
    expect(assistantRunMark.className).toContain("error");

    const row = view.container.querySelector<HTMLElement>('[data-item-id="u1"]');
    expect(row).not.toBeNull();
    row!.scrollIntoView = vi.fn();
    const scrollTo = stubScrollerScroll();
    fireEvent.click(userMark);
    expect(row!.scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 0 });
    expect(row!.classList.contains("mm-flash")).toBe(true);
  });

  it("无溢出时隐藏视口条，有溢出时按比例定位", () => {
    const view = render(<Harness rows={ROWS} />);
    injectGeometry(view.container, { scrollHeight: 200, clientHeight: 300, rowHeight: 100 });
    view.rerender(<Harness rows={[...ROWS]} />);
    expect((view.container.querySelector("#mmViewport") as HTMLElement).style.display).toBe("none");

    cleanup();
    const second = render(<Harness rows={ROWS} />);
    injectGeometry(second.container, { scrollHeight: 500, clientHeight: 250, rowHeight: 100 });
    second.rerender(<Harness rows={[...ROWS]} />);
    const viewport = second.container.querySelector<HTMLElement>("#mmViewport");
    expect(viewport).not.toBeNull();
    expect(viewport!.style.display).not.toBe("none");
    expect(viewport!.style.height).toBe("18px");
  });

  it("筛选菜单：仅显示错误与关键节点，并支持跳到下一个错误", () => {
    const view = render(<Harness rows={ROWS} />);
    injectGeometry(view.container, { scrollHeight: 500, clientHeight: 250, rowHeight: 100 });
    view.rerender(<Harness rows={[...ROWS]} />);

    fireEvent.click(screen.getByRole("button", { name: "筛选事件" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "仅显示错误与关键节点" }));

    expect(screen.queryByRole("button", { name: "#1 用户消息" })).toBeNull();
    expect(screen.queryByRole("button", { name: "#2 助手回复" })).toBeNull();
    expect(screen.getByRole("button", { name: "#2 错误" })).toBeDefined();
    expect(screen.getByRole("button", { name: "#3 历史压缩" })).toBeDefined();

    const errorRow = view.container.querySelector<HTMLElement>('[data-item-id="a1"]');
    errorRow!.scrollIntoView = vi.fn();
    const scrollTo = stubScrollerScroll();
    // keyOnly 切换后菜单保持打开，直接跳转即可
    fireEvent.click(screen.getByRole("menuitem", { name: "跳到下一个错误" }));
    expect(errorRow!.scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 25 });
  });

  it("悬浮圆点显示简化预览", () => {
    const view = render(<Harness rows={ROWS} />);
    injectGeometry(view.container, { scrollHeight: 500, clientHeight: 250, rowHeight: 100 });
    view.rerender(<Harness rows={[...ROWS]} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "#1 用户消息" }));
    expect(screen.getByText("#01 · 用户消息")).toBeDefined();
    expect(screen.getByText("帮我修一下登录页")).toBeDefined();
  });

  it("视口条拖动按帧合并写入：rAF 前不写，一帧只写一次", async () => {
    // pointermove 以输入频率到达，曾按事件逐个「读 rect → 写 scrollTop → 读回」，
    // 流式期间等于按事件次数重复全量布局。这里钉住合并语义：两次 move 只落一次写，
    // 且写发生在 rAF；滑块位置由拖动几何直接写出。
    const view = render(<Harness rows={ROWS} />);
    injectGeometry(view.container, { scrollHeight: 1000, clientHeight: 200, rowHeight: 100 });
    view.rerender(<Harness rows={[...ROWS]} />);
    const scroller = screen.getByTestId("scroller");
    const track = view.container.querySelector<HTMLElement>("#mmTrack")!;
    const viewport = view.container.querySelector<HTMLElement>("#mmViewport")!;
    Object.defineProperty(track, "clientHeight", { configurable: true, get: () => 600 });
    track.getBoundingClientRect = () => ({ top: 100, bottom: 700, left: 0, right: 0, height: 600, width: 8, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(viewport, "offsetHeight", { configurable: true, get: () => 50 });
    viewport.getBoundingClientRect = () => ({ top: 200, bottom: 250, left: 0, right: 0, height: 50, width: 8, x: 0, y: 200, toJSON: () => ({}) }) as DOMRect;
    viewport.setPointerCapture = vi.fn();
    let writes = 0;
    let currentTop = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => currentTop,
      set: (value: number) => { writes += 1; currentTop = value; },
    });

    // 抓取偏移 25（clientY 225 − 视口条 top 200）。jsdom 的 fireEvent.pointer* 不携带
    // clientY，改派发带坐标的 MouseEvent（浏览器里 pointer 事件必有 clientY）。
    const pointer = (target: Element, type: string, clientY: number) => {
      target.dispatchEvent(new MouseEvent(type, { clientY, bubbles: true, cancelable: true }));
    };
    pointer(viewport, "pointerdown", 225);
    pointer(viewport, "pointermove", 325);
    pointer(viewport, "pointermove", 425);
    expect(writes).toBe(0);

    await act(async () => {
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    });
    expect(writes).toBe(1);
    // top = 425 − 25 − 100 = 300；sliderSpan = 600 − 52 − 50 = 498；maxScroll = 800
    expect(viewport.style.top).toBe("300px");
    expect(currentTop).toBeCloseTo((300 / 498) * 800, 0);

    pointer(viewport, "pointerup", 425);
    expect(viewport.style.display).not.toBe("none");
  });

  it("连续高度变化只合成一次尾随重测", async () => {
    // 工具卡展开/收起的每一帧都在改 scrollHeight，跳过闸门因此每帧都失效：那意味
    // 着每帧一次全子树 querySelectorAll + 逐节点 rect + 圆点全量重渲染。
    vi.useFakeTimers();
    try {
      const view = render(<Harness rows={ROWS} />);
      injectGeometry(view.container, { scrollHeight: 500, clientHeight: 250, rowHeight: 100 });
      view.rerender(<Harness rows={[...ROWS]} />);
      const mark = () => screen.getByRole("button", { name: "#1 用户消息" }).style.top;
      const measured = mark();
      expect(measured).not.toBe("");

      injectGeometry(view.container, { scrollHeight: 1000, clientHeight: 250, rowHeight: 100 });
      view.rerender(<Harness rows={[...ROWS]} />);
      expect(mark()).toBe(measured);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(mark()).not.toBe(measured);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scrollOffsetToCenter", () => {
  it("靠下的短消息夹取到 maxScroll，不超出对话 scroller", () => {
    // 数值来自 debug-b21151 第一次点击 before-scrollIntoView。
    const scroller = {
      scrollTop: 1935.3333740234375,
      clientHeight: 564,
      scrollHeight: 2879,
      getBoundingClientRect: () => ({ top: 80 }),
    };
    const node = { getBoundingClientRect: () => ({ top: 802, height: 79 }) };
    expect(scrollOffsetToCenter(scroller, node)).toBe(2315);
  });
});
