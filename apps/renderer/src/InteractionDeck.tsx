import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientInteraction, InteractionResponseValue } from "@omp-studio/client-contract";
import { Icon } from "./icons";

export type InteractionCaption = {
  readonly title: string;
  readonly description?: string;
  readonly meta?: string;
};

export type DeckQueue = {
  readonly index: number;
  readonly total: number;
  readonly onPrev: () => void;
  readonly onNext: () => void;
};

export function QueueNav({ queue }: { queue?: DeckQueue }) {
  if (!queue || queue.total <= 1) return null;
  return (
    <span className="dk-queue">
      <button type="button" className="icon-btn small" aria-label="上一个请求" disabled={queue.index === 0} onClick={queue.onPrev}>
        <Icon name="chevron-l" extra="sm" />
      </button>
      <span className="q-pos">{queue.index + 1}/{queue.total}</span>
      <button type="button" className="icon-btn small" aria-label="下一个请求" disabled={queue.index === queue.total - 1} onClick={queue.onNext}>
        <Icon name="chevron-r" extra="sm" />
      </button>
    </span>
  );
}

export function PromptHead({
  icon,
  title,
  demo,
  meta,
  queue,
}: {
  icon: "alert" | "message" | "pencil";
  title: string;
  demo?: boolean;
  meta?: string;
  queue?: DeckQueue;
}) {
  return (
    <div className={icon === "message" || icon === "pencil" ? "ask-head" : "approval-head"}>
      <Icon name={icon} extra="sm" />
      {title}
      <span className="dk-head-end">
        {demoMark(demo)}
        {meta ? <span className="dk-agent">{meta}</span> : null}
        <QueueNav {...(queue ? { queue } : {})} />
      </span>
    </div>
  );
}

function demoMark(demo?: boolean) {
  return demo ? <span className="chip gray xs">演示</span> : null;
}

function riskLabel(risk: string | undefined): string | undefined {
  if (risk === "high") return "高风险";
  if (risk === "medium" || risk === "med") return "中风险";
  return risk;
}

export function InteractionPrompt({ interaction, onRespond, disabled, caption, demo, queue }: {
  interaction: ClientInteraction;
  onRespond: (decision: "submit" | "cancel", value?: InteractionResponseValue) => void;
  disabled?: boolean;
  caption?: InteractionCaption;
  demo?: boolean;
  queue?: DeckQueue;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const toggleOption = (optionId: string) => {
    if (disabled || interaction.kind !== "select") return;
    setSelected((previous) => interaction.multiple
      ? (previous.includes(optionId) ? previous.filter((id) => id !== optionId) : [...previous, optionId])
      : (previous.length === 1 && previous[0] === optionId ? [] : [optionId]));
  };
  const cancel = <button className="btn outline" disabled={disabled} onClick={() => onRespond("cancel")}>Cancel</button>;
  if (interaction.kind === "confirm") {
    return (
      <div className="approval-card">
        <PromptHead icon="alert" title="确认" {...(demo === true ? { demo: true } : {})} {...(caption?.meta ? { meta: caption.meta } : {})} {...(queue ? { queue } : {})} />
        <div className="approval-body">{interaction.message}</div>
        <div className="approval-foot"><button className="btn primary" disabled={disabled} onClick={() => onRespond("submit", true)}>Confirm</button>{cancel}</div>
      </div>
    );
  }
  if (interaction.kind === "select") {
    const canSubmit = interaction.multiple ? selected.length > 0 : selected.length === 1;
    return (
      <div className="ask-card">
        <PromptHead icon="message" title={caption ? "Agent 提问" : "选择"} {...(demo === true ? { demo: true } : {})} {...(caption?.meta ? { meta: caption.meta } : {})} {...(queue ? { queue } : {})} />
        <div className="ask-body">
          {caption ? (
            <>
              <p>{caption.title}</p>
              {caption.description ? <p className="muted small">{caption.description}</p> : null}
            </>
          ) : (
            <p className="muted small">Runtime requests select{interaction.multiple ? " (multiple)" : ""}.</p>
          )}
          {interaction.options.map((option) => (
            <button key={option.id} type="button" className={`ask-opt${selected.includes(option.id) ? " sel" : ""}`} aria-checked={selected.includes(option.id)} disabled={disabled} onClick={() => toggleOption(option.id)}>
              <span>{option.label}</span>
              {option.description ? (option.description === "推荐" ? <span className="chip purple xs">{option.description}</span> : <span className="muted small">{option.description}</span>) : null}
            </button>
          ))}
        </div>
        <div className="approval-foot"><button className="btn primary" disabled={disabled || !canSubmit} onClick={() => onRespond("submit", interaction.multiple ? selected : selected[0])}>Submit</button>{cancel}</div>
      </div>
    );
  }
  if (interaction.kind === "input") {
    return (
      <div className="ask-card">
        <PromptHead icon="pencil" title="输入" {...(demo === true ? { demo: true } : {})} {...(caption?.meta ? { meta: caption.meta } : {})} {...(queue ? { queue } : {})} />
        <div className="ask-body">
          <input className="input" value={text} onChange={(event) => setText(event.target.value)} disabled={disabled} placeholder={interaction.placeholder ?? "Response"} type={interaction.secret ? "password" : "text"} />
        </div>
        <div className="approval-foot"><button className="btn primary" disabled={disabled || !text.trim()} onClick={() => onRespond("submit", text)}>Submit</button>{cancel}</div>
      </div>
    );
  }
  if (interaction.kind === "editor") {
    return (
      <div className="approval-card">
        <PromptHead icon="alert" title="编辑" {...(demo === true ? { demo: true } : {})} {...(caption?.meta ? { meta: caption.meta } : {})} {...(queue ? { queue } : {})} />
        <div className="approval-body">
          <p>{`Runtime requests editor${interaction.language ? ` (${interaction.language})` : ""}.`}</p>
          <p className="muted small">没有安全提交 schema，只能取消。</p>
        </div>
        <div className="approval-foot"><button className="btn" disabled title="此交互类型未实现安全提交">Submit</button>{cancel}</div>
      </div>
    );
  }
  const command = typeof interaction.detail.command === "string" ? interaction.detail.command : undefined;
  const reason = typeof interaction.detail.reason === "string" ? interaction.detail.reason : undefined;
  const risk = riskLabel(typeof interaction.detail.risk === "string" ? interaction.detail.risk : undefined);
  const scope = typeof interaction.detail.scope === "string" ? interaction.detail.scope : undefined;
  return (
    <div className="approval-card">
      <PromptHead icon="alert" title={`审批${risk ? ` · ${risk}` : ""}`} {...(demo === true ? { demo: true } : {})} {...(caption?.meta ? { meta: caption.meta } : {})} {...(queue ? { queue } : {})} />
      <div className="approval-body">
        <p>{caption?.title ?? interaction.approvalType}</p>
        {command ? <p className="cmd">{command}</p> : null}
        {reason ? <p>{reason}</p> : null}
        {scope ? <p className="muted small">{scope}</p> : null}
      </div>
      <div className="approval-foot">
        <button className="btn primary" disabled={disabled} onClick={() => onRespond("submit", true)}>允许一次</button>
        {cancel}
      </div>
    </div>
  );
}

/* —— 底部操作许可 Deck（Agent 提问 / 审批请求）——
   参照 ver1：浮在输入框上方（最靠近输入，优先处理），不挤占布局；
   激活时 composer 变暗让位。切换动画：
   · 同一张卡片内切换内容 —— 卡片外壳常驻，内部横向轨道平移：
     旧内容向左推出、新内容从右滑入，不换卡、不闪烁；
   · 高度变化以底部为锚向上展开 —— JS 锁像素高度后交给 CSS transition，
     新内容更高时向上生长、更矮时向下收起，而不是瞬间跳变。 */
type DeckEntry = { id: string; interaction: ClientInteraction; leaving: boolean };

const DECK_PUSH_MS = 260; /* 内容平移时长（略大于 CSS transform transition 250ms） */
const DECK_EXIT_MS = 220; /* 整卡退出动画时长（与 CSS deck-out 一致） */
const DECK_GROW_MS = 320; /* 高度展开过渡时长（不小于 CSS height transition） */

export function InteractionDeck({ interaction, onRespond, disabled }: {
  interaction: ClientInteraction | null;
  onRespond: (decision: "submit" | "cancel", value?: InteractionResponseValue) => void;
  disabled: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<DeckEntry[]>([]);
  /* 锁定容器像素高度；null = 无内容（自动高度 0）。锁定值的变化由
     .deck.smooth 的 height transition 驱动，实现「向上展开 / 向下收起」。 */
  const [lockH, setLockH] = useState<number | null>(null);
  /* 剪枝提交：轨道 transform 复位不过渡（否则唯一内容会从左滑回） */
  const [noAnim, setNoAnim] = useState(false);
  /* 卡片外壳动画：in = 空 → 首次出现滑入；out = 整卡退出；"" = 稳态 */
  const [shellMode, setShellMode] = useState<"in" | "out" | "">("");
  const lastId = useRef<string | null>(null);
  const gen = useRef(0);    /* 世代计数：被新交互取代后，过期的定时器作废 */
  const lastW = useRef(-1); /* ResizeObserver 只响应宽度变化，不打断高度过渡 */
  const timers = useRef<number[]>([]);

  const later = useCallback((fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      timers.current = timers.current.filter((x) => x !== t);
      fn();
    }, ms);
    timers.current.push(t);
  }, []);

  useEffect(() => () => {
    timers.current.forEach((t) => window.clearTimeout(t));
  }, []);

  /* interaction 变化：先锁定当前渲染高度（换内容瞬间不跳变），再在同一张卡片内平移 */
  useEffect(() => {
    const id = interaction?.interactionId ?? null;
    if (id === lastId.current) return;
    lastId.current = id;
    gen.current += 1;
    const g = gen.current;

    const wrap = wrapRef.current;
    if (wrap) {
      wrap.classList.add("smooth");
      setLockH(wrap.offsetHeight); /* 无卡片时 offsetHeight 为 0 */
    }
    const wasEmpty = !wrap || !wrap.querySelector(".deck-cell");

    if (interaction === null) {
      /* 全部退出：整卡滑出 → 收起高度 → 解锁（被新交互取代则作废） */
      setShellMode("out");
      setEntries((prev) => prev.map((e) => ({ ...e, leaving: true })));
      later(() => {
        if (gen.current !== g) return;
        setEntries([]);
        setLockH(0);
      }, DECK_EXIT_MS);
      later(() => {
        if (gen.current === g) setLockH(null);
      }, DECK_EXIT_MS + DECK_GROW_MS);
      return;
    }

    setNoAnim(false);
    setShellMode(wasEmpty ? "in" : "");
    setEntries((prev) => {
      if (prev.some((e) => e.interaction.interactionId === interaction.interactionId)) return prev;
      return [...prev.map((e) => ({ ...e, leaving: true })), { id: interaction.interactionId, interaction, leaving: false }];
    });
    /* 内容平移结束后：移出旧内容，同一次提交里把轨道复位到 0（禁止过渡） */
    later(() => {
      if (gen.current !== g) return;
      setEntries((prev) => prev.filter((e) => !e.leaving));
      setNoAnim(true);
    }, DECK_PUSH_MS);
  }, [interaction, later]);

  /* 提交后：量出最新内容的高度，平滑展开到新高度（以底部为锚向上生长） */
  useEffect(() => {
    if (!entries.length) return;
    const wrap = wrapRef.current;
    const track = trackRef.current;
    if (!wrap || !track || lockH === null) return;
    /* 在下一帧重测，避免锁到旧宽度下的过时高度 */
    const raf = requestAnimationFrame(() => {
      const cell = track.querySelector<HTMLElement>(".deck-cell:last-child");
      if (!cell) return;
      setLockH(cell.offsetHeight);
    });
    return () => cancelAnimationFrame(raf);
  }, [entries]);

  /* 容器宽度变化（窗口 / 侧栏 / 底栏）时跟随卡片自然高度，不做过渡 */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver((items) => {
      for (const item of items) {
        const width = item.contentBoxSize?.[0]?.inlineSize ?? item.contentRect.width;
        if (Math.abs(width - lastW.current) < 0.5) continue;
        lastW.current = width;
        const track = trackRef.current;
        const cell = track?.querySelector<HTMLElement>(".deck-cell:last-child");
        if (!cell) return;
        wrap.classList.remove("smooth");
        setLockH(cell.offsetHeight);
      }
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={wrapRef}
      className={`deck${entries.length ? " active" : ""}`}
      style={lockH === null ? undefined : { height: lockH }}
      role="region"
      aria-label="待处理的审批与提问"
      aria-live="polite"
    >
      {entries.length > 0 && (
        <div className={`deck-card${shellMode ? ` ${shellMode}` : ""}`}>
          <div
            ref={trackRef}
            className={`deck-track${noAnim ? " no-anim" : ""}`}
            style={{ transform: `translateX(${-100 * Math.max(0, entries.length - 1)}%)` }}
          >
            {entries.map((entry) => (
              <div key={entry.id} className="deck-cell">
                <InteractionPrompt interaction={entry.interaction} onRespond={onRespond} disabled={disabled} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
