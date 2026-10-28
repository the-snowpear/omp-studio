import { AppSelect } from "../AppSelect";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ChipComposer, type ChipComposerHandle } from "../composer/ChipComposer";
import type { ComposerSnapshot } from "../composer/types";
import { emptySnapshot } from "../composer/types";
import { snapshotIsEmpty } from "../composer/serialize";
import { Icon } from "../icons";
import { MarkdownText } from "../conversation/markdown";
import { useI18n } from "../i18n";
import type { BtwSessionApi } from "./useBtwSession";

const FOLLOW_SLACK_PX = 48;

/** Shared by floating and docked BTW; input attachments use the regular Composer capsules. */
export function BtwPanel({ session, demo, onDemoNext }: { session: BtwSessionApi; demo?: boolean; onDemoNext?: () => void }) {
  const snapshot = session.snapshot;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const roundId = snapshot?.ephemeralId ?? null;
  const { t } = useI18n();
  const text = snapshot?.text ?? "";
  useEffect(() => { followRef.current = true; }, [roundId]);
  useEffect(() => { const node = bodyRef.current; if (node && followRef.current) node.scrollTop = node.scrollHeight; }, [text]);
  const onScroll = () => { const node = bodyRef.current; if (node) followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX; };
  return <div className="btw-panel">
    {session.historyAvailable ? <div className="btw-history-toolbar">
      <AppSelect disabled={snapshot?.status === "running"} className="select" aria-label={t("runtimeUpgrade.btwHistory")} value={session.selectedTopicId ?? ""} onChange={event => { if (event.target.value) void session.selectTopic?.(event.target.value); else session.newTopic?.(); }}><option value="">{t("runtimeUpgrade.btwNew")}</option>{session.topics?.map(topic => <option key={topic.topicId} value={topic.topicId}>{topic.title ?? topic.question} ({topic.turnCount})</option>)}</AppSelect>
      <button className="btn small" disabled={snapshot?.status === "running"} onClick={() => session.newTopic?.()}>{t("runtimeUpgrade.btwNew")}</button><button className="btn small" onClick={() => void session.refreshHistory?.()}>{t("common.refresh")}</button>
    </div> : null}
    {snapshot?.title ? <h3 className="btw-question">{snapshot.title}</h3> : session.question && !(session.turns?.length) ? <div className="btw-question" data-tip={session.question}><Icon name="asterisk" extra="sm" /><span className="btw-question-text">{session.question}</span></div> : null}
    <div className="btw-body" ref={bodyRef} onScroll={onScroll}>
      {session.turns?.filter((turn, index, turns) => index !== turns.length - 1 || turn.answer !== snapshot?.text).map((turn, index) => <div key={index} className="btw-history-turn"><p className="btw-question">{turn.question}</p><MarkdownText text={turn.answer} /></div>)}
      {(session.turns?.length ?? 0) > 0 && session.question ? <p className="btw-question">{session.question}</p> : null}
      {snapshot === null ? <div className="empty"><Icon name="sparkles" extra="lg" /><p>{t("runtimeUpgrade.btwEmpty")}</p></div> : !text && snapshot.status === "running" ? <p role="status" className="muted small">{t("common.loading")}</p> : <MarkdownText text={text} {...(snapshot.status === "running" ? { streaming: true } : {})} />}
      {snapshot?.error ? <p className="btw-error small">{snapshot.error.message}</p> : null}
    </div>
    {session.error ? <p className="btw-error small">{session.error}</p> : null}{session.notice ? <button type="button" className="btw-notice small" onClick={session.dismissNotice}>{session.notice}</button> : null}
    <div className="btw-acts">
      <button type="button" className="btn ghost small" disabled={!session.canAbort} onClick={() => void session.abort()}><Icon name="stop" extra="sm" />{t("common.cancel")}</button>
      <button type="button" className="btn ghost small" disabled={!text} onClick={() => void session.copy()}><Icon name="copy" extra="sm" />{t("common.copy")}</button><span className="spacer" />
      <button type="button" className="btn small" disabled={!session.canBranch || session.pending} {...(session.branchBlockedReason ? { "data-tip": session.branchBlockedReason } : {})} onClick={() => void session.branch()}><Icon name="branch" extra="sm" />{t("btw.branchToNewSession")}</button>
      {demo ? onDemoNext ? <button type="button" className="chip gray xs btw-demo-next" onClick={onDemoNext}>{t("common.demo")}</button> : <span className="chip gray xs">{t("common.demo")}</span> : null}
    </div>
    <BtwComposer session={session} />
  </div>;
}

function BtwComposer({ session }: { session: BtwSessionApi }) {
  const { t } = useI18n(); const inputId = useId();
  const composer = useRef<ChipComposerHandle>(null);
  const [draft, setDraft] = useState<ComposerSnapshot>(emptySnapshot);
  const topic = session.selectedTopicId;
  useEffect(() => { composer.current?.clear(); setDraft(emptySnapshot()); }, [topic]);
  const ready = !snapshotIsEmpty(draft) && !session.pending && session.snapshot?.status !== "running";
  const submit = async () => {
    if (!ready) return;
    const current = composer.current?.getSnapshot() ?? draft;
    if (await session.ask(current.text, false, [...current.images])) { composer.current?.clear(); setDraft(emptySnapshot()); session.setDraft(""); }
  };
  const onSubmit = (event: FormEvent) => { event.preventDefault(); void submit(); };
  return <form className="btw-compose" onSubmit={onSubmit}>
    <label className="sr-only" htmlFor={inputId}>{t("btw.questionLabel")}</label>
    <ChipComposer id={inputId} ref={composer} compact disabled={session.pending} slashCatalog={[]} placeholder={session.snapshot?.status === "running" ? t("runtimeUpgrade.btwWait") : topic ? t("runtimeUpgrade.btwFollow") : t("btw.placeholder")} onChange={next => { setDraft(next); session.setDraft(next.text); }} onSubmit={() => void submit()} onError={() => {}} />
    <button type="button" className="icon-btn small" aria-label="添加附件 / Attach files" disabled={session.pending} onClick={() => composer.current?.openFilePicker()}><Icon name="plus" extra="sm" /></button>
    <button type="submit" className="icon-btn small btw-compose-send" disabled={!ready} aria-label={t("common.send")}><Icon name="send" extra="sm" /></button>
  </form>;
}
