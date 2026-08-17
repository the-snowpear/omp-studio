import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientInteraction, InteractionResponseValue } from "@omp-studio/client-contract";
import { ApprovalCard } from "./deck/ApprovalCard";
import { AskActions, AskBody, AskHead } from "./deck/AskCard";
import { approvalFromInteraction } from "./deck/approvalContent";
import { askAnswered, NO_ASK_ANSWER, nextPicked, selectToAskView, submitSelectValue } from "./deck/askContent";
import { PromptHead, type DeckQueue } from "./deck/PromptHead";
import type { DeckAskAnswer } from "./deck/types";

export type { DeckQueue } from "./deck/PromptHead";
export { PromptHead, QueueNav } from "./deck/PromptHead";

export type InteractionCaption = {
  readonly title: string;
  readonly description?: string;
  readonly meta?: string;
};

export function InteractionPrompt({ interaction, onRespond, disabled, caption, demo, queue }: {
  interaction: ClientInteraction;
  onRespond: (decision: "submit" | "cancel", value?: InteractionResponseValue) => void | Promise<boolean>;
  disabled?: boolean;
  caption?: InteractionCaption;
  demo?: boolean;
  queue?: DeckQueue;
}) {
  const [text, setText] = useState(interaction.kind === "editor" ? (interaction.content ?? "") : "");
  const [answer, setAnswer] = useState<DeckAskAnswer>(NO_ASK_ANSWER);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  useEffect(() => {
    if (interaction.kind === "editor") setText(interaction.content ?? "");
    else setText("");
    setAnswer(NO_ASK_ANSWER);
  }, [interaction.interactionId, interaction.leaseGeneration]);
  const busy = disabled || submitting;
  const submit = (value?: InteractionResponseValue) => {
    if (busy) return;
    setSubmitting(true);
    setSubmitError(false);
    Promise.resolve(onRespond("submit", value)).then(
      (ok) => {
        if (ok === false) setSubmitError(true);
      },
      () => setSubmitError(true),
    ).finally(() => setSubmitting(false));
  };
  const cancel = () => {
    if (busy) return;
    setSubmitting(true);
    setSubmitError(false);
    Promise.resolve(onRespond("cancel")).then(
      (ok) => {
        if (ok === false) setSubmitError(true);
      },
      () => setSubmitError(true),
    ).finally(() => setSubmitting(false));
  };
  const retryNote = submitError ? (
    <p className="ask-error" role="alert">
      提交失败，卡片已保留。请重试。
    </p>
  ) : null;
  if (interaction.kind === "confirm") {
    return (
      <div className="approval-card">
        <PromptHead icon="alert" title={interaction.title || "确认"} {...(demo === true ? { demo: true } : {})} {...(caption?.meta ? { meta: caption.meta } : {})} {...(queue ? { queue } : {})} />
        <div className="approval-body">{interaction.message}</div>
        {retryNote}
        <div className="dk-actions">
          <button className="btn lg outline" disabled={busy} onClick={cancel}>取消</button>
          <button className="btn lg primary" disabled={busy} onClick={() => submit(true)}>确认</button>
        </div>
      </div>
    );
  }
  if (interaction.kind === "select") {
    const view = selectToAskView(interaction);
    const pick = (label: string) => {
      if (busy) return;
      setAnswer((previous) => ({ ...previous, picked: nextPicked(view.question, previous.picked, label) }));
    };
    const send = () => {
      const value = submitSelectValue(view, answer, interaction.multiple);
      if (value === undefined) return;
      submit(value);
    };
    return (
      <div className="ask-card">
        <AskHead
          {...(demo === true ? { demo: true } : {})}
          {...(caption?.meta ? { meta: caption.meta } : {})}
          {...(queue ? { queue } : {})}
          headers={[]}
          onJump={() => undefined}
        />
        <AskBody
          question={view.question}
          answer={answer}
          {...(busy ? { disabled: true } : {})}
          onPick={pick}
          onCustom={(value) => setAnswer((previous) => ({ ...previous, custom: value }))}
          onSubmit={send}
        />
        {retryNote}
        <AskActions
          {...(busy ? { disabled: true } : {})}
          canSubmit={askAnswered(answer)}
          onCancel={cancel}
          onSubmit={send}
        />
      </div>
    );
  }
  if (interaction.kind === "input") {
    return (
      <div className="ask-card">
        <PromptHead icon="pencil" title={interaction.title || "输入"} {...(demo === true ? { demo: true } : {})} {...(caption?.meta ? { meta: caption.meta } : {})} {...(queue ? { queue } : {})} />
        <div className="ask-body">
          <input className="input dk-input" value={text} onChange={(event) => setText(event.target.value)} disabled={busy} placeholder={interaction.placeholder ?? "Response"} type={interaction.secret ? "password" : "text"} />
        </div>
        {retryNote}
        <AskActions {...(busy ? { disabled: true } : {})} canSubmit={text.trim().length > 0} onCancel={cancel} onSubmit={() => submit(text)} />
      </div>
    );
  }
  if (interaction.kind === "editor") {
    return (
      <div className="ask-card">
        <PromptHead icon="pencil" title={interaction.title || "编辑"} {...(demo === true ? { demo: true } : {})} {...(caption?.meta ? { meta: caption.meta } : {})} {...(queue ? { queue } : {})} />
        <div className="ask-body">
          {interaction.language ? <p className="muted small">{interaction.language}</p> : null}
          <textarea
            className="editor-input"
            rows={6}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={busy}
            aria-label={interaction.title || "编辑内容"}
          />
        </div>
        {retryNote}
        <AskActions {...(busy ? { disabled: true } : {})} canSubmit={true} onCancel={cancel} onSubmit={() => submit(text)} />
      </div>
    );
  }
  const view = approvalFromInteraction(interaction);
  return (
    <ApprovalCard
      view={view}
      {...(demo === true ? { demo: true } : {})}
      {...(caption?.meta ? { meta: caption.meta } : {})}
      {...(busy ? { disabled: true } : {})}
      {...(submitError ? { submitError: true } : {})}
      onAllow={() => submit(true)}
      onAlways={() => submit(true)}
      onDeny={cancel}
    />
  );
}

type DeckEntry = { id: string; interaction: ClientInteraction; leaving: boolean };

const DECK_PUSH_MS = 260;
const DECK_EXIT_MS = 220;
const DECK_GROW_MS = 320;

export function InteractionDeck({ interaction, onRespond, disabled }: {
  interaction: ClientInteraction | null;
  onRespond: (decision: "submit" | "cancel", value?: InteractionResponseValue) => void | Promise<boolean>;
  disabled: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<DeckEntry[]>([]);
  const [lockH, setLockH] = useState<number | null>(null);
  const [noAnim, setNoAnim] = useState(false);
  const [shellMode, setShellMode] = useState<"in" | "out" | "">("");
  const lastId = useRef<string | null>(null);
  const gen = useRef(0);
  const lastW = useRef(-1);
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

  useEffect(() => {
    const id = interaction === null ? null : `${interaction.interactionId}:${interaction.leaseGeneration}`;
    if (id === lastId.current) return;
    lastId.current = id;
    gen.current += 1;
    const g = gen.current;

    const wrap = wrapRef.current;
    if (wrap) {
      wrap.classList.add("smooth");
      setLockH(wrap.offsetHeight);
    }
    const wasEmpty = !wrap || !wrap.querySelector(".deck-cell");

    if (interaction === null) {
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

    const entryId = `${interaction.interactionId}:${interaction.leaseGeneration}`;
    setNoAnim(false);
    setShellMode(wasEmpty ? "in" : "");
    setEntries((prev) => {
      if (prev.some((e) => e.id === entryId)) return prev;
      return [...prev.map((e) => ({ ...e, leaving: true })), { id: entryId, interaction, leaving: false }];
    });
    later(() => {
      if (gen.current !== g) return;
      setEntries((prev) => prev.filter((e) => !e.leaving));
      setNoAnim(true);
    }, DECK_PUSH_MS);
  }, [interaction, later]);

  useEffect(() => {
    if (!entries.length) return;
    const wrap = wrapRef.current;
    const track = trackRef.current;
    if (!wrap || !track || lockH === null) return;
    const raf = requestAnimationFrame(() => {
      const cell = track.querySelector<HTMLElement>(".deck-cell:last-child");
      if (!cell) return;
      setLockH(cell.offsetHeight);
    });
    return () => cancelAnimationFrame(raf);
  }, [entries]);

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
