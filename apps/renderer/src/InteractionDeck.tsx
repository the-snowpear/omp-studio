import { useEffect, useRef, useState } from "react";
import type { ClientInteraction, InteractionResponseValue } from "@omp-studio/client-contract";
import { ApprovalCard } from "./deck/ApprovalCard";
import { AskActions, AskBody, AskHead } from "./deck/AskCard";
import { approvalFromInteraction } from "./deck/approvalContent";
import {
  askAnswered,
  askToDeckView,
  NO_ASK_ANSWER,
  nextPicked,
  selectToAskView,
  submitAskValue,
  submitSelectValue,
} from "./deck/askContent";
import { QueuedDeck, type QueuedAskItem, type QueuedDeckItem } from "./deck/QueuedDeck";
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
  if (interaction.kind === "ask") {
    return (
      <LiveAskQueue
        interaction={interaction}
        onRespond={onRespond}
        disabled={busy}
      />
    );
  }
  if (interaction.kind !== "approval") return null;
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

function askItemsFrom(interaction: Extract<ClientInteraction, { kind: "ask" | "select" }>): readonly QueuedDeckItem[] {
  if (interaction.kind === "ask") return askToDeckView(interaction).items;
  const view = selectToAskView(interaction);
  return [{ kind: "ask", id: view.question.id, question: view.question }];
}

function LiveAskQueue({
  interaction,
  onRespond,
  disabled,
}: {
  interaction: Extract<ClientInteraction, { kind: "ask" | "select" }>;
  onRespond: (decision: "submit" | "cancel", value?: InteractionResponseValue) => void | Promise<boolean>;
  disabled: boolean;
}) {
  const items = askItemsFrom(interaction);
  const answersRef = useRef<Record<string, DeckAskAnswer>>({});
  const outcomesRef = useRef<Record<string, "submit" | "cancel">>({});
  const [submitError, setSubmitError] = useState(false);

  const finishIfComplete = async (): Promise<boolean> => {
    if (items.some((item) => outcomesRef.current[item.id] === undefined)) return true;
    const allCancel = items.every((item) => outcomesRef.current[item.id] === "cancel");
    if (allCancel) {
      const result = await Promise.resolve(onRespond("cancel"));
      return result !== false;
    }
    const value = liveAskValue(interaction, answersRef.current);
    if (value === undefined) return false;
    const result = await Promise.resolve(onRespond("submit", value));
    return result !== false;
  };

  const settle = async (item: QueuedAskItem, reason: "submit" | "cancel", answer?: DeckAskAnswer): Promise<boolean> => {
    if (reason === "submit") answersRef.current[item.id] = answer ?? NO_ASK_ANSWER;
    else answersRef.current[item.id] = NO_ASK_ANSWER;
    outcomesRef.current[item.id] = reason;
    const ok = await finishIfComplete();
    if (!ok) {
      delete outcomesRef.current[item.id];
      setSubmitError(true);
      return false;
    }
    setSubmitError(false);
    return true;
  };

  return (
    <QueuedDeck
      items={items}
      regionLabel="待处理的审批与提问"
      {...(disabled ? { disabled: true } : {})}
      {...(submitError ? { submitError: true } : {})}
      onAskSubmit={(item, answer) => settle(item, "submit", answer)}
      onAskCancel={(item) => settle(item, "cancel")}
    />
  );
}

function liveAskValue(
  interaction: Extract<ClientInteraction, { kind: "ask" | "select" }>,
  answers: Readonly<Record<string, DeckAskAnswer>>,
): InteractionResponseValue | undefined {
  if (interaction.kind === "ask") return submitAskValue(interaction.questions, answers);
  const view = selectToAskView(interaction);
  return submitSelectValue(view, answers[view.question.id] ?? NO_ASK_ANSWER, interaction.multiple);
}

export function InteractionDeck({ interaction, onRespond, disabled }: {
  interaction: ClientInteraction | null;
  onRespond: (decision: "submit" | "cancel", value?: InteractionResponseValue) => void | Promise<boolean>;
  disabled: boolean;
}) {
  if (interaction === null) {
    return <div className="deck" role="region" aria-label="待处理的审批与提问" />;
  }
  if (interaction.kind === "ask" || interaction.kind === "select") {
    return (
      <LiveAskQueue
        key={`${interaction.interactionId}:${interaction.leaseGeneration}`}
        interaction={interaction}
        onRespond={onRespond}
        disabled={disabled}
      />
    );
  }
  return (
    <div className="deck active preview-queue" role="region" aria-label="待处理的审批与提问" aria-live="polite">
      <div className="deck-card">
        <div className="dk-stage">
          <InteractionPrompt interaction={interaction} onRespond={onRespond} disabled={disabled} />
        </div>
      </div>
    </div>
  );
}
