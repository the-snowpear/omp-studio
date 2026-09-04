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
export type ExpandPerfResult = {
  /** 被点开的卡（工具类型 + 链内序号），null = 没找到可点的中段卡，探针没生效。 */
  readonly clicked: string | null;
  /** 展开后那张卡的正文高度：探针必须真的把一段高度撑出来，否则测的是空动作。 */
  readonly grewPx: number;
  /** 同一行内、展开点下方那张卡的表头，逐帧最大位移（px）。 */
  readonly maxShiftPx: number;
  /** 文档底边相对滚动容器底边的逐帧最大位移（px）：跟随尾部时它必须一直贴着。 */
  readonly maxDocBottomShiftPx: number;
  readonly samples: number;
  /** 收场时距尾部的距离：动画跑完仍应贴底。 */
  readonly tailDistancePx: number;
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

/** 绘制之后的一个任务：此刻布局里已经含上本帧 ResizeObserver 里做的贴底补偿，
 *  读到的就是真正画出来的那一帧。在 rAF 里读会强制布局，读到的是补偿之前的中间态。 */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
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

/**
 * 一张「中段」工具卡：折叠着、不在运行、表头在视口内，且同一虚拟行里它后面还有一张卡
 * 当探针。展开的是同一行内的流内内容，下方那张卡当帧就会被推下去——这正是被测的那条链。
 */
function pickExpandTarget(): { readonly row: HTMLElement; readonly header: HTMLElement; readonly probe: HTMLElement; readonly label: string } | null {
  const scroller = document.querySelector<HTMLElement>(".convo-scroll");
  if (scroller === null) return null;
  const view = scroller.getBoundingClientRect();
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".convo-virtual-row")).reverse();
  for (const row of rows) {
    const items = Array.from(row.querySelectorAll<HTMLElement>(".tl-item"));
    for (let index = 0; index < items.length - 1; index += 1) {
      const item = items[index]!;
      if (item.classList.contains("open") || item.dataset.status === "running") continue;
      const header = item.querySelector<HTMLElement>("button.tl-row");
      const probe = items[index + 1]!.querySelector<HTMLElement>("button.tl-row");
      if (header === null || probe === null || !onScreen(header)) continue;
      const rect = header.getBoundingClientRect();
      if (rect.top < view.top || rect.bottom > view.bottom) continue;
      return { row, header, probe, label: `${item.dataset.kind ?? "?"}#${index}` };
    }
  }
  return null;
}

/**
 * 真的画在屏上：折叠的工具链是 `visibility: hidden` + 0fr 网格，里面的卡片仍然有几何
 * （getBoundingClientRect 照样给尺寸），点它等于什么都没发生——探针必须排除这种目标。
 */
function onScreen(el: HTMLElement): boolean {
  const check = (el as { checkVisibility?: (options: Record<string, boolean>) => boolean }).checkVisibility;
  if (typeof check === "function") {
    return check.call(el, { checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true });
  }
  return el.getClientRects().length > 0;
}

/**
 * 真 Chromium 下验证：跟随尾部时展开一张中段工具卡，它下方的内容一帧都不许动。
 *
 * jsdom 测不到这条——它没有布局、没有 CSS 过渡、没有 ResizeObserver 时序。绝对定位的
 * 虚拟行模型下这里量到几十像素的「先往下再归位」（同款 Chromium 里的最小复现是 61px）。
 *
 * `toolsPerTurn: 1` 是刻意的：单卡批次不套可折叠的工具链，卡片一直可见，点开只动它自己，
 * 不会和「上一轮的链自动折叠」那条策略抢状态。链尾那一轮的卡片在视口里，它下方同一虚拟
 * 行内还有正在运行的那张卡当探针。
 */
async function expandJitterContract(): Promise<ExpandPerfResult> {
  await harness.reset({ turns: 24, toolsPerTurn: 1, outputLines: 400 });
  const scroller = document.querySelector<HTMLElement>(".convo-scroll");
  const doc = document.querySelector<HTMLElement>(".convo-doc");
  if (scroller === null || doc === null) throw new Error("展开探针没有找到 transcript");
  const settle = async (ms: number) => {
    const until = performance.now() + ms;
    while (performance.now() < until) { await frame(); }
    await afterPaint();
  };
  // 会话切换过场（淡出 → 骨架 → 淡入）期间正文的 opacity 是 0，此时挑目标会因为
  // 「不可见」全被排除。等到 idle 且完全不透明再开始——探针要量的是静止态的展开。
  const body = document.querySelector<HTMLElement>(".convo-body");
  const deadlineIdle = performance.now() + 3000;
  while (performance.now() < deadlineIdle) {
    if (body !== null && body.dataset.phase === "idle" && Number.parseFloat(getComputedStyle(body).opacity || "0") > 0.99) break;
    await frame();
  }
  await afterPaint();
  scroller.scrollTop = scroller.scrollHeight;
  await settle(80);
  const target = pickExpandTarget();
  if (target === null) {
    return { clicked: null, grewPx: 0, maxShiftPx: 0, maxDocBottomShiftPx: 0, samples: 0, tailDistancePx: 0 };
  }
  const probeTop = () => target.probe.getBoundingClientRect().top;
  const docGap = () => doc.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
  const baseTop = probeTop();
  const baseGap = docGap();
  let maxShiftPx = 0;
  let maxDocBottomShiftPx = 0;
  let samples = 0;
  target.header.click();
  // 按时间收口而不是按帧数：--dur-slow 是 250ms，而刷新率从 60Hz 到 240Hz 都可能。
  const deadline = performance.now() + 600;
  while (performance.now() < deadline && samples < 240) {
    await frame();
    await afterPaint();
    samples += 1;
    maxShiftPx = Math.max(maxShiftPx, Math.abs(probeTop() - baseTop));
    maxDocBottomShiftPx = Math.max(maxDocBottomShiftPx, Math.abs(docGap() - baseGap));
  }
  const card = target.header.parentElement?.querySelector<HTMLElement>(".tl-card") ?? null;
  return {
    clicked: target.label,
    grewPx: Math.round(card?.getBoundingClientRect().height ?? 0),
    maxShiftPx: Math.round(maxShiftPx * 10) / 10,
    maxDocBottomShiftPx: Math.round(maxDocBottomShiftPx * 10) / 10,
    samples,
    tailDistancePx: Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
  };
}

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
      expandJitter(): Promise<ExpandPerfResult>;
    };
  }
}

window.ompPerf = {
  reset: (seed) => harness.reset(seed),
  run: (options) => harness.run(options),
  cardTransition: cardTransitionContract,
  sessionSwitch: sessionSwitchContract,
  expandJitter: expandJitterContract,
};
