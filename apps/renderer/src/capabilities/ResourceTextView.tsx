import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Decoration, EditorView } from "@codemirror/view";
import type { FileViewMode } from "../dock/types";
import { FileModeSwitch } from "../files/FileHeader";
import FileTextEditor, { type EditorController } from "../files/FileTextEditor";
import { fileBadge, fileKind } from "../files/fileTypes";
import { useEditorDisplayPrefs } from "../files/filePreferences";
import type { LogDisplay } from "../files/logDisplay";
import { MARKDOWN_SPLIT_MIN_WIDTH, markdownModes, useMarkdownScroll } from "../files/markdownView";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import "../files/files.css";

const ResourceMarkdown = lazy(() => import("./ResourceMarkdown"));

/** The file viewer's text surface. Its caller owns the Runtime draft or a single read-only page. */
export function ResourceTextView({ uri, text, label, readOnly, onChange, onSave, log }: {
  uri: string; text: string; label: string; readOnly: boolean; onChange?: (text: string) => void; onSave?: () => void;
  log?: LogDisplay | undefined;
}) {
  const zh = useI18n().resolvedLanguage === "zh";
  const { preview } = usePreviewMode();
  const { prefs, setFont, toggleWrap } = useEditorDisplayPrefs(preview);
  const path = uri.startsWith("artifact://") ? `${uri.slice("artifact://".length)}.log` : uri.slice("local://".length);
  const markdown = !!onChange && fileKind(path) === "markdown";
  const badge = fileBadge(path, zh);
  const [mode, setMode] = useState<FileViewMode>("source");
  const [canSplit, setCanSplit] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const controller = useRef<EditorController | null>(null);
  const logColors = useMemo(() => log && EditorView.decorations.of(Decoration.set(
    log.marks.map(({ from, to, style }) => Decoration.mark({ attributes: { style } }).range(from, to)),
    true,
  )), [log]);
  const { markdownRef, previewScroll, followEditor } = useMarkdownScroll(controller);
  useLayoutEffect(() => {
    if (!markdown) return;
    const pane = root.current!;
    const measure = () => setCanSplit(pane.clientWidth >= MARKDOWN_SPLIT_MIN_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [markdown]);
  const view = mode === "split" && !canSplit ? "preview" : mode;
  const find = zh ? "查找" : "Find";
  const go = zh ? "跳转到行" : "Go to line";
  const wrap = zh ? "自动换行" : "Word wrap";
  return <div className="resource-text-view" ref={root}>
    <div className="resource-text-tools">
      {markdown ? <FileModeSwitch modes={markdownModes(zh, canSplit)} mode={view} onMode={setMode} />
        : <span className="resource-language">{badge.label}</span>}
      {view !== "preview" && <div className="resource-text-actions">
        <button type="button" className="icon-btn file-tool" aria-label={find} data-tip={find} onClick={() => controller.current?.search()}><Icon name="search" extra="sm" /></button>
        <button type="button" className="icon-btn file-tool" aria-label={go} data-tip={go} onClick={() => controller.current?.gotoLine()}><Icon name="arrow-r" extra="sm" /></button>
        <button type="button" className={`icon-btn file-tool${prefs.wrap ? " is-active" : ""}`} aria-label={wrap} aria-pressed={prefs.wrap} data-tip={wrap} onClick={toggleWrap}><Icon name="wrap" extra="sm" /></button>
        <span className="resource-editor-zoom">
          <button type="button" aria-label={zh ? "缩小字号" : "Decrease font size"} onClick={() => setFont(-1)}>−</button>
          <button type="button" aria-label={zh ? "重置字号" : "Reset font size"} data-tip={zh ? "重置字号" : "Reset font size"} onClick={() => setFont(null)}>{prefs.fontSize}</button>
          <button type="button" aria-label={zh ? "放大字号" : "Increase font size"} onClick={() => setFont(1)}>+</button>
        </span>
      </div>}
    </div>
    <div className={`resource-text-body${view === "split" ? " file-split" : ""}`}>
      <div hidden={view === "preview"} className="resource-text-source">
        <FileTextEditor descriptor={{ path }} value={log?.text ?? text} displayExtension={logColors} label={label} readOnly={readOnly} {...(onChange ? { onChange } : {})} {...(onSave ? { onSave } : {})}
          wrap={prefs.wrap} fontSize={prefs.fontSize} commands={{ onReady: value => { controller.current = value; }, onFontSize: setFont, onToggleWrap: toggleWrap }}
          onScrollRatio={view === "split" ? followEditor : undefined} />
      </div>
      {view !== "source" && <div className="file-markdown" ref={markdownRef} onScroll={view === "split" ? previewScroll : undefined}>
        <Suspense fallback={<span className="muted">{zh ? "正在加载预览…" : "Loading preview…"}</span>}><ResourceMarkdown text={text} /></Suspense>
      </div>}
    </div>
  </div>;
}
