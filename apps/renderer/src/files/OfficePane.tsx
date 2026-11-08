import { previewFile, previewFileBlob, previewOfficeState, subscribePreviewOffice } from "../preview/filesPreview";
import { lazy, Suspense, useEffect, useState } from "react";
import type { FileResource, OfficeComponentState } from "../../../desktop/src/file-viewer-shared";
const PdfPane = lazy(() => import("./PdfPane"));
export function OfficePane({ resource, preview, onSettings, initialPage, onPage }: { resource: FileResource | null; preview: boolean; onSettings: () => void; initialPage?: number | undefined; onPage: (page: number) => void }) {
  const [state, setState] = useState<OfficeComponentState>({ id: "office-preview", status: "not-installed" });
  const [url, setUrl] = useState<string>(), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (preview) { setState(previewOfficeState()); return subscribePreviewOffice(() => setState(previewOfficeState())); }
    const api = globalThis.ompStudioChrome?.files;
    if (!api) return;
    let active = true;
    void api.officeState().then(state => { if (active) setState(state); }).catch(error => { if (active) setError(String(error)); });
    const off = api.onOfficeState(setState); return () => { active = false; off(); };
  }, [preview]);
  useEffect(() => {
    if (preview && state.installedVersion) {
      let active = true, blob: string | undefined;
      void previewFileBlob(previewFile("preview.pdf", "preview")).then(value => { if (value && active) { blob = URL.createObjectURL(value); setUrl(blob); } });
      return () => { active = false; if (blob) URL.revokeObjectURL(blob); };
    }
    if (!resource || preview || !state.installedVersion) return;
    let active = true; setUrl(undefined); setError("");
    void globalThis.ompStudioChrome!.files!.officePreview(resource.id).then(result => { if (active) setUrl(result.url); }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [resource?.id, state.installedVersion, retry, preview]);
  if (!state.installedVersion) return <div className="file-empty file-office-install"><span className="file-badge is-large tone-blue" aria-hidden="true">DOC</span><h3>安装 Office 文档预览组件</h3><p>在工作台中查看 Word 文档和 PowerPoint 幻灯片。组件单独下载，安装后可离线使用。</p><button className="btn primary" onClick={onSettings}>前往安装</button><small>Excel 和 CSV 已内置支持，无需安装此组件。</small></div>;
  if (error) return <div className="file-empty"><span className="file-badge is-large tone-red" aria-hidden="true">DOC</span><h3>文档转换失败</h3><p role="alert">{error}</p><button className="btn outline" onClick={() => setRetry(value => value + 1)}>重新转换</button></div>;
  return url ? <Suspense fallback={<div className="file-empty">正在打开文档…</div>}><PdfPane url={url} initialPage={initialPage} onPage={onPage} /></Suspense> : <div className="file-empty"><span className="file-badge is-large tone-blue is-loading" aria-hidden="true">DOC</span><h3>正在准备文档预览…</h3><p>读取文件并在本机转换为静态页面，首次打开可能需要一些时间。</p></div>;
}
