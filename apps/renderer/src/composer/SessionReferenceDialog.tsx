import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { AppSelect } from "../AppSelect";
import { hostErrorMessage } from "../hostError";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { MarkdownText } from "../conversation/markdown";
import { sessionCopyMessage, useSessionReferences, writeSessionId } from "./SessionReferences";
import { sessionSourceKey, SESSION_REFERENCE_MESSAGE_LIMIT, type SessionReference, type SessionReferenceMessage, type SessionReferenceSource } from "./sessionReference";

function messageMatches(left: SessionReferenceMessage, right: SessionReferenceMessage): boolean {
  return left.role === right.role && left.text === right.text && left.truncated === right.truncated;
}

function excerptRows(recent: readonly SessionReferenceMessage[], saved: readonly SessionReferenceMessage[]) {
  const remaining = [...saved];
  const rows = recent.map(message => {
    const savedIndex = remaining.findIndex(previous => messageMatches(message, previous));
    return savedIndex < 0 ? message : remaining.splice(savedIndex, 1)[0]!;
  });
  return [...remaining, ...rows];
}

type ReadState = { key: string; messages?: readonly SessionReferenceMessage[]; error?: string };

export function SessionReferenceDialog({ reference, initialSources, onSave, onClose }: {
  reference: SessionReference;
  initialSources?: readonly SessionReferenceSource[] | undefined;
  onSave?: (reference: SessionReference) => void;
  onClose: () => void;
}) {
  const actions = useSessionReferences();
  const actionRef = useRef(actions);
  actionRef.current = actions;
  const document = useSurfaceDocument();
  const { t, resolvedLanguage } = useI18n();
  const currentLanguage = useRef(resolvedLanguage);
  currentLanguage.current = resolvedLanguage;
  const { preview, marks } = usePreviewMode();
  const labelId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [matches, setMatches] = useState(initialSources);
  const [source, setSource] = useState(reference.source);
  const [selected, setSelected] = useState(reference.messages);
  const [saved, setSaved] = useState(reference.messages);
  const [read, setRead] = useState<ReadState>();
  const [reload, setReload] = useState(0);
  const [copy, setCopy] = useState<Awaited<ReturnType<typeof writeSessionId>>>();
  const [openError, setOpenError] = useState<string>();
  const editable = onSave !== undefined;
  const available = !!source && actions?.available(source) === true;
  const sourceKey = source ? sessionSourceKey(source) : "";
  const conversationTitle = t("sessionReference.title");
  const currentRead = read?.key === sourceKey ? read : undefined;
  const loaded = currentRead?.messages !== undefined;
  const title = source
    ? actions?.previewTitle(source, resolvedLanguage === "zh") || source.title
    : undefined;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal?.();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [document]);

  useEffect(() => {
    const access = actionRef.current;
    if (source || !access || initialSources) return;
    let current = true;
    void access.locate(reference.sessionId).then(found => {
      if (!current) return;
      setMatches(found);
      if (found.length === 1) setSource(found[0]);
    }, () => { if (current) setMatches([]); });
    return () => { current = false; };
  }, [initialSources, reference.sessionId, source, reload]);

  useEffect(() => {
    const access = actionRef.current;
    if (!editable || !available || !access || !source || loaded) return;
    const controller = new AbortController();
    setRead({ key: sourceKey });
    void access.read(reference.sessionId, source, currentLanguage.current === "zh", controller.signal).then(
      messages => { if (!controller.signal.aborted) setRead({ key: sourceKey, messages }); },
      error => { if (!controller.signal.aborted) setRead({ key: sourceKey, error: hostErrorMessage(error, "") }); },
    );
    return () => controller.abort();
  }, [editable, available, sourceKey, reference.sessionId, source, reload, loaded]);

  const rows = editable ? excerptRows(currentRead?.messages ?? [], saved) : reference.messages;
  const changeSource = (key: string) => {
    setSource(matches?.find(match => sessionSourceKey(match) === key));
    if (editable && source) {
      setSelected([]);
      setSaved([]);
    }
    setOpenError(undefined);
  };
  const toggle = (message: SessionReferenceMessage) => {
    setSelected(previous => previous.includes(message)
      ? previous.filter(row => row !== message)
      : [...previous, message]);
  };
  const open = () => {
    if (!actions || !source) return;
    setOpenError(undefined);
    void actions.open(reference.sessionId, source).then(onClose, error => {
      setOpenError(hostErrorMessage(error, ""));
    });
  };
  const emptyText = editable
    ? t("sessionReference.noMessages")
    : t("sessionReference.idOnly");

  return createPortal(<dialog ref={dialog} role="dialog" className="session-reference-dialog" aria-labelledby={labelId} onCancel={onClose}>
    <header className="session-reference-header">
      <div className="session-reference-heading-icon"><Icon name="message" /></div>
      <div className="session-reference-heading">
        {title || (preview && marks) ? <div className="session-reference-kicker">
          {title ? conversationTitle : null}
          {preview && marks ? <span className="chip gray xs">{t("common.demo")}</span> : null}
        </div> : null}
        <h2 id={labelId}>{title || conversationTitle}</h2>
      </div>
      <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={onClose}><Icon name="x" /></button>
    </header>
    <div className="session-reference-origin">
      <div className="session-reference-id">
        <code>{reference.sessionId}</code>
        <button type="button" className="icon-btn" aria-label={t("sessionReference.copy")} data-tip={t("sessionReference.copy")}
          onClick={() => {
            const result = actions
              ? actions.copy({ sessionId: reference.sessionId, source }, document, false)
              : writeSessionId(document, reference.sessionId);
            void result.then(setCopy);
          }}>
          <Icon name={copy?.code === "copied" ? "check" : "copy"} extra="sm" />
        </button>
      </div>
      <div className="session-reference-origin-actions">
        {matches && matches.length > 1 ? <AppSelect
          aria-label={t("sessionReference.chooseSource")}
          value={sourceKey}
          placeholder={t("sessionReference.chooseSource")}
          onChange={event => changeSource(event.target.value)}
        >{matches.map(match => <option key={sessionSourceKey(match)} value={sessionSourceKey(match)}>
          {[actions?.environmentName(match.targetId), match.workspaceName, match.title].filter(Boolean).join(" · ")}
        </option>)}</AppSelect> : source ? <span className="session-reference-source">
          <Icon name={source.targetId === null ? "folder" : "server"} extra="sm" />
          {[actions?.environmentName(source.targetId), source.workspaceName].filter(Boolean).join(" · ")}
        </span> : <span className="session-reference-muted" role="status">
          {matches === undefined && actions ? t("sessionReference.locating") : t("sessionReference.notFound")}
        </span>}
        {source ? <button type="button" className="btn small outline" disabled={!available} onClick={open}>
          <Icon name="external" extra="sm" />{t("sessionReference.open")}
        </button> : null}
      </div>
      {copy ? <div className="session-reference-muted" role="status">{sessionCopyMessage(copy, t)}</div> : null}
      {openError !== undefined ? <div className="session-reference-error" role="alert">{t("sessionReference.openFailed")}{openError ? " · " + openError : ""}</div> : null}
    </div>
    <section className="session-reference-excerpts" aria-label={t(editable ? "sessionReference.recent" : "sessionReference.excerpts")}>
      <div className="session-reference-section-heading">
        <strong>{t(editable ? "sessionReference.recent" : "sessionReference.excerpts")}</strong>
        {editable && selected.length > 0 ? <button type="button" className="btn small ghost"
          onClick={() => setSelected([])}>{t("sessionReference.clear")}</button> : null}
      </div>
      {source && !available ? <p className="session-reference-muted" role="status">{t("sessionReference.sourceUnavailable")}</p> : null}
      {editable && available && !currentRead?.messages && currentRead?.error === undefined
        ? <p className="session-reference-muted" role="status">{t("sessionReference.loading")}</p> : null}
      {currentRead?.error !== undefined ? <div className="session-reference-read-error">
        <span role="status">{t("sessionReference.readFailed")}{currentRead.error ? " · " + currentRead.error : ""}</span>
        <button type="button" className="btn small outline" onClick={() => setReload(count => count + 1)}>{t("sessionReference.retry")}</button>
      </div> : null}
      {rows.length === 0 && (!editable || currentRead?.messages) ? <p className="session-reference-muted">{emptyText}</p> : null}
      {rows.map((message, index) => {
        const checked = selected.includes(message);
        const excerpt = <div className="session-reference-excerpt">
          <div className="session-reference-excerpt-role">
            <Icon name={message.role === "user" ? "user" : "bot"} extra="sm" />
            <span>{t("sessionReference." + message.role)}</span>
            {message.truncated ? <span className="session-reference-muted">{t("sessionReference.truncated")}</span> : null}
          </div>
          <div className="session-reference-excerpt-text"><MarkdownText text={message.text} staticPreview /></div>
        </div>;
        return editable ? <label key={index} className={"session-reference-row" + (checked ? " is-selected" : "")}>
          <input type="checkbox" checked={checked} aria-label={t("sessionReference.selectExcerpt", { index: index + 1 })}
            disabled={!checked && selected.length >= SESSION_REFERENCE_MESSAGE_LIMIT} onChange={() => toggle(message)} />
          {excerpt}
        </label> : <div key={index} className="session-reference-row">{excerpt}</div>;
      })}
    </section>
    <footer className="session-reference-footer">
      {editable ? <span className="session-reference-muted" aria-live="polite">
        {selected.length ? t("sessionReference.selected", { count: selected.length }) : t("sessionReference.idOnly")}
      </span> : null}
      <button type="button" className="btn outline" onClick={onClose}>{t(editable ? "common.cancel" : "common.close")}</button>
      {onSave ? <button type="button" className="btn primary" onClick={() => {
        onSave({ ...reference, source, messages: rows.filter(message => selected.includes(message)) });
        onClose();
      }}>{t("sessionReference.apply")}</button> : null}
    </footer>
  </dialog>, document.body);
}
