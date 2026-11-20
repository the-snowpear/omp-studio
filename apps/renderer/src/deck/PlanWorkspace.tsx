import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { EditorView } from "@codemirror/view";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { PlanAnnotatedBody } from "./PlanAnnotatedBody";
import { PlanDocument, type PlanNote } from "./planDocument";
import { PlanSourceEditor, highlightPlanRange, type PlanSourceRange } from "./PlanSourceEditor";

type SourceBlock = PlanSourceRange & { element: HTMLElement };
type Direction = "above" | "below" | null;

function direction(top: number, bottom: number, viewport: DOMRect): Direction {
  return bottom <= viewport.top ? "above" : top >= viewport.bottom ? "below" : null;
}

export function PlanWorkspace({ document, markdown, notes, editing, disabled, onSave }: {
  document: PlanDocument;
  markdown: string;
  notes: readonly PlanNote[];
  editing: boolean;
  disabled: boolean;
  onSave: () => void;
}) {
  const zh = useI18n().resolvedLanguage === "zh";
  const root = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const blocks = useRef<SourceBlock[]>([]);
  const mappedDocument = useRef(document.state.doc);
  const active = useRef<SourceBlock | null>(null);
  const [range, setRange] = useState<PlanSourceRange | null>(null);
  const [sourceEdge, setSourceEdge] = useState<Direction>(null);
  const [previewEdge, setPreviewEdge] = useState<Direction>(null);
  const [ratio, setRatio] = useState(document.ratio);

  const measure = useCallback(() => {
    const block = active.current;
    const pane = preview.current;
    if (!block || !pane) { setSourceEdge(null); setPreviewEdge(null); return; }
    if (mappedDocument.current !== document.state.doc) return;
    const bounds = block.element.getBoundingClientRect();
    setPreviewEdge(direction(bounds.top, bounds.bottom, pane.getBoundingClientRect()));
    const view = document.view;
    if (!view) { setSourceEdge(null); return; }
    const start = view.coordsAtPos(block.from);
    const end = view.coordsAtPos(Math.max(block.from, block.to - 1));
    if (start && end) setSourceEdge(direction(start.top, end.bottom, view.scrollDOM.getBoundingClientRect()));
    else if (block.to < view.viewport.from) setSourceEdge("above");
    else if (block.from > view.viewport.to) setSourceEdge("below");
    else setSourceEdge(null);
  }, [document]);

  const activate = useCallback((block: SourceBlock | null) => {
    const previous = active.current;
    if (previous?.element !== block?.element) {
      previous?.element.classList.remove("plan-render-linked");
      block?.element.classList.add("plan-render-linked");
    }
    active.current = block;
    if (previous?.from !== block?.from || previous?.to !== block?.to || previous?.element !== block?.element) {
      setRange(block ? { from: block.from, to: block.to } : null);
      document.view?.dispatch({ effects: highlightPlanRange.of(block ? { from: block.from, to: block.to } : null) });
    }
    measure();
  }, [document, measure]);

  const locatePosition = useCallback((position: number) => {
    if (mappedDocument.current !== document.state.doc) return;
    // A caret at the end of a paragraph still belongs to that paragraph.
    const containing = blocks.current.filter(block => block.from <= position && position <= block.to);
    containing.sort((a, b) => (a.to - a.from) - (b.to - b.from));
    const block = containing[0] ?? blocks.current.find(item => item.from >= position) ?? blocks.current.at(-1) ?? null;
    activate(block);
  }, [activate, document]);

  const locateCaret = useCallback((position: number) => {
    locatePosition(position);
    const block = active.current;
    const pane = preview.current;
    if (!block || !pane || mappedDocument.current !== document.state.doc) return;
    const bounds = block.element.getBoundingClientRect();
    const viewport = pane.getBoundingClientRect();
    if (direction(bounds.top, bounds.bottom, viewport)) {
      pane.scrollTop += bounds.top - viewport.top - pane.clientHeight / 3;
    }
  }, [document, locatePosition]);

  const returnToCaret = useCallback((target: EventTarget | null) => {
    if (!editing) return;
    if (target instanceof Element && root.current?.contains(target)
      && target.closest(".cm-scroller, .plan-preview-scroll, .plan-locate")) return;
    locatePosition(document.state.selection.main.head);
  }, [document, editing, locatePosition]);

  useLayoutEffect(() => {
    mappedDocument.current = document.state.doc;
    blocks.current = Array.from(preview.current!.querySelectorAll<HTMLElement>("[data-source-start]")).map(element => ({
      element, from: Number(element.dataset.sourceStart), to: Number(element.dataset.sourceEnd),
    })).sort((a, b) => a.from - b.from || a.to - b.to);
    if (editing) {
      active.current?.element.classList.remove("plan-render-linked");
      active.current = null;
      locateCaret(document.state.selection.main.head);
    } else activate(null);
  }, [markdown, editing, document, activate, locateCaret]);

  useLayoutEffect(() => {
    const pane = preview.current!;
    pane.scrollTop = document.previewScroll;
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    observer.observe(pane.firstElementChild!);
    return () => { document.previewScroll = pane.scrollTop; observer.disconnect(); };
  }, [document, measure]);

  const resize = (value: number) => {
    const next = Math.max(20, Math.min(80, value));
    document.ratio = next;
    setRatio(next);
  };
  const reveal = (target: "source" | "preview") => {
    const block = active.current;
    if (!block) return;
    if (target === "source") document.view?.dispatch({ effects: EditorView.scrollIntoView(block.from, { y: "center" }) });
    else {
      const pane = preview.current!;
      pane.scrollTop += block.element.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 3;
    }
  };
  const edgeButton = (edge: Direction, target: "source" | "preview") => edge ? <button type="button"
    className={`plan-locate is-${edge}`} onClick={() => reveal(target)}>
    <Icon name={edge === "above" ? "arrow-u" : "arrow-d"} extra="xs" />
    {target === "source" ? (zh ? "定位对应源码" : "Locate source") : (zh ? "定位对应预览" : "Locate preview")}
  </button> : null;
  const currentRange = mappedDocument.current === document.state.doc ? range : null;
  const firstLine = currentRange ? document.state.doc.lineAt(currentRange.from).number : null;
  const lastLine = currentRange ? document.state.doc.lineAt(Math.max(currentRange.from, currentRange.to - 1)).number : null;

  return <div ref={root} className={`plan-workspace${editing ? " is-editing" : ""}`}
    onPointerLeave={event => returnToCaret(event.relatedTarget)}
    style={{ "--plan-source-share": `${ratio}%` } as CSSProperties}>
    {editing ? <>
      <section className="plan-source-pane" aria-label={zh ? "源码编辑区" : "Source editor"}>
        <div className="plan-pane-badges">
          <span className="plan-pane-badge"><Icon name="file-code" extra="sm" /><strong>Markdown</strong></span>
          {firstLine !== null ? <span className="plan-pane-badge plan-location-label">{`${zh ? "行" : "Ln"} ${firstLine}${lastLine !== firstLine ? `–${lastLine}` : ""}`}</span> : null}
        </div>
        <PlanSourceEditor document={document} disabled={disabled} onSave={onSave} onPosition={locatePosition}
          onCaret={locateCaret} onLeave={returnToCaret} onScroll={measure} />
        {edgeButton(sourceEdge, "source")}
      </section>
      <div className="plan-splitter" role="separator" tabIndex={0} aria-orientation="horizontal"
        aria-label={zh ? "调整源码与预览高度" : "Resize source and preview"}
        aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio)}
        onPointerDown={event => { if (event.button === 0) { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); } }}
        onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const bounds = root.current!.getBoundingClientRect();
          resize((event.clientY - bounds.top) / bounds.height * 100);
        }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onKeyDown={event => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); resize(ratio + (event.key === "ArrowUp" ? -5 : 5)); }
          else if (event.key === "Home" || event.key === "End") { event.preventDefault(); resize(event.key === "Home" ? 20 : 80); }
        }} onDoubleClick={() => resize(50)}><span /></div>
    </> : null}
    <section className="plan-render-pane" aria-label={zh ? "计划渲染预览" : "Rendered plan"}>
      {editing ? <div className="plan-pane-badges">
        <span className="plan-pane-badge"><Icon name="eye" extra="sm" /><strong>{zh ? "渲染预览" : "Preview"}</strong></span>
        <span className="plan-pane-badge plan-live-label"><i />{zh ? "实时" : "Live"}</span>
      </div> : null}
      <div ref={preview} className="plan-preview-scroll"
        onScroll={measure}
        onPointerLeave={event => returnToCaret(event.relatedTarget)}
        onPointerMove={event => {
          if (!editing || !(event.target instanceof Element) || event.target.closest("button, textarea, .plan-section-notes")) return;
          const target = event.target.closest<HTMLElement>("[data-source-start]");
          if (target) activate(blocks.current.find(block => block.element === target) ?? null);
        }}>
        <PlanAnnotatedBody document={document} markdown={markdown} notes={notes} disabled={disabled} />
      </div>
      {editing ? edgeButton(previewEdge, "preview") : null}
    </section>
  </div>;
}
