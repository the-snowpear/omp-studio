import { previewFile, previewFileBlob, previewOfficeState, subscribePreviewOffice } from "../preview/filesPreview";
import { lazy, Suspense, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import type { FileResource, OfficeComponentState } from "../../../desktop/src/file-viewer-shared";
const PdfPane = lazy(() => import("./PdfPane"));
export function OfficePane({ resource, preview, onSettings, initialPage, onPage }: { resource: FileResource | null; preview: boolean; onSettings: () => void; initialPage?: number | undefined; onPage: (page: number) => void }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const api = globalThis.ompStudioChrome?.files;
  const [state, setState] = useState<OfficeComponentState>({ id: "office-preview", status: "not-installed" });
  const [url, setUrl] = useState<string>(), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [stateError, setStateError] = useState(""), [checkingState, setCheckingState] = useState(true), [stateRetry, setStateRetry] = useState(0);
  useEffect(() => {
    if (preview) { setState(previewOfficeState()); setCheckingState(false); return subscribePreviewOffice(() => setState(previewOfficeState())); }
    if (!api) { setCheckingState(false); return; }
    let active = true;
    setCheckingState(true); setStateError("");
    const off = api.onOfficeState(next => { setState(next); setStateError(""); });
    void api.officeState().then(next => { if (active) { setState(next); setStateError(""); } })
      .catch(cause => { if (active) setStateError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setCheckingState(false); });
    return () => { active = false; off(); };
  }, [preview, api, stateRetry]);
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
  if (state.status === "unsupported") return <div className="file-empty file-office-install"><span className="file-badge is-large tone-blue" aria-hidden="true">DOC</span><h3>{zh ? "当前平台暂不支持 Office 预览" : "Office preview is unavailable on this platform"}</h3><p>{zh ? "可在文件菜单下载副本，再用 Office 应用打开。" : "Use the file menu to download a copy, then open it with an Office app."}</p></div>;
  if (!preview && !api) return <div className="file-empty file-office-install"><span className="file-badge is-large tone-blue" aria-hidden="true">DOC</span><h3>{zh ? "Office 预览仅在桌面端提供" : "Office preview is available in the desktop app"}</h3><p>{zh ? "请在桌面端打开此 Office 文档。" : "Open this Office document in the desktop app."}</p></div>;
  if (checkingState && !state.installedVersion) return <div className="file-empty"><span className="file-badge is-large tone-blue is-loading" aria-hidden="true">DOC</span><h3>{zh ? "正在检查 Office 组件…" : "Checking Office component…"}</h3></div>;
  if ((stateError || state.status === "error") && !state.installedVersion) return <div className="file-empty"><span className="file-badge is-large tone-red" aria-hidden="true">DOC</span><h3>{zh ? "无法读取 Office 组件状态" : "Could not read Office component status"}</h3><p role="alert">{stateError || state.message}</p><button className="btn outline" onClick={() => setStateRetry(value => value + 1)}>{zh ? "重试" : "Retry"}</button></div>;
  if (!state.installedVersion) return <div className="file-empty file-office-install"><span className="file-badge is-large tone-blue" aria-hidden="true">DOC</span><h3>{zh ? "安装 Office 文档预览组件" : "Install Office Document Preview"}</h3><p>{zh ? "在工作台中查看 Word 文档和 PowerPoint 幻灯片。组件单独下载，安装后可离线使用。" : "View Word documents and PowerPoint slides in the workbench. The component downloads separately and works offline."}</p><button className="btn primary" onClick={onSettings}>{zh ? "前往安装" : "Go to Install"}</button><small>{zh ? "Excel 和 CSV 已内置支持，无需安装此组件。" : "Excel and CSV support is built in and does not require this component."}</small></div>;
  if (error) return <div className="file-empty"><span className="file-badge is-large tone-red" aria-hidden="true">DOC</span><h3>{zh ? "文档转换失败" : "Document conversion failed"}</h3><p role="alert">{error}</p><button className="btn outline" onClick={() => setRetry(value => value + 1)}>{zh ? "重新转换" : "Retry conversion"}</button></div>;
  return url ? <Suspense fallback={<div className="file-empty">{zh ? "正在打开文档…" : "Opening document…"}</div>}><PdfPane url={url} initialPage={initialPage} onPage={onPage} /></Suspense> : <div className="file-empty"><span className="file-badge is-large tone-blue is-loading" aria-hidden="true">DOC</span><h3>{zh ? "正在准备文档预览…" : "Preparing document preview…"}</h3><p>{zh ? "读取文件并在本机转换为静态页面，首次打开可能需要一些时间。" : "Reading file and converting locally to static pages; first load may take a moment."}</p></div>;
}
