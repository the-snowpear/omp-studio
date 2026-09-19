import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "../icons";
import { MarkdownText } from "../conversation/markdown";
import { useI18n } from "../i18n";
import type { BtwSessionApi } from "./useBtwSession";

/** Distance from the bottom within which the answer keeps auto-following. */
const FOLLOW_SLACK_PX = 48;

/**
 * BTW body, shared by the floating window and the docked side-panel tab.
 *
 * The Runtime holds a single slot: a new question replaces the previous round
 * (it is not a multi-turn side chat). `/btw` in the main composer still works;
 * the field here is the same ask, so the operator does not have to leave the
 * window to ask again.
 */
export function BtwPanel({
  session,
  demo,
  onDemoNext,
}: {
  session: BtwSessionApi;
  demo?: boolean;
  /** Preview only: walk the fixture rounds. Local UI, never a Host call. */
  onDemoNext?: () => void;
}) {
  const snapshot = session.snapshot;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const roundId = snapshot?.ephemeralId ?? null;

  const { t } = useI18n();
  const text = snapshot?.text ?? "";
  useEffect(() => {
    followRef.current = true;
  }, [roundId]);

  useEffect(() => {
    const node = bodyRef.current;
    if (node === null || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [text]);

  const onScroll = () => {
    const node = bodyRef.current;
    if (node === null) return;
    followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX;
  };

  return (
    <div className="btw-panel">
      {session.historyAvailable ? <div className="btw-history-toolbar">
        <select disabled={session.snapshot?.status === "running"} className="select" aria-label={t("runtimeUpgrade.btwHistory")} value={session.selectedTopicId ?? ""} onChange={event => { if (event.target.value) void session.selectTopic?.(event.target.value); else session.newTopic?.(); }}>
          <option value="">{t("runtimeUpgrade.btwNew")}</option>
          {session.topics?.map(topic => <option key={topic.topicId} value={topic.topicId}>{topic.question} ({topic.turnCount})</option>)}
        </select>
        <button className="btn small" disabled={session.snapshot?.status === "running"} onClick={() => session.newTopic?.()}>{t("runtimeUpgrade.btwNew")}</button>
        <button className="btn small" onClick={() => void session.refreshHistory?.()}>{t("common.refresh")}</button>
      </div> : null}
      {session.question === "" || (session.turns?.length ?? 0) > 0 ? null : (
        <div className="btw-question" data-tip={session.question}>
          <Icon name="asterisk" extra="sm" />
          <span className="btw-question-text">{session.question}</span>
        </div>
      )}
      <div className="btw-body" ref={bodyRef} onScroll={onScroll}>
        {session.turns?.filter((turn, index, turns) => index !== turns.length - 1 || turn.answer !== snapshot?.text).map((turn, index) => <div key={index} className="btw-history-turn"><p className="btw-question">{turn.question}</p><MarkdownText text={turn.answer} /></div>)}
        {(session.turns?.length ?? 0) > 0 && session.question ? <p className="btw-question">{session.question}</p> : null}
        {snapshot === null ? (
          <div className="empty">
            <Icon name="sparkles" extra="lg" />
            <p>还没有 BTW 问答</p>
            <p className="muted small">
              {t("runtimeUpgrade.btwEmpty")}
            </p>
          </div>
        ) : text === "" && snapshot.status === "running" ? (
          <p className="muted small">等待 Runtime 回答…</p>
        ) : (
          <MarkdownText text={text} {...(snapshot.status === "running" ? { streaming: true } : {})} />
        )}
        {snapshot?.error === undefined ? null : (
          <p className="btw-error small">{snapshot.error.message}</p>
        )}
      </div>
      {session.error === undefined ? null : <p className="btw-error small">{session.error}</p>}
      {session.notice === undefined ? null : (
        <button type="button" className="btw-notice small" onClick={session.dismissNotice}>
          {session.notice}
        </button>
      )}
      <div className="btw-acts">
        <button
          type="button"
          className="btn ghost small"
          disabled={!session.canAbort}
          data-tip={session.canAbort ? "中止" : "无回答"}
          onClick={() => void session.abort()}
        >
          <Icon name="stop" extra="sm" />中止
        </button>
        <button
          type="button"
          className="btn ghost small"
          disabled={text === ""}
          data-tip={text === "" ? t("btw.noContent") : t("common.copy")}
          onClick={() => void session.copy()}
        >
          <Icon name="copy" extra="sm" />{t("common.copy")}
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn small"
          disabled={!session.canBranch || session.pending}
          {...(session.branchBlockedReason === undefined ? {} : { "data-tip": session.branchBlockedReason })}
          onClick={() => void session.branch()}
        >
          <Icon name="branch" extra="sm" />{t("btw.branchToNewSession")}
        </button>
        {demo !== true ? null : onDemoNext === undefined ? (
          <span className="chip gray xs">{t("common.demo")}</span>
        ) : (
          <button type="button" className="chip gray xs btw-demo-next" data-tip={t("common.demo")} onClick={onDemoNext}>
            {t("common.demo")}
          </button>
        )}
      </div>
      <BtwComposer session={session} />
    </div>
  );
}

function BtwComposer({ session }: { session: BtwSessionApi }) {
  const { t } = useI18n();
  const inputId = useId();
  const sending = session.pending;
  const draft = session.draft;
  const ready = draft.trim().length > 0 && !sending && session.snapshot?.status !== "running";
  const running = session.snapshot?.status === "running";

  const submit = async (): Promise<void> => {
    if (!ready) return;
    const ok = await session.ask(draft);
    if (ok) session.setDraft("");
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <form className="btw-compose" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor={inputId}>{t("btw.questionLabel")}</label>
      <textarea
        id={inputId}
        className="btw-compose-input"
        rows={2}
        placeholder={running ? t("runtimeUpgrade.btwWait") : session.selectedTopicId ? t("runtimeUpgrade.btwFollow") : t("btw.placeholder")}
        value={draft}
        disabled={sending}
        onChange={(event) => session.setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="icon-btn small btw-compose-send"
        disabled={!ready}
        data-tip={running ? t("runtimeUpgrade.btwWait") : t("common.send")}
        aria-label={t("common.send")}
      >
        <Icon name="send" extra="sm" />
      </button>
    </form>
  );
}
