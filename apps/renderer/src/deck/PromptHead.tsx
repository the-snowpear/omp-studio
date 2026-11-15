import type { ReactNode } from "react";
import { Icon } from "../icons";
import { isZh, useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";

export type DeckQueue = {
  readonly index: number;
  readonly total: number;
  readonly onPrev: () => void;
  readonly onNext: () => void;
};

export function QueueNav({ queue }: { queue?: DeckQueue }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  if (!queue || queue.total <= 1) return null;
  /* data-dk-focus：换卡时新旧卡是两个 DOM 节点，Deck 靠这个标记把焦点搬到
     新卡里位置相同的按钮上，键盘 / 连续点击翻页不会掉焦点。 */
  return (
    <span className="dk-queue">
      <button type="button" className="icon-btn small" aria-label={zh ? "上一个请求" : "Previous request"} data-dk-focus="queue-prev" disabled={queue.index === 0} onClick={queue.onPrev}>
        <Icon name="chevron-l" extra="sm" />
      </button>
      <span className="q-pos">{queue.index + 1}/{queue.total}</span>
      <button type="button" className="icon-btn small" aria-label={zh ? "下一个请求" : "Next request"} data-dk-focus="queue-next" disabled={queue.index === queue.total - 1} onClick={queue.onNext}>
        <Icon name="chevron-r" extra="sm" />
      </button>
    </span>
  );
}

export function demoMark(demo?: boolean, marks = true, zh = isZh()) {
  return demo && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null;
}

export function PromptHead({
  icon,
  title,
  demo,
  meta,
  queue,
  chips,
  end,
}: {
  icon: "alert" | "message" | "pencil";
  title: string;
  demo?: boolean;
  meta?: string;
  queue?: DeckQueue;
  /** 标题行右侧、队列导航之前的可选插槽（如 ask header 切换胶囊）。 */
  chips?: ReactNode;
  /** 队列导航之前的操作（如计划放大）。 */
  end?: ReactNode;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { marks } = usePreviewMode();
  return (
    <div className={icon === "message" || icon === "pencil" ? "ask-head" : "approval-head"}>
      <Icon name={icon} extra="sm" />
      {title}
      {chips}
      <span className="dk-head-end">
        {demoMark(demo, marks, zh)}
        {meta ? <span className="dk-agent">{meta}</span> : null}
        <QueueNav {...(queue ? { queue } : {})} />
        {end}
      </span>
    </div>
  );
}
