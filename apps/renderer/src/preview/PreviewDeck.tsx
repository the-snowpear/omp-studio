import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AskActions, AskBody, AskHead } from "../deck/AskCard";
import { askAnswered } from "../deck/askContent";
import { PlanCard } from "../deck/PlanCard";
import { type DeckQueue } from "../deck/PromptHead";
import { NO_ASK_ANSWER, type AskHeader, type DeckAskAnswer } from "../deck/types";
import type { SlideDir } from "../pageTransition";
import {
  PREVIEW_DECK_ITEMS,
  type PreviewDeckItem,
} from "./deckFixtures";

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type AskItem = Extract<PreviewDeckItem, { kind: "ask" }>;

/* ask 卡之间切换（队列 1/N 翻页 / 标题行 header 胶囊跳转）：
   · 卡片外壳常驻 —— 标题行（Agent 提问 / 胶囊 / 1-N）与底部操作行（取消 / 提交）
     是同一批 DOM 节点，换页时只就地更新状态（高亮、计数、「提交」可用性），
     不平移也不淡出；只有中间的问题正文那一段做方向性交叉溶解（往后翻新的从右
     来，往前翻从左来）。整卡横推 + 同时改高度会读成「斜向平移」，钉住这两行
     之后只剩正文在动；
   · 两段正文高低不同时，先锁住旧高度、下一帧再过渡到新高度。Deck 贴着输入框
     底部，所以底部操作行原地不动、卡片朝上生长 / 收起；过渡结束把锁释放回
     auto，之后改窗口 / 侧栏宽度仍由内容自然高度决定，不会停在过期像素值上；
   · 焦点：外壳不重建，翻页后焦点本来就还在原按钮上；只有它翻到边界被禁用
     （首页的「上一个」/ 末页的「下一个」）才会掉焦点，这时按 data-dk-focus
     退到另一侧，键盘连翻不断。
   卡片被处理掉（提交 / 取消 / 批准）不算「切换」：外壳可能整张换掉（计划卡 ⇄
   ask 卡），不留旧内容，把高度锁挪到舞台上过渡整卡高度。 */
const DECK_SETTLE_MS = 380; /* 撤旧内容 / 释放高度锁：.dk-cell-enter-* 的 300ms 再多留一帧 */

type DeckSwap = {
  /** 仍需在场淡出的旧卡正文；null = 整卡换掉，只过渡高度。 */
  readonly out: AskItem | null;
  readonly dir: SlideDir;
};

/** 高度锁挂在哪一层：换页只有正文段变高变矮，整卡换掉才锁舞台。 */
type LockLayer = "stage" | "swap";

/** 舞台里当前那张卡（整卡换掉时用它量新卡的自然高度）。 */
function stageCard(stage: HTMLElement | null): HTMLElement | null {
  const node = stage?.firstElementChild;
  return node instanceof HTMLElement ? node : null;
}

/** 焦点落回 data-dk-focus 相同的控件；队列按钮翻到边界被禁用时退到另一侧。 */
function restoreFocus(scope: HTMLElement | null, slot: string) {
  if (!scope) return;
  const order = slot === "queue-next"
    ? [slot, "queue-prev"]
    : slot === "queue-prev" ? [slot, "queue-next"] : [slot];
  for (const name of order) {
    const node = scope.querySelector<HTMLElement>(`[data-dk-focus="${name}"]:not([disabled])`);
    if (node) {
      node.focus();
      return;
    }
  }
}

function nextPicked(item: AskItem, picked: readonly string[], label: string): readonly string[] {
  if (item.question.multi) {
    return picked.includes(label) ? picked.filter((entry) => entry !== label) : [...picked, label];
  }
  return picked.length === 1 && picked[0] === label ? [] : [label];
}

/**
 * Preview-only Deck above the composer. One window, ver1-style 1/N queue.
 * Demo buttons dismiss local cards; they do not call Host, write the reducer,
 * or forge SurfaceCapabilities.
 */
export function PreviewDeck({ onCurrentKind }: {
  onCurrentKind?: (kind: "plan" | "ask" | null) => void;
} = {}) {
  const [remaining, setRemaining] = useState<readonly PreviewDeckItem[]>(() => PREVIEW_DECK_ITEMS);
  const [pos, setPos] = useState(0);
  const [answers, setAnswers] = useState<Readonly<Record<string, DeckAskAnswer>>>({});
  const [swap, setSwap] = useState<DeckSwap | null>(null);
  /** 像素高度锁；null = 跟随自然高度。锁在哪一层见 lockOn。 */
  const [lockH, setLockH] = useState<number | null>(null);
  const [smoothH, setSmoothH] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const swapRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const focusSlot = useRef<string | null>(null);

  const total = remaining.length;
  const index = total === 0 ? 0 : Math.min(pos, total - 1);
  const current = remaining[index];
  useEffect(() => {
    if (onCurrentKind === undefined) return;
    onCurrentKind(current === undefined ? null : current.kind === "plan" ? "plan" : "ask");
  }, [current, onCurrentKind]);
  const lockOn: LockLayer | null = swap === null ? null : swap.out === null ? "stage" : "swap";
  const lockStyle = (layer: LockLayer) => (lockOn === layer && lockH !== null ? { height: lockH } : undefined);
  const lockSmooth = (layer: LockLayer) => (lockOn === layer && smoothH ? " smooth" : "");

  /* 换页当帧：先按锁定的旧高度画一帧，再在下一帧过渡到新内容的自然高度。
     同一帧内写两个值不会触发过渡（浏览器只看到终点），所以必须隔一帧。 */
  useLayoutEffect(() => {
    if (!swap) return;
    const slot = focusSlot.current;
    focusSlot.current = null;
    if (slot) restoreFocus(stageRef.current, slot);
    const measured = swap.out === null ? stageCard(stageRef.current) : liveRef.current;
    const height = measured ? measured.offsetHeight : 0;
    if (height <= 0) return;
    const raf = requestAnimationFrame(() => {
      setSmoothH(true);
      setLockH(height);
    });
    return () => cancelAnimationFrame(raf);
  }, [swap]);

  /* 过渡结束：撤掉旧正文、释放高度锁 */
  useEffect(() => {
    if (!swap) return;
    const timer = window.setTimeout(() => {
      setSwap(null);
      setLockH(null);
      setSmoothH(false);
    }, DECK_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [swap]);

  /** 锁住当前高度并登记这次切换；reduce motion 下直接换。 */
  const beginSwap = useCallback((out: AskItem | null, dir: SlideDir) => {
    if (prefersReducedMotion()) {
      focusSlot.current = null;
      setSwap(null);
      setLockH(null);
      return;
    }
    const from = out === null ? stageRef.current : swapRef.current;
    const height = from ? from.offsetHeight : 0;
    setSmoothH(false);
    setLockH(height > 0 ? height : null);
    setSwap({ out, dir });
  }, []);

  const navigate = useCallback((next: number) => {
    const at = total === 0 ? 0 : Math.min(pos, total - 1);
    const target = Math.max(0, Math.min(total - 1, next));
    if (target === at) return;
    const from = remaining[at];
    const to = remaining[target];
    const active = document.activeElement;
    focusSlot.current = active instanceof HTMLElement ? active.getAttribute("data-dk-focus") : null;
    /* 只有 ask ⇄ ask 共用外壳，能只换正文；跨类型（计划卡）整卡过渡高度 */
    const keep = from?.kind === "ask" && to?.kind === "ask" ? from : null;
    beginSwap(keep, target > at ? "fwd" : "back");
    setPos(target);
  }, [beginSwap, pos, remaining, total]);

  const dismiss = useCallback((id: string) => {
    beginSwap(null, "fwd");
    setRemaining((items) => items.filter((item) => item.id !== id));
  }, [beginSwap]);

  const pick = useCallback((item: AskItem, label: string) => {
    setAnswers((prev) => {
      const at = prev[item.id] ?? NO_ASK_ANSWER;
      return { ...prev, [item.id]: { ...at, picked: nextPicked(item, at.picked, label) } };
    });
  }, []);

  const writeCustom = useCallback((id: string, custom: string) => {
    setAnswers((prev) => ({ ...prev, [id]: { ...(prev[id] ?? NO_ASK_ANSWER), custom } }));
  }, []);

  if (!current) {
    return <div className="deck" role="region" aria-label="待处理的审批与提问" />;
  }

  /* 本批次全部 ask 的 header（按队列顺序，含当前卡），供标题行胶囊切换 */
  const headers = remaining
    .map((item, at) => (item.kind === "ask" && item.question.header
      ? { header: item.question.header, active: at === index, index: at }
      : null))
    .filter((entry): entry is AskHeader => entry !== null);

  const queue: DeckQueue | undefined = total > 1
    ? { index, total, onPrev: () => navigate(index - 1), onNext: () => navigate(index + 1) }
    : undefined;
  const out = swap?.out ?? null;
  const dir = swap?.dir ?? "fwd";
  const askBody = (item: AskItem) => (
    <AskBody
      question={item.question}
      answer={answers[item.id] ?? NO_ASK_ANSWER}
      onPick={(label) => pick(item, label)}
      onCustom={(value) => writeCustom(item.id, value)}
      onSubmit={() => dismiss(item.id)}
    />
  );

  return (
    <div className="deck active preview-queue" data-preview-deck role="region" aria-label="待处理的审批与提问（演示）" aria-live="polite">
      <div className="deck-card">
        <div ref={stageRef} className={`dk-stage${lockSmooth("stage")}`} style={lockStyle("stage")}>
          {current.kind === "plan" ? (
            <PlanCard
              title={current.title}
              body={current.body}
              demo
              {...(current.meta ? { meta: current.meta } : {})}
              onAction={() => dismiss(current.id)}
            />
          ) : (
            <div className="ask-card">
              {/* 标题行：队列位置与胶囊高亮始终是当前卡的，不随离场正文回退 */}
              <AskHead
                demo
                {...(current.meta ? { meta: current.meta } : {})}
                {...(queue ? { queue } : {})}
                headers={headers}
                onJump={navigate}
              />
              <div ref={swapRef} className={`dk-swap${lockSmooth("swap")}`} style={lockStyle("swap")}>
                {out ? (
                  <div key={out.id} className={`dk-cell dk-cell-out dk-cell-leave-${dir}`} aria-hidden inert>
                    {askBody(out)}
                  </div>
                ) : null}
                <div key={current.id} ref={liveRef} className={`dk-cell${out ? ` dk-cell-enter-${dir}` : ""}`}>
                  {askBody(current)}
                </div>
              </div>
              <AskActions
                canSubmit={askAnswered(answers[current.id] ?? NO_ASK_ANSWER)}
                onCancel={() => dismiss(current.id)}
                onSubmit={() => dismiss(current.id)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
