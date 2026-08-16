import { useState } from "react";
import { MarkdownInline } from "../conversation/markdown";
import { PromptHead, type DeckQueue } from "../InteractionDeck";
import {
  PREVIEW_DECK_ITEMS,
  type PreviewDeckItem,
} from "./deckFixtures";

const PLAN_ACTIONS = [
  { id: "execute", label: "Approve and execute", primary: true },
  { id: "keep", label: "Approve and keep context", primary: false },
  { id: "compact", label: "Approve and compact context", primary: false },
  { id: "refine", label: "Refine plan", primary: false },
] as const;

function questionAnswered(selected: readonly string[], custom: string): boolean {
  return custom.trim().length > 0 || selected.length > 0;
}

function PlanCard({
  item,
  queue,
  onDismiss,
}: {
  item: Extract<PreviewDeckItem, { kind: "plan" }>;
  queue?: DeckQueue;
  onDismiss: () => void;
}) {
  return (
    <div className="approval-card">
      <PromptHead icon="alert" title="Plan Review" demo {...(item.meta ? { meta: item.meta } : {})} {...(queue ? { queue } : {})} />
      <div className="approval-body">
        <p className="dk-sub">{item.title}</p>
        <p>{item.summary}</p>
      </div>
      <div className="dk-actions">
        {PLAN_ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            className={`btn small${action.primary ? " primary" : " outline"}`}
            onClick={onDismiss}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AskCard({
  item,
  queue,
  onDismiss,
}: {
  item: Extract<PreviewDeckItem, { kind: "ask" }>;
  queue?: DeckQueue;
  onDismiss: () => void;
}) {
  const questions = item.questions;
  const [tab, setTab] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const current = questions[Math.min(tab, questions.length - 1)]!;
  const selected = picked[current.id] ?? [];
  const customValue = custom[current.id] ?? "";
  const canSubmit = questions.every((question) => questionAnswered(picked[question.id] ?? [], custom[question.id] ?? ""));

  const toggle = (label: string) => {
    setPicked((previous) => {
      const currentPicked = previous[current.id] ?? [];
      const next = current.multi
        ? (currentPicked.includes(label) ? currentPicked.filter((itemLabel) => itemLabel !== label) : [...currentPicked, label])
        : (currentPicked.length === 1 && currentPicked[0] === label ? [] : [label]);
      return { ...previous, [current.id]: next };
    });
  };
  const tabs = questions.length > 1;

  return (
    <div className="ask-card">
      <PromptHead icon="message" title="Agent 提问" demo {...(item.meta ? { meta: item.meta } : {})} {...(queue ? { queue } : {})} />
      <div className="ask-body">
        {tabs ? (
          <div className="dk-tabs" role="tablist" aria-label="问题">
            {questions.map((question, index) => (
              <button
                key={question.id}
                type="button"
                role="tab"
                aria-selected={index === tab}
                className={`chip xs${index === tab ? " purple" : " gray"}`}
                onClick={() => setTab(index)}
              >
                {question.header ?? question.id}
              </button>
            ))}
          </div>
        ) : current.header ? (
          <span className="chip purple xs">{current.header}</span>
        ) : null}
        <p className="dk-sub"><MarkdownInline text={current.question} k={`q-${current.id}`} /></p>
        <div className="dk-opts" role={current.multi ? "group" : "radiogroup"} aria-label={current.question}>
          {current.options.map((option, index) => {
            const on = selected.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                className={`dk-opt${on ? " sel" : ""}`}
                role={current.multi ? "checkbox" : "radio"}
                aria-checked={on}
                onClick={() => toggle(option.label)}
              >
                <span className="dk-opt-row">
                  <span className={current.multi ? "o-check" : "o-radio"} aria-hidden="true" />
                  <span className="o-label">{option.label}</span>
                  {index === current.recommended ? <span className="chip purple xs">Recommended</span> : null}
                </span>
                {option.description ? <span className="dk-opt-desc">{option.description}</span> : null}
                {option.preview ? <span className="dk-opt-preview">{option.preview}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="dk-custom">
          <input
            className="input dk-input"
            value={customValue}
            placeholder="自定义回答…"
            aria-label="自定义回答"
            onChange={(event) => setCustom((previous) => ({ ...previous, [current.id]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canSubmit) onDismiss();
            }}
          />
          <button type="button" className="btn small primary" disabled={!canSubmit} onClick={onDismiss}>发送</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Preview-only Deck above the composer. One window, ver1-style 1/N queue.
 * Demo buttons dismiss local cards; they do not call Host, write the reducer,
 * or forge SurfaceCapabilities.
 */
export function PreviewDeck() {
  const [remaining, setRemaining] = useState<readonly PreviewDeckItem[]>(() => PREVIEW_DECK_ITEMS);
  const [pos, setPos] = useState(0);
  const total = remaining.length;
  const index = total === 0 ? 0 : Math.min(pos, total - 1);
  const current = remaining[index];

  if (!current) {
    return <div className="deck" role="region" aria-label="待处理的审批与提问" />;
  }

  const queue: DeckQueue | undefined = total > 1
    ? {
        index,
        total,
        onPrev: () => setPos((value) => Math.max(0, value - 1)),
        onNext: () => setPos((value) => Math.min(total - 1, value + 1)),
      }
    : undefined;
  const dismiss = () => {
    const id = current.id;
    setRemaining((items) => items.filter((item) => item.id !== id));
  };

  return (
    <div className="deck active preview-queue" data-preview-deck role="region" aria-label="待处理的审批与提问（演示）" aria-live="polite">
      <div className="deck-card">
        {current.kind === "plan" ? (
          <PlanCard item={current} {...(queue ? { queue } : {})} onDismiss={dismiss} />
        ) : (
          <AskCard item={current} {...(queue ? { queue } : {})} onDismiss={dismiss} />
        )}
      </div>
    </div>
  );
}
