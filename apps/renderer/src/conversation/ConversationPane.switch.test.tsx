import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEpoch, SessionId } from "@omp-studio/studio-protocol";
import { ConversationPane } from "./ConversationPane";
import { SWITCH_LEAVE_MS, SWITCH_REVEAL_MS, SWITCH_SETTLE_FRAMES } from "./conversationSwitchPhase";
import type { ConversationSnapshot } from "./conversationEngine";
import { resetConversation, type HydrateStatus, type TimelineRow } from "./conversationViewModel";

function userRow(text: string): TimelineRow {
  return { type: "user", itemId: `${text}-item`, createdAt: "2026-08-29T00:00:00.000Z", text };
}

/** 切换会话时 engine 按新 identity 重建，第一份快照必然是零行的 loading。 */
function snapshot(sessionId: string, hydrateStatus: HydrateStatus, rows: readonly TimelineRow[]): ConversationSnapshot {
  const identity = { sessionId: sessionId as SessionId, runtimeEpoch: 1 as RuntimeEpoch };
  return { state: resetConversation(0, identity, hydrateStatus), rows, demo: false, loadingOlder: false, identityKey: `${sessionId}:1:` };
}

function pane(snap: ConversationSnapshot) {
  return <ConversationPane snapshot={snap} onLoadOlder={() => {}} />;
}

function settleLayout(): void {
  act(() => { vi.advanceTimersByTime(SWITCH_SETTLE_FRAMES * 20); });
}

/** 首屏的第一段可画内容本身也走一次淡入（挂载时没有上一屏可淡出）。 */
function mounted(rows: readonly TimelineRow[]) {
  const view = render(pane(snapshot("a", "ready", rows)));
  expect(view.container.querySelector(".convo-body")?.getAttribute("data-phase")).toBe("settling");
  expect(view.container.querySelector(".convo-body")?.textContent).toContain((rows[0] as { text?: string } | undefined)?.text ?? "");
  settleLayout();
  expect(view.container.querySelector(".convo-body")?.getAttribute("data-phase")).toBe("revealing");
  act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
  expect(view.container.querySelector(".convo-body")?.getAttribute("data-phase")).toBe("idle");
  return view;
}

describe("ConversationPane session switch", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cross-dissolves through a switch instead of hard-cutting to a placeholder", () => {
    vi.useFakeTimers();
    const view = mounted([userRow("从前的会话")]);
    const phase = () => view.container.querySelector(".convo-body")?.getAttribute("data-phase");
    const veil = () => view.container.querySelector(".convo-veil");
    expect(view.container.textContent).toContain("从前的会话");

    act(() => { view.rerender(pane(snapshot("b", "loading", []))); });
    // 上一段 transcript 原样留在屏上淡出——既不是空白，也不是"正在准备对话"占位。
    expect(phase()).toBe("leaving");
    expect(view.container.textContent).toContain("从前的会话");
    expect(view.container.textContent).not.toContain("正在准备对话");
    expect(veil()).toBeNull();

    act(() => { vi.advanceTimersByTime(SWITCH_LEAVE_MS); });
    expect(phase()).toBe("waiting");
    expect(veil()).not.toBeNull();
    expect(view.container.textContent).not.toContain("从前的会话");
    expect(view.container.querySelector("[aria-busy]")).not.toBeNull();

    // waiting 没有时限：这是"加载时间长短都能适配"的全部机制。
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(phase()).toBe("waiting");
    expect(veil()).not.toBeNull();

    act(() => { view.rerender(pane(snapshot("b", "ready", [userRow("新的会话")]))); });
    expect(phase()).toBe("settling");
    expect(veil()?.hasAttribute("data-leaving")).toBe(false);
    expect(view.container.textContent).toContain("新的会话");
    settleLayout();
    expect(phase()).toBe("revealing");
    expect(veil()?.getAttribute("data-leaving")).toBe("true");

    act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
    expect(phase()).toBe("idle");
    expect(veil()).toBeNull();
    expect(view.container.querySelector("[aria-busy]")).toBeNull();
  });

  it("skips the skeleton entirely when the read lands inside the fade-out", () => {
    vi.useFakeTimers();
    const view = mounted([userRow("从前的会话")]);
    const phase = () => view.container.querySelector(".convo-body")?.getAttribute("data-phase");

    act(() => { view.rerender(pane(snapshot("b", "loading", []))); });
    act(() => { view.rerender(pane(snapshot("b", "ready", [userRow("新的会话")]))); });
    // 还在淡出窗口内：让它跑完，然后直接淡入，骨架一帧都不出现。
    expect(phase()).toBe("leaving");
    expect(view.container.querySelector(".convo-veil")).toBeNull();
    expect(view.container.textContent).toContain("从前的会话");
    expect(view.container.textContent).not.toContain("新的会话");

    act(() => { vi.advanceTimersByTime(SWITCH_LEAVE_MS); });
    expect(phase()).toBe("settling");
    expect(view.container.querySelector(".convo-veil")).toBeNull();
    expect(view.container.textContent).toContain("新的会话");
    settleLayout();
    expect(phase()).toBe("revealing");
  });

  it("holds one skeleton through a burst of switches", () => {
    vi.useFakeTimers();
    const view = mounted([userRow("从前的会话")]);
    act(() => { view.rerender(pane(snapshot("b", "loading", []))); });
    act(() => { vi.advanceTimersByTime(SWITCH_LEAVE_MS); });
    const first = view.container.querySelector(".convo-veil");
    for (const sessionId of ["c", "d", "e"]) {
      act(() => { view.rerender(pane(snapshot(sessionId, "loading", []))); });
      expect(view.container.querySelector(".convo-body")?.getAttribute("data-phase")).toBe("waiting");
    }
    // 同一个骨架 DOM 节点全程没被重建，所以 shimmer 不会跟着每次点击重新起跳。
    expect(view.container.querySelector(".convo-veil")).toBe(first);
  });

  it("covers a same-session reload that clears its rows", () => {
    vi.useFakeTimers();
    const view = mounted([userRow("从前的会话")]);
    act(() => { view.rerender(pane(snapshot("a", "loading", []))); });
    expect(view.container.querySelector(".convo-body")?.getAttribute("data-phase")).toBe("leaving");
    expect(view.container.textContent).toContain("从前的会话");
    act(() => { vi.advanceTimersByTime(SWITCH_LEAVE_MS); });
    expect(view.container.querySelector(".convo-veil")).not.toBeNull();
  });

  it("never renders an empty body when content is pulled mid-reveal", () => {
    vi.useFakeTimers();
    const view = render(pane(snapshot("a", "ready", [userRow("从前的会话")])));
    settleLayout();
    act(() => { vi.advanceTimersByTime(1); });
    // 淡入还没跑完就被 reload 清空：接管前这里渲染的是 null，也就是一片真空白。
    act(() => { view.rerender(pane(snapshot("a", "loading", []))); });
    expect(view.container.querySelector(".convo-body")?.getAttribute("data-phase")).toBe("leaving");
    expect(view.container.textContent).toContain("从前的会话");
  });

  it("drops the fade-out under reduced motion but still covers the gap", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    const view = render(pane(snapshot("a", "ready", [userRow("从前的会话")])));
    settleLayout();
    act(() => { vi.advanceTimersByTime(1); });
    act(() => { view.rerender(pane(snapshot("b", "loading", []))); });
    expect(view.container.querySelector(".convo-body")?.getAttribute("data-phase")).toBe("waiting");
    expect(view.container.querySelector(".convo-veil")).not.toBeNull();
    act(() => { view.rerender(pane(snapshot("b", "ready", [userRow("新的会话")]))); });
    settleLayout();
    act(() => { vi.advanceTimersByTime(1); });
    expect(view.container.querySelector(".convo-body")?.getAttribute("data-phase")).toBe("idle");
    expect(view.container.textContent).toContain("新的会话");
  });

  it("keeps the welcome mounted and quiet across the new-session handoff", () => {
    vi.useFakeTimers();
    const welcome = <div className="ce-stub">下午好，Studio</div>;
    /** identity 为 null（后台 session.create 进行中）的快照。 */
    const nullSnapshot = (hydrateStatus: HydrateStatus): ConversationSnapshot => ({
      state: resetConversation(0, null, hydrateStatus),
      rows: [],
      demo: false,
      loadingOlder: false,
      identityKey: ":",
    });
    const welcomePane = (snap: ConversationSnapshot) => (
      <ConversationPane snapshot={snap} welcome={welcome} onLoadOlder={() => {}} />
    );

    // 创建中：identity 为 null，欢迎页完成首次入场。
    const view = render(welcomePane(nullSnapshot("unavailable")));
    settleLayout();
    act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
    const phase = () => view.container.querySelector(".convo-body")?.getAttribute("data-phase");
    const welcomeEl = () => view.container.querySelector(".ce-stub");
    expect(phase()).toBe("idle");
    const firstWelcome = welcomeEl();
    expect(firstWelcome).not.toBeNull();

    // session.create 回执落地：identity null → 新会话，仍是欢迎页——不得重跑淡出/淡入。
    act(() => { view.rerender(welcomePane(snapshot("b", "idle", []))); });
    expect(phase()).toBe("idle");
    expect(welcomeEl()).toBe(firstWelcome);

    // 新 engine 的 hydrate 空窗（loading、零行）：欢迎页照旧，不出骨架。
    act(() => { view.rerender(welcomePane(snapshot("b", "loading", []))); });
    expect(phase()).toBe("idle");
    expect(welcomeEl()).toBe(firstWelcome);
    expect(view.container.querySelector(".convo-veil")).toBeNull();

    // 第一条消息到达：欢迎页让位给 transcript，不额外加过场延迟。
    act(() => { view.rerender(welcomePane(snapshot("b", "ready", [userRow("第一条消息")]))); });
    expect(phase()).toBe("idle");
    expect(view.container.textContent).toContain("第一条消息");
    expect(welcomeEl()).toBeNull();
  });

  it("plays the choreography when toggling between a transcript and the welcome", () => {
    vi.useFakeTimers();
    const welcome = <div className="ce-stub">下午好，Studio</div>;
    const phase = (view: ReturnType<typeof render>) =>
      view.container.querySelector(".convo-body")?.getAttribute("data-phase");

    // 普通对话 A 可见。
    const view = render(pane(snapshot("a", "ready", [userRow("会话A消息")])));
    settleLayout();
    act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
    expect(phase(view)).toBe("idle");

    // 切到新建对话：identity → null，欢迎页接手，A 原地淡出。
    const nullSnapshot = (): ConversationSnapshot => ({
      state: resetConversation(0, null, "unavailable"),
      rows: [],
      demo: false,
      loadingOlder: false,
      identityKey: ":",
    });
    act(() => {
      view.rerender(<ConversationPane snapshot={nullSnapshot()} welcome={welcome} forceWelcome onLoadOlder={() => {}} />);
    });
    expect(phase(view)).toBe("leaving");
    expect(view.container.textContent).toContain("会话A消息");
    act(() => { vi.advanceTimersByTime(SWITCH_LEAVE_MS); });
    expect(phase(view)).toBe("settling");
    settleLayout();
    expect(phase(view)).toBe("revealing");
    act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
    expect(phase(view)).toBe("idle");
    expect(view.container.querySelector(".ce-stub")).not.toBeNull();

    // 切回普通对话 B（选中态：欢迎 prop 撤下）：欢迎页淡出 → 骨架 → B 淡入。
    act(() => { view.rerender(pane(snapshot("b", "loading", []))); });
    expect(phase(view)).toBe("leaving");
    expect(view.container.querySelector(".ce-stub")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(SWITCH_LEAVE_MS); });
    expect(phase(view)).toBe("waiting");
    expect(view.container.querySelector(".convo-veil")).not.toBeNull();
    act(() => { view.rerender(pane(snapshot("b", "ready", [userRow("会话B消息")]))); });
    expect(phase(view)).toBe("settling");
    settleLayout();
    expect(phase(view)).toBe("revealing");
    act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
    expect(phase(view)).toBe("idle");
    expect(view.container.textContent).toContain("会话B消息");
  });

  /** 给 pane 内部的 `.convo-scroll` 装上可控滚动度量（jsdom 不实现布局）。 */
  function armScroller(view: ReturnType<typeof render>, initialTop = 0): { scrollTop: number } {
    const el = view.container.querySelector<HTMLElement>(".convo-scroll");
    if (!(el instanceof HTMLElement)) throw new Error("scroller not mounted");
    const state = { scrollTop: initialTop };
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => state.scrollTop, set: (v: number) => { state.scrollTop = v; } });
    return state;
  }

  it("fades the welcome at its scroll position and lands the transcript at the bottom", () => {
    vi.useFakeTimers();
    const welcome = <div className="ce-stub">下午好，Studio</div>;
    const nullSnapshot = (): ConversationSnapshot => ({
      state: resetConversation(0, null, "unavailable"),
      rows: [], demo: false, loadingOlder: false, identityKey: ":",
    });
    const phase = (view: ReturnType<typeof render>) =>
      view.container.querySelector(".convo-body")?.getAttribute("data-phase");

    const view = render(<ConversationPane snapshot={nullSnapshot()} welcome={welcome} forceWelcome onLoadOlder={() => {}} />);
    settleLayout();
    act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
    expect(phase(view)).toBe("idle");
    const scroll = armScroller(view);
    // 用户把欢迎页滚到中间。
    scroll.scrollTop = 500;

    // 切到普通对话：淡出期间欢迎页停在 500，不被 stickToTail 拖到底部。
    act(() => { view.rerender(pane(snapshot("b", "loading", []))); });
    expect(phase(view)).toBe("leaving");
    expect(scroll.scrollTop).toBe(500);
    act(() => { vi.advanceTimersByTime(SWITCH_LEAVE_MS); });
    expect(phase(view)).toBe("waiting");
    act(() => { view.rerender(pane(snapshot("b", "ready", [userRow("会话B消息")]))); });
    settleLayout();
    act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
    expect(phase(view)).toBe("idle");
    // 新 transcript 在自己该在的位置：底部。
    expect(scroll.scrollTop).toBe(2000);
  });

  it("reveals the welcome at its top when leaving a bottom-pinned transcript", () => {
    vi.useFakeTimers();
    const welcome = <div className="ce-stub">下午好，Studio</div>;
    const nullSnapshot = (): ConversationSnapshot => ({
      state: resetConversation(0, null, "unavailable"),
      rows: [], demo: false, loadingOlder: false, identityKey: ":",
    });
    const phase = (view: ReturnType<typeof render>) =>
      view.container.querySelector(".convo-body")?.getAttribute("data-phase");

    const view = render(pane(snapshot("a", "ready", [userRow("会话A消息")])));
    settleLayout();
    act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
    expect(phase(view)).toBe("idle");
    // transcript 开场贴底（jsdom 不跑布局，贴底发生在 arm 之前，这里直接给定底部）。
    const scroll = armScroller(view, 2000);
    expect(scroll.scrollTop).toBe(2000);

    // 切到新建对话：旧 transcript 停在底部原地淡出，滚动位置不动。
    act(() => { view.rerender(<ConversationPane snapshot={nullSnapshot()} welcome={welcome} forceWelcome onLoadOlder={() => {}} />); });
    expect(phase(view)).toBe("leaving");
    expect(scroll.scrollTop).toBe(2000);
    act(() => { vi.advanceTimersByTime(SWITCH_LEAVE_MS); });
    // leaving 结束的那次提交里 pin 翻成 top：滚动归零，欢迎页在自己的顶部淡入。
    // 欢迎页可画，不经过骨架，直接 settling。
    expect(phase(view)).toBe("settling");
    expect(scroll.scrollTop).toBe(0);
    settleLayout();
    act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
    expect(phase(view)).toBe("idle");
    expect(view.container.querySelector(".ce-stub")).not.toBeNull();
    expect(scroll.scrollTop).toBe(0);
  });

  it("reports the on-screen welcome surface so the shell layout class never flips early", () => {
    vi.useFakeTimers();
    const welcome = <div className="ce-stub">下午好，Studio</div>;
    const nullSnapshot = (): ConversationSnapshot => ({
      state: resetConversation(0, null, "unavailable"),
      rows: [], demo: false, loadingOlder: false, identityKey: ":",
    });
    const phase = (view: ReturnType<typeof render>) =>
      view.container.querySelector(".convo-body")?.getAttribute("data-phase");
    const onSurfaceWelcomeChange = vi.fn();

    const view = render(
      <ConversationPane snapshot={nullSnapshot()} welcome={welcome} forceWelcome onSurfaceWelcomeChange={onSurfaceWelcomeChange} onLoadOlder={() => {}} />,
    );
    settleLayout();
    act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
    expect(phase(view)).toBe("idle");
    expect(onSurfaceWelcomeChange).toHaveBeenLastCalledWith(true);

    // 切到普通对话：淡出期间仍是在屏的欢迎面——壳层不许提前撤下 is-empty。
    let calls = onSurfaceWelcomeChange.mock.calls.length;
    act(() => {
      view.rerender(<ConversationPane snapshot={snapshot("b", "loading", [])} onSurfaceWelcomeChange={onSurfaceWelcomeChange} onLoadOlder={() => {}} />);
    });
    expect(phase(view)).toBe("leaving");
    expect(onSurfaceWelcomeChange.mock.calls.length).toBe(calls);
    act(() => { vi.advanceTimersByTime(SWITCH_LEAVE_MS); });
    // leaving 结束、新面隐身挂载后才翻 false。
    expect(phase(view)).toBe("waiting");
    expect(onSurfaceWelcomeChange).toHaveBeenLastCalledWith(false);
    // 让 B 真正画出来，才有下一方向可淡出的内容。
    act(() => { view.rerender(<ConversationPane snapshot={snapshot("b", "ready", [userRow("会话B消息")])} onSurfaceWelcomeChange={onSurfaceWelcomeChange} onLoadOlder={() => {}} />); });
    settleLayout();
    act(() => { vi.advanceTimersByTime(SWITCH_REVEAL_MS); });
    expect(phase(view)).toBe("idle");

    // 反向：对话 → 欢迎页，淡出期间不上报 true，settling 才翻。
    calls = onSurfaceWelcomeChange.mock.calls.length;
    act(() => {
      view.rerender(
        <ConversationPane snapshot={nullSnapshot()} welcome={welcome} forceWelcome onSurfaceWelcomeChange={onSurfaceWelcomeChange} onLoadOlder={() => {}} />,
      );
    });
    expect(phase(view)).toBe("leaving");
    expect(onSurfaceWelcomeChange.mock.calls.length).toBe(calls);
    act(() => { vi.advanceTimersByTime(SWITCH_LEAVE_MS); });
    expect(phase(view)).toBe("settling");
    expect(onSurfaceWelcomeChange).toHaveBeenLastCalledWith(true);
  });
});
