import { useSurfaceDocument } from "../dock/SurfaceContext";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MarkdownText } from "../conversation/markdown";
import { useI18n } from "../i18n";
import type { GitHubReferenceSnapshot } from "./githubReference";
import type { GitCommitReferenceSnapshot } from "./gitCommitReference";
import { browserReferenceSnapshot, type BrowserReferenceSnapshot } from "./browserReference";
import "./githubReference.css";

export function GitHubReferencePreview({ reference, onClose, onSaveBrowser }: { reference: GitHubReferenceSnapshot | GitCommitReferenceSnapshot | BrowserReferenceSnapshot; onClose: () => void; onSaveBrowser?: (reference: BrowserReferenceSnapshot) => void }) {
  const document = useSurfaceDocument();
  const dialog = useRef<HTMLDialogElement>(null);
  const { t, resolvedLanguage } = useI18n();
  const [note, setNote] = useState(reference.kind === "browser" ? reference.element.note : "");
  const title = reference.kind === "browser" ? resolvedLanguage === "zh" ? "网页元素引用" : "Page element reference" : reference.kind === "commit" ? resolvedLanguage === "zh" ? "Git 提交引用" : "Git commit reference" : t("github.reference");
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal?.();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="github-reference-dialog" aria-label={title} onCancel={onClose}>
    <header><strong>{title}</strong>{reference.kind !== "commit" ? <a href={reference.url} target="_blank" rel="noreferrer">{reference.kind === "browser" ? resolvedLanguage === "zh" ? "打开网页" : "Open page" : t("github.openGithub")}</a> : null}<button type="button" className="btn small outline" onClick={onClose}>{t("common.close")}</button></header>
    <div className="github-reference-content"><MarkdownText text={reference.text} /></div>
    {reference.kind === "browser" && onSaveBrowser ? <div className="browser-reference-note"><label>{resolvedLanguage === "zh" ? "备注" : "Note"}<textarea className="input" value={note} onChange={event => setNote(event.target.value)} /></label><button type="button" className="btn small primary" onClick={() => { onSaveBrowser(browserReferenceSnapshot({ ...reference.element, note })); onClose(); }}>{resolvedLanguage === "zh" ? "保存备注" : "Save note"}</button></div> : null}
  </dialog>, document.body);
}
