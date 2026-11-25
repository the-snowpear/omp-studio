import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { useMermaidSvg } from "../conversation/LazyMermaid";
import { Icon } from "../icons";
import "./diagrams.css";

type Zoom = "fit" | number;
type Image = { svg: string; url: string; width: number; height: number };
const MIN_ZOOM = .01, MAX_ZOOM = 8, STEP = 1.25;

/** Mermaid already produced strict SVG. Give its image an explicit natural size. */
function svgImage(svg: string): Image {
  const template = document.createElement("template");
  template.innerHTML = svg;
  const root = template.content.querySelector("svg")!;
  const [, , width, height] = root.getAttribute("viewBox")!.trim().split(/\s+/).map(Number);
  root.setAttribute("width", String(width)); root.setAttribute("height", String(height));
  root.style.removeProperty("max-width"); root.style.removeProperty("width"); root.style.removeProperty("height");
  const source = new XMLSerializer().serializeToString(root);
  return { svg, width: width!, height: height!, url: URL.createObjectURL(new Blob([source], { type: "image/svg+xml" })) };
}

export const DiagramViewer = memo(function DiagramViewer({ code, initialSvg, visible }: { code: string; initialSvg?: string | undefined; visible: boolean }) {
  const { t } = useI18n(), { preview, marks } = usePreviewMode();
  const host = useRef<HTMLDivElement>(null), viewportRef = useRef<HTMLDivElement>(null);
  const { svg, budget } = useMermaidSvg(code, visible, host, initialSvg);
  const [image, setImage] = useState<Image>();
  const [imageError, setImageError] = useState(false);
  const [zoom, setZoom] = useState<Zoom>(1), [source, setSource] = useState(false), [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const pan = useRef({ x: 0, y: 0 }), pendingPan = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    if (!svg) { setImage(undefined); return; }
    const next = svgImage(svg);
    setImage(next); setImageError(false);
    return () => URL.revokeObjectURL(next.url);
  }, [svg]);
  useEffect(() => { setZoom(1); setSource(false); pan.current = { x: 0, y: 0 }; }, [code]);
  const current = image?.svg === svg ? image : undefined;
  const failed = imageError || !svg && (svg === null || !budget.allowed);
  const showSource = source || !current || failed;
  const fit = current && viewport.width && viewport.height ? Math.min(1, viewport.width / current.width, viewport.height / current.height) : 1;
  const scale = zoom === "fit" ? fit : zoom;
  const canPan = !!current && (current.width * scale > viewport.width || current.height * scale > viewport.height);
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const read = () => setViewport(previous => previous.width === element.clientWidth && previous.height === element.clientHeight ? previous : { width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(read); observer.observe(element); read();
    return () => observer.disconnect();
  }, [showSource, current?.url]);
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const position = zoom === "fit" ? { x: 0, y: 0 } : pendingPan.current ?? pan.current;
    element.scrollLeft = Math.max(0, position.x); element.scrollTop = Math.max(0, position.y);
    pan.current = { x: element.scrollLeft, y: element.scrollTop }; pendingPan.current = null;
  }, [scale, zoom, current?.url, showSource]);

  const changeZoom = (next: Zoom, anchor?: { x: number; y: number }) => {
    const element = viewportRef.current;
    if (!element || !current) return;
    const nextScale = next === "fit" ? fit : Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    const nextZoom = next === "fit" ? "fit" : nextScale;
    if (nextZoom === zoom) return;
    const point = anchor ?? { x: element.clientWidth / 2, y: element.clientHeight / 2 };
    const x = element.scrollLeft + point.x - Math.max(0, (element.clientWidth - current.width * scale) / 2);
    const y = element.scrollTop + point.y - Math.max(0, (element.clientHeight - current.height * scale) / 2);
    pendingPan.current = {
      x: x / scale * nextScale - point.x + Math.max(0, (element.clientWidth - current.width * nextScale) / 2),
      y: y / scale * nextScale - point.y + Math.max(0, (element.clientHeight - current.height * nextScale) / 2),
    };
    setZoom(nextZoom);
  };
  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !current) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      changeZoom(scale * Math.pow(STEP, -delta / 100), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [scale, fit, current, showSource]);
  const endDrag = () => { drag.current = null; setDragging(false); };

  return <div ref={host} className="diagram-viewer">
    <div className="diagram-toolbar" role="group" aria-label={t("diagrams.zoomLevel")}>
      <button type="button" className="btn small" disabled={!current || failed || source} aria-pressed={zoom === "fit"} onClick={() => changeZoom("fit")}>{t("diagrams.fit")}</button>
      <button type="button" className="btn small" disabled={!current || failed || source} aria-pressed={zoom === 1} data-tip={t("diagrams.actualSize")} onClick={() => changeZoom(1)}>100%</button>
      <button type="button" className="icon-btn" disabled={!current || failed || source || scale <= MIN_ZOOM} aria-label={t("diagrams.zoomOut")} data-tip={t("diagrams.zoomOut")} onClick={() => changeZoom(scale / STEP)}><span aria-hidden="true">−</span></button>
      <output className="diagram-scale" aria-label={t("diagrams.zoomLevel")}>{current ? `${Number((scale * 100).toFixed(1))}%` : "—"}</output>
      <button type="button" className="icon-btn" disabled={!current || failed || source || scale >= MAX_ZOOM} aria-label={t("diagrams.zoomIn")} data-tip={t("diagrams.zoomIn")} onClick={() => changeZoom(scale * STEP)}><span aria-hidden="true">+</span></button>
      <button type="button" className="icon-btn diagram-toolbar-end" aria-pressed={source} aria-label={source ? t("diagrams.showDiagram") : t("diagrams.source")} data-tip={source ? t("diagrams.showDiagram") : t("diagrams.source")} onClick={() => setSource(value => !value)}><Icon name="code" /></button>
    </div>
    {showSource ? <pre className="diagram-source"><code>{code}</code></pre> : <div ref={viewportRef} className={`diagram-viewport${canPan ? " is-pannable" : ""}${dragging ? " is-dragging" : ""}`} role="region" aria-label={t("diagrams.viewport")} tabIndex={0}
      onScroll={event => { pan.current = { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop }; }}
      onKeyDown={event => {
        if (event.key === "+" || event.key === "=") changeZoom(scale * STEP);
        else if (event.key === "-") changeZoom(scale / STEP);
        else if (event.key === "0") changeZoom("fit");
        else if (event.key === "1") changeZoom(1);
        else return;
        event.preventDefault(); event.stopPropagation();
      }}
      onPointerDown={event => {
        if (event.button !== 0 || event.pointerType === "touch" || !canPan) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; setDragging(true);
      }}
      onPointerMove={event => {
        const state = drag.current;
        if (!state || state.id !== event.pointerId) return;
        event.currentTarget.scrollLeft = state.left + state.x - event.clientX; event.currentTarget.scrollTop = state.top + state.y - event.clientY;
        pan.current = { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop };
      }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      <div className="diagram-canvas"><img className="diagram-image" src={current.url} alt={t("diagrams.title")} draggable={false} style={{ width: current.width * scale, height: current.height * scale }} onError={() => setImageError(true)} /></div>
    </div>}
    <div className="diagram-status">
      {failed ? <span role="alert">{budget.reason ?? t("diagrams.failure")}</span> : !current ? <span role="status">{t("diagrams.pending")}</span> : <span>{source ? t("diagrams.sourceStatus") : t("diagrams.hint")}</span>}
      {preview && marks ? <span className="chip gray xs">{t("diagrams.demo")}</span> : current ? <span>{Math.round(current.width)} × {Math.round(current.height)}</span> : null}
    </div>
  </div>;
});
