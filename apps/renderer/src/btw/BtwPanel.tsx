import { AppSelect } from "../AppSelect";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { ChipComposer, type ChipComposerHandle } from "../composer/ChipComposer";
import { DictationControl } from "../composer/DictationControl";
import type { ComposerSnapshot } from "../composer/types";
import { emptySnapshot, IMAGE_MIME_TYPES } from "../composer/types";
import { snapshotIsEmpty, snapshotFromTextAndImages } from "../composer/serialize";
import type { BtwHistoryTurn, PromptImageInput } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { MarkdownText } from "../conversation/markdown";
import { UserMessageBody } from "../conversation/UserMessageBody";
import { MessageCopyButton } from "../conversation/ConversationItemView";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import type { BtwSessionApi } from "./useBtwSession";
import { BtwStatusLine } from "./BtwStatusLine";

const FOLLOW_SLACK_PX = 48;
const BTW_IMAGE_ACCEPT = [...IMAGE_MIME_TYPES, ".svgz"].join(",");

/** Shared by floating and docked BTW; input attachments use the regular Composer capsules. */
export function BtwPanel({ session, demo, onDemoNext, onClose, visible = true }: { session: BtwSessionApi; demo?: boolean; onDemoNext?: () => void; onClose?: () => void; visible?: boolean }) {
  const snapshot = session.snapshot;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const roundId = snapshot?.ephemeralId ?? null;
  const { t, resolvedLanguage } = useI18n();
  const { marks } = usePreviewMode();
  const composer = useRef<ChipComposerHandle>(null);
  useEffect(() => { if (visible) void session.refreshHistory?.(); }, [visible, session.draftScope, session.historyAvailable]);
  const text = snapshot?.text ?? "";
  const running = snapshot?.status === "running";
  const anyRunning = session.running ?? running;
  const topics = session.topics ?? [];
  const topicLabel = snapshot?.title ?? session.question;
  const question = snapshot?.title && (snapshot.turnIndex ?? 0) === 0 ? snapshot.title : session.question;
  const historyTurns = session.turns?.filter((turn, index, turns) => snapshot?.turnIndex !== undefined ? index < snapshot.turnIndex : index !== turns.length - 1 || turn.answer !== snapshot?.text || turn.question !== session.question) ?? [];
  useEffect(() => { followRef.current = !roundId?.startsWith("history:"); if (!followRef.current && bodyRef.current) bodyRef.current.scrollTop = 0; }, [roundId]);
  useEffect(() => { const node = bodyRef.current; if (node && followRef.current) node.scrollTop = node.scrollHeight; }, [text]);
  const onScroll = () => { const node = bodyRef.current; if (node) followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX; };
  const shortcuts = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    if ((event.target as HTMLElement).closest("input, textarea, button, [contenteditable='true'], [role='combobox']")) return;
    const key = event.key.toLowerCase();
    if ((key === "f" || key === "enter") && session.canAsk !== false) composer.current?.focus();
    else if (key === "c" && session.canCopy !== false) void session.copy();
    else if (key === "x" && session.canAbort) void session.abort();
    else if (key === "b" && session.canBranch) void session.branch();
    else if (key === "escape" && onClose) onClose();
    else return;
    event.preventDefault(); event.stopPropagation();
  };
  return <div className="btw-panel btw-conversation" onKeyDown={shortcuts}>
    {session.historyAvailable || (demo && marks) ? <header className="btw-toolbar">
      {session.historyAvailable ? <div className="btw-topic-row">
        <Icon name="history" extra="sm btw-topic-icon" />
        <AppSelect disabled={session.pending} className="btw-topic-select" aria-label={t("runtimeUpgrade.btwHistory")} value={session.selectedTopicId ?? ""} onChange={event => { if (event.target.value) void session.selectTopic?.(event.target.value); else session.newTopic?.(); }}>
          <option value="">{!session.selectedTopicId && snapshot ? topicLabel || t("btw.currentTopic") : t("runtimeUpgrade.btwNew")}</option>
          {session.selectedTopicId && !topics.some(topic => topic.topicId === session.selectedTopicId) ? <option value={session.selectedTopicId}>{topicLabel || t("btw.currentTopic")}</option> : null}
          {topics.map(topic => <option key={topic.topicId} value={topic.topicId}>{topic.title ?? topic.question} · {t("btw.turnCount", { count: topic.turnCount })} · {t(historyStatusKey(topic.status))} · {new Date(topic.updatedAt).toLocaleDateString(resolvedLanguage)}</option>)}
        </AppSelect>
        <button type="button" className="btn ghost small btw-new-topic" disabled={anyRunning || session.pending} onClick={() => { session.newTopic?.(); composer.current?.focus(); }}><Icon name="plus" extra="sm" />{t("runtimeUpgrade.btwNew")}</button>
        <button type="button" className="icon-btn small" aria-label={t("common.refresh")} data-tip={t("common.refresh")} onClick={() => void session.refreshHistory?.()}><Icon name="refresh" extra="sm" /></button>
      </div> : null}
      {demo && marks ? onDemoNext ? <button type="button" className="chip gray xs btw-demo-next" onClick={onDemoNext}>{t("common.demo")}</button> : <span className="chip gray xs">{t("common.demo")}</span> : null}
    </header> : null}
    {anyRunning && session.activeTopicId && session.activeTopicId !== session.selectedTopicId ? <button type="button" className="btw-running-topic" onClick={() => void session.selectTopic?.(session.activeTopicId!)}><Icon name="asterisk" extra="sm" />{t("btw.backgroundAnswer")}</button> : null}
    <div className="btw-transcript" ref={bodyRef} onScroll={onScroll} tabIndex={0} aria-label={t("btw.conversation")}>
      {historyTurns.map((turn, index) => <article key={index} className="btw-turn">
        <BtwQuestion question={index === 0 ? topics.find(topic => topic.topicId === session.selectedTopicId)?.title ?? turn.question : turn.question} images={turn.images} createdAt={turn.createdAt} />
        <div className="ev ev-assistant">
          <div className="ev-head"><span className="who"><span className="role-badge a">π</span>OMP</span><HistoryStatus status={turn.status} /></div>
          <div className="ev-copy-host">
            <MarkdownText text={turn.answer} />
            <div className="ev-msg-actions"><MessageCopyButton text={turn.answer} /></div>
          </div>
          {turn.error ? <div className="ev-provider-error"><p className="ev-provider-error-text">{turn.error}</p></div> : null}
        </div>
      </article>)}
      {session.historyLoading ? <p role="status" className="muted small">{t("common.loading")}</p> : snapshot === null ? historyTurns.length === 0 ? <div className="btw-empty empty">
        <span className="btw-empty-icon"><Icon name="sparkles" extra="lg" /></span>
        <h3>{t("btw.emptyTitle")}</h3><p>{t("btw.emptyDescription")}</p>
        {session.historyAvailable && topics.length > 0 ? <span className="btw-empty-history">{t("runtimeUpgrade.btwEmpty")}</span> : null}
      </div> : null : <article className="btw-turn btw-current-turn">
        {question ? <BtwQuestion question={question} images={session.questionImages} createdAt={session.turns?.[snapshot.turnIndex ?? 0]?.createdAt ?? session.startedAt ?? undefined} /> : null}
        <div className="ev ev-assistant">
          <div className="ev-head"><span className="who"><span className="role-badge a">π</span>OMP</span>{session.historyStatus ? <HistoryStatus status={session.historyStatus} /> : <BtwStatusLine snapshot={snapshot} startedAt={session.startedAt} compact />}</div>
          <div className="ev-copy-host">
            {!text && running ? <div className="btw-thinking" aria-label={t("common.loading")}><span /><span /><span /></div> : <MarkdownText text={text} {...(running ? { streaming: true } : {})} />}
            {text || session.canCopy ? <div className="ev-msg-actions">
              <button type="button" className="ev-msg-copy" aria-label={t("common.copy")} data-tip={t("common.copy")} onClick={() => void session.copy()}><Icon name="copy" extra="sm" /></button>
              <button type="button" className="ev-msg-copy" aria-label={t("runtimeUpgrade.btwFollow")} disabled={session.canAsk === false} data-tip={t("runtimeUpgrade.btwFollow")} onClick={() => composer.current?.focus()}><Icon name="message" extra="sm" /></button>
              {session.branchAvailable !== false ? <button type="button" className="ev-msg-copy" aria-label={t("btw.branchToNewSession")} disabled={!session.canBranch || session.pending} data-tip={session.branchBlockedReason ?? t("btw.branchHint")} onClick={() => void session.branch()}><Icon name="branch" extra="sm" /></button> : null}
            </div> : null}
          </div>
          {snapshot.error ? <div role="alert" className="ev-provider-error"><p className="ev-provider-error-text">{snapshot.error.message}</p></div> : null}
        </div>
      </article>}
    </div>
    <div className="btw-compose-area">
      {session.error ? <p role="alert" className="btw-error small">{session.error}</p> : null}
      {session.notice ? <div className="btw-feedback" role="status"><span>{session.notice}</span><button type="button" className="icon-btn small" aria-label={t("common.close")} onClick={session.dismissNotice}><Icon name="x" extra="sm" /></button></div> : null}
      <BtwComposer session={session} visible={visible} composer={composer} onCancel={() => bodyRef.current?.focus()} />
    </div>
  </div>;
}

function BtwQuestion({ question, images, createdAt }: { question: string; images?: readonly PromptImageInput[] | undefined; createdAt?: number | undefined }) {
  const { resolvedLanguage } = useI18n();
  return <div className="ev ev-user">
    <div className="ev-head"><span className="who"><span className="role-badge u">S</span>{resolvedLanguage === "zh" ? "你" : "You"}</span>{createdAt !== undefined ? <time className="btw-turn-time" dateTime={new Date(createdAt).toISOString()}>{new Date(createdAt).toLocaleString(resolvedLanguage, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time> : null}</div>
    <UserMessageBody text={question} {...(images?.length ? { doc: snapshotFromTextAndImages(question, images).doc } : {})} magicKeywords copyText={question} actions={<div className="ev-msg-actions"><MessageCopyButton text={question} /></div>} />
  </div>;
}

function historyStatusKey(status: BtwHistoryTurn["status"]) {
  return status === "complete" ? "btw.statusCompleted" : status === "running" ? "btw.statusRunning" : status === "error" ? "btw.statusFailed" : status === "interrupted" ? "btw.statusInterrupted" : "btw.statusAborted";
}

function HistoryStatus({ status }: { status: BtwHistoryTurn["status"] }) {
  const { t } = useI18n();
  return <span className={`btw-history-status${status === "error" ? " is-error" : ""}`}>{t(historyStatusKey(status))}</span>;
}

function BtwComposer({ session, visible, composer, onCancel }: { session: BtwSessionApi; visible: boolean; composer: RefObject<ChipComposerHandle | null>; onCancel: () => void }) {
  const { t } = useI18n(); const inputId = useId();
  const [fallbackDraft, setFallbackDraft] = useState<ComposerSnapshot>(emptySnapshot);
  const [inputError, setInputError] = useState<string>();
  const [preparing, setPreparing] = useState(false);
  const submitting = useRef(false);
  const latestSession = useRef(session); latestSession.current = session;
  const draft = session.composerDraft ?? fallbackDraft;
  const localDraft = useRef<ComposerSnapshot | undefined>(undefined);
  const topic = session.selectedTopicId;
  const running = session.running ?? session.snapshot?.status === "running";
  const inputStatus = running ? t("btw.waitToSend") : preparing || session.pending || session.historyLoading ? t("common.loading") : session.canAsk === false ? t("btw.unavailable") : undefined;
  useEffect(() => {
    if (draft === localDraft.current) return;
    localDraft.current = draft;
    setInputError(undefined);
    composer.current?.setSnapshot(draft);
  }, [draft]);
  const ready = !snapshotIsEmpty(draft) && !session.pending && !preparing && !running && session.canAsk !== false;
  const cancel = () => { composer.current?.clear(); session.setDraft(""); setInputError(undefined); onCancel(); };
  const submit = async () => {
    if (submitting.current || session.pending || running || session.canAsk === false) return;
    submitting.current = true; setPreparing(true);
    try {
      if (await composer.current?.waitForAttachments?.() === false) return;
      const api = latestSession.current;
      const current = composer.current?.getSnapshot() ?? draft;
      if (snapshotIsEmpty(current) || api.pending || api.running || api.canAsk === false) return;
      if (await api.ask(current.text, false, [...current.images])) { composer.current?.clear(); api.setDraft(""); }
    } finally { submitting.current = false; setPreparing(false); }
  };
  const onSubmit = (event: FormEvent) => { event.preventDefault(); void submit(); };
  return <><form className="composer btw-composer" onSubmit={onSubmit}>
    <ChipComposer id={inputId} ariaLabel={t("btw.questionLabel")} {...(inputStatus ? { describedBy: `${inputId}-status` } : {})} fileAccept={BTW_IMAGE_ACCEPT} resolveImagePaste={session.resolveImagePaste} ref={composer} compact disabled={session.pending || preparing} slashCatalog={[]} placeholder={running ? t("btw.draftWhileRunning") : topic ? t("btw.followPlaceholder") : t("btw.inputPlaceholder")} onChange={next => { localDraft.current = next; setInputError(undefined); setFallbackDraft(next); if (session.setComposerDraft) session.setComposerDraft(next); else session.setDraft(next.text); }} onSubmit={() => void submit()} onEscape={cancel} onError={setInputError} />
    <div className="composer-bar">
      <button type="button" className="btn ghost small btw-image-button" aria-label={t("btw.attachImages")} data-tip={t("btw.imageHint")} disabled={session.pending} onClick={() => composer.current?.openFilePicker()}><Icon name="image" extra="sm" />{t("btw.images")}</button>
      <span className="spacer" />
      {!snapshotIsEmpty(draft) ? <button type="button" className="icon-btn small" aria-label={t("btw.discardDraft")} data-tip={t("btw.discardDraft")} disabled={session.pending} onClick={cancel}><Icon name="x" extra="sm" /></button> : null}
      <div className="cb-group">
        <DictationControl client={session.dictation?.client} sessionId={session.dictation?.sessionId} draftId={`${session.draftScope ?? "btw"}:${topic ?? "new"}`} label="BTW" available={session.dictation?.available === true && !session.pending && !preparing} visible={visible} composerRef={composer} onSubmit={() => void submit()} />
        {running ? <button key="stop" type="button" className="send-btn abort" aria-label={t("btw.stopAnswer")} data-tip={t("btw.stopAnswer")} disabled={!session.canAbort} onClick={() => void session.abort()}><Icon name="stop" extra="sm" /></button>
          : <button key="send" type="submit" className="send-btn" disabled={!ready} aria-label={t("common.send")} data-tip={t("btw.keyboardHint")}><Icon name="arrow-u" extra="sm" /></button>}
      </div>
    </div>
  </form>
    {inputStatus ? <p id={`${inputId}-status`} role="status" className="btw-compose-hint">{inputStatus}</p> : null}
    {inputError ? <p role="alert" className="btw-error small">{inputError}</p> : null}
  </>;
}
