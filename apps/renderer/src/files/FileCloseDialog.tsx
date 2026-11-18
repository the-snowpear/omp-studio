import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { useI18n } from "../i18n";
import { dirtyFileDocuments, subscribeDirtyFiles, type FileDocument } from "./fileDocuments";

type Request = { documents: FileDocument[]; resolve: (allow: boolean) => void; doc?: Document | undefined };
const queue: Request[] = [];
const listeners = new Set<() => void>();
export function requestFileClose(documents: FileDocument[], doc?: Document): Promise<boolean> {
  const dirty = [...new Set(documents)].filter(item => item.getSnapshot().dirty);
  if (!dirty.length) return Promise.resolve(true);
  return new Promise(resolve => { queue.push({ documents: dirty, resolve, doc }); for (const listener of listeners) listener(); });
}
export function FileCloseDialog() {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const fallbackDoc = useSurfaceDocument();
  const [, update] = useState(0), [saving, setSaving] = useState(false), [error, setError] = useState("");
  useEffect(() => { const changed = () => update(value => value + 1); listeners.add(changed); return () => { listeners.delete(changed); }; }, []);
  useEffect(() => {
    const api = globalThis.ompStudioChrome?.files;
    if (!api) return;
    const report = () => { void api.setDirty(dirtyFileDocuments().length); };
    report(); const off = subscribeDirtyFiles(report);
    const close = api.onCloseRequested(id => { void requestFileClose(dirtyFileDocuments(), document).then(allow => api.finishClose(id, allow)); });
    return () => { off(); close(); };
  }, []);
  const active = queue[0];
  const portalDoc = active?.doc && !active.doc.defaultView?.closed && active.doc.body ? active.doc : fallbackDoc;
  const settle = (allow: boolean) => {
    const pending = queue.splice(0);
    for (const item of pending) {
      if (allow && item.documents.some(doc => doc.getSnapshot().dirty)) queue.push(item);
      else item.resolve(allow);
    }
    setError(""); update(value => value + 1);
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        event.stopPropagation();
        settleRef.current(false);
      }
    };
    portalDoc.addEventListener("keydown", onKeyDown);
    return () => portalDoc.removeEventListener("keydown", onKeyDown);
  }, [active, portalDoc, saving]);
  useEffect(() => {
    if (globalThis.ompStudioChrome?.files) return;
    const before = (event: BeforeUnloadEvent) => {
      if (!dirtyFileDocuments().length) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);
  if (!active) return null;
  const documents = [...new Set(queue.flatMap(item => item.documents))];
  return createPortal(<div className="file-dialog-backdrop"><section className="file-dialog" role="dialog" aria-modal="true" aria-label={zh ? "保存文件修改" : "Save file changes"}>
    <h3>{zh ? "保存文件修改？" : "Save changes to files?"}</h3><p>{zh ? "以下文件有未保存的内容：" : "The following files have unsaved changes:"}</p><ul>{documents.map((item, index) => <li key={index}>{item.getSnapshot().file.path}</li>)}</ul>
    {error ? <p role="alert">{error}</p> : null}
    <footer><button className="btn outline" disabled={saving} onClick={() => settle(false)}>{zh ? "取消" : "Cancel"}</button><button className="btn outline" disabled={saving} onClick={() => { for (const item of documents) item.discard(); settle(true); }}>{zh ? "不保存" : "Don't Save"}</button><button className="btn primary" disabled={saving} onClick={() => { setSaving(true); void Promise.all(documents.map(item => item.save())).then(results => { if (results.every(Boolean)) settle(true); else setError(zh ? "部分文件未保存，请返回文件窗口处理冲突或连接问题。" : "Some files could not be saved. Return to the file window to resolve conflicts or connection issues."); }).finally(() => setSaving(false)); }}>{saving ? (zh ? "正在保存…" : "Saving…") : (zh ? "保存" : "Save")}</button></footer>
  </section></div>, portalDoc.body);
}
