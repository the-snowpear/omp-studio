import { useEffect, useRef, useState } from "react";
import type { BrowserElementReference, ManagedBrowserPage } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import type { BrowserSession, BrowserSessionSnapshot } from "./browserSessions";
import type { Copy } from "./BrowserToolbar";

const changed = (reference: BrowserElementReference, page: ManagedBrowserPage) => reference.url !== page.url || (!!reference.documentId && page.documentId !== undefined && page.documentId !== reference.documentId);

/** Elements picked on this page, waiting to become composer references. */
export function BrowserReferenceTray({ session, snap, page, copy, foreign, onReferences }: {
  session: BrowserSession; snap: BrowserSessionSnapshot; page: ManagedBrowserPage; copy: Copy; foreign: boolean;
  onReferences?: ((references: BrowserElementReference[]) => void) | undefined;
}) {
  const references = snap.references.filter(reference => reference.pageId === page.id);
  const [open, setOpen] = useState(true);
  const count = useRef(references.length);
  // A new pick reopens the tray so the note field is right there.
  useEffect(() => { if (references.length > count.current) setOpen(true); count.current = references.length; }, [references.length]);
  if (!references.length) return null;
  const blocked = foreign || !onReferences;
  return <section className="mb-tray" aria-label={copy("已选元素", "Selected elements")}>
    <header className="mb-tray-header">
      <button type="button" className="mb-tray-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <Icon name={open ? "chevron-d" : "chevron-r"} extra="sm" /><span>{copy(`已选 ${references.length} 个元素`, `${references.length} selected`)}</span>
      </button>
      <button type="button" className="btn small" onClick={() => session.clearReferences(page.id)}>{copy("清空", "Clear")}</button>
      <button type="button" className="btn small primary" disabled={blocked} data-tip={foreign ? copy("这个网页属于另一个对话", "This page belongs to another chat") : undefined}
        onClick={() => { if (!blocked) onReferences(session.takeReferences(page.id)); }}>{copy("加入输入框", "Add to composer")}</button>
    </header>
    {open ? <ul className="mb-tray-list">{references.map(reference => <li className="mb-ref" key={reference.id}>
      <div className="mb-ref-shot">{reference.screenshot ? <img src={`data:${reference.screenshot.mimeType};base64,${reference.screenshot.data}`} alt={copy("所选元素快照", "Selected element snapshot")} /> : <Icon name="cursor" extra="sm" />}</div>
      <div className="mb-ref-body">
        <code className="mb-ref-selector" title={reference.selector}>{reference.selector}</code>
        {reference.text ? <p className="mb-ref-text">{reference.text}</p> : null}
        {changed(reference, page) ? <p className="mb-ref-stale"><Icon name="info" extra="sm" />{copy("页面已变化，引用保留采集时的内容", "The page changed; the captured content is kept")}</p> : null}
        <input className="mb-ref-note" aria-label={copy(`备注：${reference.selector}`, `Note: ${reference.selector}`)} placeholder={copy("想怎么改？写给 Agent 的备注（可选）", "What should change? A note for the Agent (optional)")}
          value={reference.note} onChange={event => session.updateNote(reference.id, event.target.value)} />
      </div>
      <button type="button" className="icon-btn small" aria-label={copy("移除此元素", "Remove element")} data-tip={copy("移除", "Remove")} onClick={() => session.removeReference(reference.id)}><Icon name="x" extra="sm" /></button>
    </li>)}</ul> : null}
  </section>;
}
