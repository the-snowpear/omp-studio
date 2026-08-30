/**
 * 流式渲染性能 harness（`scripts/streaming-perf-gate.mjs` 驱动，不属于产品代码）。
 *
 * 这里挂的是真实的 ConversationPane + ConversationMinimap，共用一个 scroller，喂给它的
 * 是真实的 ConversationStore 与真实的 runtime 事件序列。jsdom 里的单测只能测到 React
 * 的 commit 时长，看不到 CSS 布局、ResizeObserver、滚动写入与合成 —— 而流式掉帧恰好
 * 出在那一层，所以门禁必须在真 Chromium 里跑。
 *
 * 页面把控制面暴露在 `window.ompPerf`：
 *   await ompPerf.reset({ turns, toolsPerTurn, outputLines })
 *   await ompPerf.run({ frames, charsPerFrame, toolLinesPerFrame, toggleTailCard })
 */
import { useMemo, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type {
  ConversationMessageItem,
  ConversationRuntimeEvent,
  OpaqueCursor,
  SessionId,
} from "@omp-studio/client-contract";
import { ConversationPane } from "./conversation/ConversationPane";
import { ConversationMinimap } from "./conversation/ConversationMinimap";
import { ConversationStore } from "./conversation/conversationStore";
import type { ConversationSnapshot } from "./conversation/conversationEngine";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/sidebar.css";
import "./styles/workbench.css";
import "./styles/pages.css";
import "./App.css";

const SESSION = "perf-session" as SessionId;
const TURN = "perf-turn";
const LIVE_MESSAGE = "perf-live-message";
const LIVE_TOOL = "perf-live-tool";

export type PerfSeed = { readonly turns: number; readonly toolsPerTurn: number; readonly outputLines: number };
export type PerfRunOptions = {
  readonly frames: number;
  readonly charsPerFrame: number;
  readonly toolLinesPerFrame: number;
  /** 每隔多少帧折叠/展开一次尾部工具卡（0 = 不动），把展开动画压进流式帧里。 */
  readonly toggleEveryFrames: number;
};
export type PerfResult = {
  readonly frames: number;
  readonly median: number;
  readonly p95: number;
  readonly worst: number;
  /** 间隔超过 32ms 的帧数：60Hz 下至少漏掉一帧（稳定 30fps 会把这个数拉满）。 */
  readonly dropped: number;
  /** 间隔超过 48ms 的帧数：连漏两帧以上，观感上从「稳定但偏慢」变成「卡顿」。 */
  readonly stalls: number;
  readonly longTaskMs: number;
  /** 实际点到的折叠/展开次数；为 0 说明场景没生效。 */
  readonly toggles: number;
  readonly rows: number;
};
export type SwitchPerfResult = {
  readonly newContentMountedDuringLeave: boolean;
  readonly sawSettling: boolean;
  readonly settlingMaxOpacity: number;
  readonly firstVisibleDistanceFromTail: number | null;
  readonly visiblePositionJumps: number;
  readonly maxVisibleShiftPx: number;
};

const PROSE = [
  "这一段是模型正文，用来让 Markdown 分块与高亮走真实路径。",
  "它需要足够长，才能让「每帧从头扫描」和「只扫新增尾部」的差别显现出来。",
  "",
  "- 列表项一",
  "- 列表项二",
  "",
  "```ts",
  "const value = compute(input);",
  "```",
  "",
].join("\n");

function line(index: number): string {
  return `[build] step ${index} finished in ${index * 3}ms — src/module/file${index}.ts`;
}

function historyItems(seed: PerfSeed, prefix = ""): readonly ConversationMessageItem[] {
  const items: ConversationMessageItem[] = [];
  const output = Array.from({ length: seed.outputLines }, (_, index) => line(index)).join("\n");
  for (let turn = 0; turn < seed.turns; turn += 1) {
    items.push({
      kind: "message",
      itemId: `${prefix}u${turn}`,
      parentId: null,
      createdAt: `2026-08-30T00:00:${String(turn).padStart(2, "0")}.000Z`,
      role: "user",
      content: [{ type: "text", text: `第 ${turn} 个请求` }],
    });
    const content: ConversationMessageItem["content"][number][] = [{ type: "text", text: PROSE }];
    for (let tool = 0; tool < seed.toolsPerTurn; tool += 1) {
      content.push({ type: "toolCall", toolCallId: `${turn}-t${tool}`, toolName: "bash", arguments: { command: `npm test -- ${tool}` } } as never);
      content.push({ type: "toolResult", toolCallId: `${turn}-t${tool}`, toolName: "bash", isError: false, output } as never);
    }
    items.push({
      kind: "message",
      itemId: `${prefix}a${turn}`,
      parentId: null,
      createdAt: `2026-08-30T00:01:${String(turn).padStart(2, "0")}.000Z`,
      role: "assistant",
      content,
    });
  }
  return items;
}

function frame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index]!;
}

class PerfHarness {
  private store: ConversationStore | null = null;
  private seq = 0;
  private sessionId: SessionId = SESSION;
  private switchCount = 0;
  private readonly listeners = new Set<() => void>();

  getStore(): ConversationStore | null {
    return this.store;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private announce(): void {
    for (const listener of this.listeners) listener();
  }

  /** 重建 store，灌入历史，并开启一个仍在产出的回合。 */
  async reset(seed: PerfSeed): Promise<void> {
    this.store?.dispose();
    this.seq = 0;
    this.sessionId = SESSION;
    const store = new ConversationStore({ target: { sessionId: this.sessionId }, identity: { sessionId: this.sessionId }, generation: 1 });
    this.seed(store, seed);
    this.store = store;
    this.announce();
    await frame();
    await frame();
    await frame();
  }

  private seed(store: ConversationStore, seed: PerfSeed, prefix = ""): void {
    store.hydrate({ items: historyItems(seed, prefix), headCursor: "head" as OpaqueCursor, hasMoreBefore: false });
    this.push(store, { kind: "conversation.message.started", sessionId: this.sessionId, turnId: TURN, messageId: LIVE_MESSAGE, role: "assistant", createdAt: "2026-08-30T00:02:00.000Z" });
    this.push(store, { kind: "conversation.message.delta", sessionId: this.sessionId, turnId: TURN, messageId: LIVE_MESSAGE, blockId: "b0", blockType: "text", delta: PROSE });
    this.push(store, { kind: "conversation.tool.started", sessionId: this.sessionId, turnId: TURN, messageId: LIVE_MESSAGE, toolCallId: LIVE_TOOL, toolName: "bash", startedAt: "2026-08-30T00:02:01.000Z", arguments: { command: "npm run build" } });
    this.push(store, { kind: "conversation.tool.updated", sessionId: this.sessionId, turnId: TURN, toolCallId: LIVE_TOOL, updateMode: "replace", output: Array.from({ length: seed.outputLines }, (_, index) => line(index)).join("\n") });
  }

  /** 先发布新 identity 的空 loading store，再在淡出窗口内灌入真实内容。 */
  async switchSession(seed: PerfSeed): Promise<string> {
    const previous = this.store;
    this.seq = 0;
    this.switchCount += 1;
    const prefix = `switch-${this.switchCount}-`;
    this.sessionId = `perf-switch-${this.switchCount}` as SessionId;
    const store = new ConversationStore({ target: { sessionId: this.sessionId }, identity: { sessionId: this.sessionId }, generation: this.switchCount + 1 });
    this.store = store;
    this.announce();
    previous?.dispose();
    await frame();
    await frame();
    this.seed(store, seed, prefix);
    await frame();
    return prefix;
  }

  private push(store: ConversationStore, event: ConversationRuntimeEvent): void {
    this.seq += 1;
    store.applyEvent(event, this.seq);
  }

  /** 按帧推进流式产出，量的是 rAF 到 rAF 的真实间隔（含布局与绘制）。 */
  async run(options: PerfRunOptions): Promise<PerfResult> {
    const store = this.store;
    if (store === null) throw new Error("call reset() first");
    let longTaskMs = 0;
    const observer = typeof PerformanceObserver === "function"
      ? new PerformanceObserver((list) => { for (const entry of list.getEntries()) longTaskMs += entry.duration; })
      : null;
    try { observer?.observe({ entryTypes: ["longtask"] }); } catch { /* 不支持就只看帧间隔 */ }
    const intervals: number[] = [];
    let toggles = 0;
    let previous = await frame();
    for (let index = 0; index < options.frames; index += 1) {
      const chunk = PROSE.slice(0, options.charsPerFrame);
      this.push(store, { kind: "conversation.message.delta", sessionId: this.sessionId, turnId: TURN, messageId: LIVE_MESSAGE, blockId: "b0", blockType: "text", delta: chunk });
      if (options.toolLinesPerFrame > 0) {
        const appended = Array.from({ length: options.toolLinesPerFrame }, (_, offset) => line(index * options.toolLinesPerFrame + offset)).join("\n");
        this.push(store, { kind: "conversation.tool.updated", sessionId: this.sessionId, turnId: TURN, toolCallId: LIVE_TOOL, updateMode: "append", output: `\n${appended}` });
      }
      if (options.toggleEveryFrames > 0 && index % options.toggleEveryFrames === 0 && toggleTailCard()) toggles += 1;
      const now = await frame();
      intervals.push(now - previous);
      previous = now;
    }
    observer?.disconnect();
    const sorted = [...intervals].sort((left, right) => left - right);
    return {
      frames: intervals.length,
      median: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      worst: sorted[sorted.length - 1] ?? 0,
      dropped: intervals.filter((value) => value > 32).length,
      stalls: intervals.filter((value) => value > 48).length,
      longTaskMs,
      toggles,
      rows: store.getSnapshot().rows.length,
    };
  }
}

/** 折叠/展开时间线里最后一张工具卡：真实点击，走真实的 CSS 过渡。 */
function toggleTailCard(): boolean {
  const rows = document.querySelectorAll<HTMLElement>(".tl-item .tl-row");
  const tail = rows[rows.length - 1];
  if (tail === undefined) return false;
  tail.click();
  return true;
}

/**
 * 工具卡折叠过渡里真正参与的属性，流式与静止两种状态各读一次。
 *
 * 这条是断言而不是测时：一帧的布局时间受历史长度、卡片开合、GC 影响，把「高度过渡有
 * 没有」埋在毫秒里读不出来。而 `transition-property` 的解析结果是确定值，且只有真
 * Chromium 会走完整的层叠 —— 正是这条门禁存在的理由。流式与静止必须一致：动画只在
 * 渲染层按「卡片是否仍在运行」取舍（见 BatchChain），CSS 不再按整屏流式态剥离过渡。
 */
function cardTransitionContract(): { readonly streaming: string; readonly idle: string } {
  const scroller = document.querySelector<HTMLElement>(".convo-scroll");
  const card = document.querySelector<HTMLElement>(".tl-item .tl-card");
  if (scroller === null || card === null) throw new Error("没有挂载中的工具卡可读");
  const previous = scroller.getAttribute("data-live-stream");
  scroller.setAttribute("data-live-stream", "1");
  const streaming = getComputedStyle(card).transitionProperty;
  scroller.removeAttribute("data-live-stream");
  const idle = getComputedStyle(card).transitionProperty;
  if (previous !== null) scroller.setAttribute("data-live-stream", previous);
  return { streaming, idle };
}

/** 真 Chromium 下验证新会话只有在虚拟列表测高并贴底后才变为可见。 */
async function sessionSwitchContract(): Promise<SwitchPerfResult> {
  const prefix = await harness.switchSession({ turns: 24, toolsPerTurn: 2, outputLines: 400 });
  const body = document.querySelector<HTMLElement>(".convo-body");
  const scroller = document.querySelector<HTMLElement>(".convo-scroll");
  if (body === null || scroller === null) throw new Error("会话切换探针没有找到 transcript");
  const newContentMountedDuringLeave = body.dataset.phase === "leaving"
    && body.querySelector(`[data-item-id^="${prefix}"]`) !== null;
  let sawSettling = false;
  let settlingMaxOpacity = 0;
  let firstVisibleDistanceFromTail: number | null = null;
  let visiblePositionJumps = 0;
  let maxVisibleShiftPx = 0;
  let previous: { readonly index: string; readonly top: number; readonly scrollTop: number } | null = null;
  let visibleSamples = 0;
  for (let tick = 0; tick < 70; tick += 1) {
    await frame();
    const phase = body.dataset.phase ?? "";
    const opacity = Number.parseFloat(getComputedStyle(body).opacity || "0");
    if (phase === "settling") {
      sawSettling = true;
      settlingMaxOpacity = Math.max(settlingMaxOpacity, opacity);
    }
    if ((phase === "revealing" || phase === "idle") && opacity > 0.01) {
      visibleSamples += 1;
      if (firstVisibleDistanceFromTail === null) {
        firstVisibleDistanceFromTail = Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
      }
      const mounted = Array.from(body.querySelectorAll<HTMLElement>(".convo-virtual-row")).at(-1);
      if (mounted !== undefined) {
        const current = {
          index: mounted.dataset.index ?? "",
          top: mounted.getBoundingClientRect().top,
          scrollTop: scroller.scrollTop,
        };
        if (previous !== null && previous.index === current.index) {
          const shift = Math.max(Math.abs(current.top - previous.top), Math.abs(current.scrollTop - previous.scrollTop));
          maxVisibleShiftPx = Math.max(maxVisibleShiftPx, shift);
          if (shift > 1) visiblePositionJumps += 1;
        }
        previous = current;
      }
      if (phase === "idle" && visibleSamples >= 5) break;
    }
  }
  return {
    newContentMountedDuringLeave,
    sawSettling,
    settlingMaxOpacity,
    firstVisibleDistanceFromTail,
    visiblePositionJumps,
    maxVisibleShiftPx,
  };
}

const harness = new PerfHarness();

function HarnessView() {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const store = useSyncExternalStore(harness.subscribe, harness.getStore.bind(harness));
  const storeSnapshot = useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.getSnapshot ?? (() => null),
    store?.getSnapshot ?? (() => null),
  );
  const snapshot = useMemo<ConversationSnapshot | undefined>(
    () => storeSnapshot === null ? undefined : {
      ...storeSnapshot,
      demo: false,
      loadingOlder: false,
      identityKey: `${storeSnapshot.state.identity?.sessionId ?? ""}:${storeSnapshot.state.generation}:`,
    },
    [storeSnapshot],
  );
  return (
    <div className="app-body" style={{ display: "flex", position: "relative", height: "100vh", overflow: "hidden" }}>
      <ConversationPane
        {...(snapshot === undefined ? {} : { snapshot })}
        scrollerRef={scrollerRef}
        onLoadOlder={() => undefined}
      />
      <ConversationMinimap rows={snapshot?.rows ?? []} scrollerRef={scrollerRef} />
    </div>
  );
}

const host = document.getElementById("root");
if (host !== null) createRoot(host).render(<HarnessView />);

declare global {
  interface Window {
    ompPerf: {
      reset(seed: PerfSeed): Promise<void>;
      run(options: PerfRunOptions): Promise<PerfResult>;
      cardTransition(): { readonly streaming: string; readonly idle: string };
      sessionSwitch(): Promise<SwitchPerfResult>;
    };
  }
}

window.ompPerf = {
  reset: (seed) => harness.reset(seed),
  run: (options) => harness.run(options),
  cardTransition: cardTransitionContract,
  sessionSwitch: sessionSwitchContract,
};
