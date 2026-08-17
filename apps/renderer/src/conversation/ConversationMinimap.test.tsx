import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineRow } from "./conversationViewModel";
import {
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
  it("按行类型派生圆点并编号", () => {
    const marks = deriveMinimapMarks(ROWS);
    expect(marks.map((entry) => entry.type)).toEqual(["user", "assistant", "bash", "error", "compact"]);
    expect(marks.map((entry) => entry.turn)).toEqual([1, 2, 3, 4, 5]);
  });

  it("预览文本取用户原文 / 工具摘要 / 压缩摘要", () => {
    const marks = deriveMinimapMarks(ROWS);
    expect(marks[0]!.preview).toBe("帮我修一下登录页");
    expect(marks[1]!.preview).toContain("相关文件");
    expect(marks[2]!.preview).toContain("运行 1 条命令");
    expect(marks[4]!.preview).toBe("早期对话压缩");
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
            const itemId = row.type === "compaction" || row.type === "resetBoundary" ? row.item.itemId : row.itemId;
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
    const bashMark = screen.getByRole("button", { name: "#3 命令执行" });
    expect(bashMark.className).toContain("bash");

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
    expect(screen.getByRole("button", { name: "#4 错误" })).toBeDefined();
    expect(screen.getByRole("button", { name: "#5 历史压缩" })).toBeDefined();

    const errorRow = view.container.querySelector<HTMLElement>('[data-item-id="a3"]');
    errorRow!.scrollIntoView = vi.fn();
    const scrollTo = stubScrollerScroll();
    // keyOnly 切换后菜单保持打开，直接跳转即可
    fireEvent.click(screen.getByRole("menuitem", { name: "跳到下一个错误" }));
    expect(errorRow!.scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 225 });
  });

  it("悬浮圆点显示简化预览", () => {
    const view = render(<Harness rows={ROWS} />);
    injectGeometry(view.container, { scrollHeight: 500, clientHeight: 250, rowHeight: 100 });
    view.rerender(<Harness rows={[...ROWS]} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "#1 用户消息" }));
    expect(screen.getByText("#01 · 用户消息")).toBeDefined();
    expect(screen.getByText("帮我修一下登录页")).toBeDefined();
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
