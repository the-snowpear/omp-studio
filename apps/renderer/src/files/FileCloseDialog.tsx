import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { dirtyFileDocuments, subscribeDirtyFiles, type FileDocument } from "./fileDocuments";

type Request = { documents: FileDocument[]; resolve: (allow: boolean) => void };
const queue: Request[] = [];
const listeners = new Set<() => void>();
export function requestFileClose(documents: FileDocument[]): Promise<boolean> {
  const dirty = [...new Set(documents)].filter(item => item.getSnapshot().dirty);
  if (!dirty.length) return Promise.resolve(true);
  return new Promise(resolve => { queue.push({ documents: dirty, resolve }); for (const listener of listeners) listener(); });
}
export function FileCloseDialog() {
  const [, update] = useState(0), [saving, setSaving] = useState(false), [error, setError] = useState("");
  useEffect(() => { const changed = () => update(value => value + 1); listeners.add(changed); return () => { listeners.delete(changed); }; }, []);
  useEffect(() => {
    const api = globalThis.ompStudioChrome?.files;
    if (!api) return;
    const report = () => { void api.setDirty(dirtyFileDocuments().length); };
    report(); const off = subscribeDirtyFiles(report);
    const close = api.onCloseRequested(id => { void requestFileClose(dirtyFileDocuments()).then(allow => api.finishClose(id, allow)); });
    return () => { off(); close(); };
  }, []);
  const active = queue[0];
  const settle = (allow: boolean) => { const pending = queue.splice(0); for (const item of pending) item.resolve(allow); setError(""); update(value => value + 1); };
  useEffect(() => {
    let allowed = false;
    const before = (event: BeforeUnloadEvent) => {
      const dirty = dirtyFileDocuments();
      if (allowed || !dirty.length) return;
      event.preventDefault(); event.returnValue = "";
      void requestFileClose(dirty).then(value => { if (value) { allowed = true; window.close(); } });
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);
  if (!active) return null;
  const documents = [...new Set(queue.flatMap(item => item.documents))];
  return createPortal(<div className="file-dialog-backdrop"><section className="file-dialog" role="dialog" aria-modal="true" aria-label="保存文件修改">
    <h3>保存文件修改？</h3><p>以下文件有未保存的内容：</p><ul>{documents.map((item, index) => <li key={index}>{item.getSnapshot().file.path}</li>)}</ul>
    {error ? <p role="alert">{error}</p> : null}
    <footer><button className="btn outline" disabled={saving} onClick={() => settle(false)}>取消</button><button className="btn outline" disabled={saving} onClick={() => { for (const item of documents) item.discard(); settle(true); }}>不保存</button><button className="btn primary" disabled={saving} onClick={() => { setSaving(true); void Promise.all(documents.map(item => item.save())).then(results => { if (results.every(Boolean)) settle(true); else setError("部分文件未保存，请返回文件窗口处理冲突或连接问题。"); }).finally(() => setSaving(false)); }}>{saving ? "正在保存…" : "保存"}</button></footer>
  </section></div>, document.body);
}
