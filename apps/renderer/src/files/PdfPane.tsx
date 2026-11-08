import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { EventBus, PDFViewer, PDFLinkService, PDFFindController } from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";

type Bookmark = { title: string; dest: string | unknown[] | null; items: Bookmark[] };
export default function PdfPane({ url, initialPage = 1, onPage }: { url: string; initialPage?: number | undefined; onPage: (page: number) => void }) {
  const container = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null);
  const api = useRef<{ viewer: PDFViewer; bus: EventBus; links: PDFLinkService } | null>(null);
  const callback = useRef(onPage); callback.current = onPage;
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
    bus.on("updatefindmatchescount", (event: { matchesCount: { current: number; total: number } }) => setMatches(`${event.matchesCount.current} / ${event.matchesCount.total}`));
    void task.promise.then(async pdf => {
      if (disposed) return;
      setPages(pdf.numPages); setError(""); viewer.setDocument(pdf); links.setDocument(pdf); setNeedsPassword(false);
      const entries = await pdf.getOutline(); if (!disposed) setBookmarks((entries ?? []) as Bookmark[]);
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : String(error)); });
    const resize = new ResizeObserver(() => { if (viewer.pdfDocument) viewer.update(); }); resize.observe(container.current!);
    return () => { disposed = true; resize.disconnect(); viewer.setDocument(null); links.setDocument(null); api.current = null; void task.destroy().finally(() => { pdfWorker.destroy(); nativeWorker.terminate(); }).catch(() => {}); };
  }, [url]);
  const navigate = (next: number) => { if (api.current && pages) api.current.viewer.currentPageNumber = Math.max(1, Math.min(pages, next)); };
  const search = (previous = false) => api.current?.bus.dispatch("find", { source: container.current, type: "again", query, phraseSearch: true, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous });
  const entries = (items: Bookmark[]) => <ol>{items.map((item, index) => <li key={index}><button onClick={() => { if (item.dest) void api.current?.links.goToDestination(item.dest); }}>{item.title}</button>{item.items.length ? entries(item.items) : null}</li>)}</ol>;
  return <div className="file-pdf">
    <div className="file-toolbar"><button className="btn small outline" disabled={!bookmarks.length} onClick={() => setOutline(value => !value)}>目录</button><button className="btn small outline" disabled={page <= 1} onClick={() => navigate(page - 1)}>上一页</button><input aria-label="PDF 页码" type="number" min="1" max={pages || 1} value={page} onChange={event => navigate(Number(event.target.value))} /><span>/ {pages || "…"}</span><button className="btn small outline" disabled={page >= pages} onClick={() => navigate(page + 1)}>下一页</button><button className="btn small outline" onClick={() => api.current?.viewer.decreaseScale()}>−</button><button className="btn small outline" onClick={() => api.current?.viewer.increaseScale()}>＋</button><button className="btn small outline" onClick={() => { if (api.current) api.current.viewer.currentScaleValue = "page-width"; }}>适合宽度</button><input className="file-search" aria-label="搜索 PDF" placeholder="搜索文档" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") search(event.shiftKey); }} /><button className="btn small outline" onClick={() => search()}>查找</button><span>{matches}</span></div>
    {error ? <p className="file-error" role="alert">{error}</p> : null}
    {needsPassword ? <form className="file-empty" onSubmit={event => { event.preventDefault(); passwordCallback.current?.(password); setPassword(""); }}><p>此 PDF 需要密码</p><input type="password" aria-label="PDF 密码" value={password} onChange={event => setPassword(event.target.value)} /><button className="btn primary" type="submit">打开</button></form> : null}
    <div className="file-pdf-main">{outline ? <nav className="file-pdf-outline" aria-label="文档目录">{entries(bookmarks)}</nav> : null}<div className="file-pdf-area"><div ref={container} className="file-pdf-container"><div ref={body} className="pdfViewer" /></div></div></div>
  </div>;
}
