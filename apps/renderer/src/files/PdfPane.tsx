import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { EventBus, PDFViewer, PDFLinkService, PDFFindController } from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { Icon } from "../icons";

type Bookmark = { title: string; dest: string | unknown[] | null; items: Bookmark[] };
export default function PdfPane({ url, initialPage = 1, onPage, onPages }: { url: string; initialPage?: number | undefined; onPage: (page: number) => void; onPages?: ((pages: number) => void) | undefined }) {
  const container = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null);
  const api = useRef<{ viewer: PDFViewer; bus: EventBus; links: PDFLinkService } | null>(null);
  const callback = useRef(onPage); callback.current = onPage;
  const pagesCallback = useRef(onPages); pagesCallback.current = onPages;
  const [scale, setScale] = useState(1), [pageInput, setPageInput] = useState<string | null>(null);
  const [pages, setPages] = useState(0), [page, setPage] = useState(initialPage), [error, setError] = useState(""), [query, setQuery] = useState("");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]), [outline, setOutline] = useState(false), [matches, setMatches] = useState("");
  const [password, setPassword] = useState(""), [needsPassword, setNeedsPassword] = useState(false);
  const passwordCallback = useRef<((value: string) => void) | null>(null);
  useEffect(() => {
    const bus = new EventBus(), links = new PDFLinkService({ eventBus: bus, externalLinkTarget: 2 });
    const find = new PDFFindController({ eventBus: bus, linkService: links });
    const viewer = new PDFViewer({ container: container.current!, viewer: body.current!, eventBus: bus, linkService: links, findController: find, textLayerMode: 1, annotationMode: pdfjs.AnnotationMode.ENABLE });
    links.setViewer(viewer); api.current = { viewer, bus, links };
    let disposed = false;
    const assets = new URL("pdfjs/", document.baseURI).href;
    const nativeWorker = new Worker(workerUrl, { type: "module" });
    const pdfWorker = pdfjs.PDFWorker.create({ port: nativeWorker });
    const task = pdfjs.getDocument({ url, worker: pdfWorker, cMapUrl: `${assets}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`, useWasm: false });
    task.onPassword = (update: (password: string) => void) => { passwordCallback.current = update; setNeedsPassword(true); };
    bus.on("pagesinit", () => { viewer.currentScaleValue = "page-width"; viewer.currentPageNumber = Math.min(initialPage, viewer.pagesCount); });
    bus.on("pagechanging", (event: { pageNumber: number }) => { setPage(event.pageNumber); callback.current(event.pageNumber); });
    bus.on("scalechanging", (event: { scale: number }) => setScale(event.scale));
    bus.on("updatefindmatchescount", (event: { matchesCount: { current: number; total: number } }) => setMatches(`${event.matchesCount.current} / ${event.matchesCount.total}`));
    void task.promise.then(async pdf => {
      if (disposed) return;
      setPages(pdf.numPages); pagesCallback.current?.(pdf.numPages); setError(""); viewer.setDocument(pdf); links.setDocument(pdf); setNeedsPassword(false);
      const entries = await pdf.getOutline(); if (!disposed) setBookmarks((entries ?? []) as Bookmark[]);
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : String(error)); });
    const resize = new ResizeObserver(() => { if (viewer.pdfDocument) viewer.update(); }); resize.observe(container.current!);
    return () => { disposed = true; resize.disconnect(); viewer.setDocument(null); links.setDocument(null); api.current = null; void task.destroy().finally(() => { pdfWorker.destroy(); nativeWorker.terminate(); }).catch(() => {}); };
  }, [url]);
  const navigate = (next: number) => { if (api.current && pages) api.current.viewer.currentPageNumber = Math.max(1, Math.min(pages, next)); };
  const search = (previous = false) => api.current?.bus.dispatch("find", { source: container.current, type: "again", query, phraseSearch: true, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous });
  const entries = (items: Bookmark[]) => <ol>{items.map((item, index) => <li key={index}><button onClick={() => { if (item.dest) void api.current?.links.goToDestination(item.dest); }}>{item.title}</button>{item.items.length ? entries(item.items) : null}</li>)}</ol>;
  return <div className="file-pdf">
    <div className="file-subbar">
      <button type="button" className={`icon-btn${outline ? " is-active" : ""}`} aria-pressed={outline} aria-label="目录" data-tip={bookmarks.length ? "目录" : "此文档没有目录"} disabled={!bookmarks.length} onClick={() => setOutline(value => !value)}><Icon name="tool-list" extra="sm" /></button>
      <span className="file-subbar-sep" />
      <span className="file-pager">
        <button type="button" aria-label="上一页" data-tip="上一页" disabled={page <= 1} onClick={() => navigate(page - 1)}><Icon name="chevron-u" extra="sm" /></button>
        <input aria-label="PDF 页码" inputMode="numeric" value={pageInput ?? String(page)} onFocus={event => { setPageInput(String(page)); event.currentTarget.select(); }} onChange={event => setPageInput(event.target.value.replace(/\D/g, ""))} onBlur={() => setPageInput(null)} onKeyDown={event => { if (event.key === "Enter") { navigate(Number(pageInput) || page); event.currentTarget.blur(); } }} />
        <span>/ {pages || "…"}</span>
        <button type="button" aria-label="下一页" data-tip="下一页" disabled={page >= pages} onClick={() => navigate(page + 1)}><Icon name="chevron-d" extra="sm" /></button>
      </span>
      <span className="file-zoom"><button type="button" aria-label="缩小" onClick={() => api.current?.viewer.decreaseScale()}>−</button><span>{Math.round(scale * 100)}%</span><button type="button" aria-label="放大" onClick={() => api.current?.viewer.increaseScale()}>+</button></span>
      <button type="button" className="icon-btn" aria-label="适合宽度" data-tip="适合宽度" onClick={() => { if (api.current) api.current.viewer.currentScaleValue = "page-width"; }}><Icon name="expand" extra="sm" /></button>
      <span className="file-subbar-spacer" />
      <label className="file-find"><Icon name="search" extra="sm" /><input aria-label="搜索 PDF" placeholder="在文档中查找" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") search(event.shiftKey); if (event.key === "Escape") setQuery(""); }} />{matches && query ? <span className="file-find-count">{matches}</span> : null}<button type="button" aria-label="上一个" data-tip="上一个（Shift Enter）" disabled={!query} onClick={() => search(true)}><Icon name="chevron-u" extra="sm" /></button><button type="button" aria-label="下一个" data-tip="下一个（Enter）" disabled={!query} onClick={() => search()}><Icon name="chevron-d" extra="sm" /></button></label>
    </div>
    {error ? <div className="file-banner is-error" role="alert"><Icon name="alert-c" extra="sm" /><span>{error}</span></div> : null}
    {needsPassword ? <form className="file-empty file-password" onSubmit={event => { event.preventDefault(); passwordCallback.current?.(password); setPassword(""); }}><span className="file-badge is-large tone-red" aria-hidden="true"><Icon name="lock" /></span><h3>此 PDF 受密码保护</h3><span className="file-password-row"><input type="password" aria-label="PDF 密码" placeholder="输入密码" autoFocus value={password} onChange={event => setPassword(event.target.value)} /><button className="btn small primary" type="submit">打开</button></span></form> : null}
    <div className="file-pdf-main">{outline ? <nav className="file-pdf-outline" aria-label="文档目录">{entries(bookmarks)}</nav> : null}<div className="file-pdf-area"><div ref={container} className="file-pdf-container"><div ref={body} className="pdfViewer" /></div></div></div>
  </div>;
}
