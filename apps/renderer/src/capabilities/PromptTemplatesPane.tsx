import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { PromptTemplateRow } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { hostErrorMessage } from "../hostError";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_TEMPLATES, getPreviewTemplateContent, preparePreviewTemplate } from "../preview/runtimeCatalogPreview";
import { CatalogEmpty, CatalogHeading, useRuntimeCatalog, type RuntimeCatalogProps } from "./RuntimeCatalogShared";
import "./promptTemplates.css";

type Busy = "list" | "select" | "prepare";
type SourceFilter = "all" | "user" | "project";

function templateSource(row: PromptTemplateRow) {
  const match = /^\((user|project)(?::(.+))?\)$/.exec(row.source);
  return { scope: match?.[1], directory: match?.[2] };
}

function sourceLabel(row: PromptTemplateRow, zh: boolean) {
  const { scope, directory } = templateSource(row);
  const label = scope === "project" ? (zh ? "项目模板" : "Project template") : scope === "user" ? (zh ? "用户模板" : "User template") : row.source;
  return directory ? `${label} · ${directory.replaceAll(":", " / ")}` : label;
}

function description(row: PromptTemplateRow) {
  return row.description.endsWith(row.source) ? row.description.slice(0, -row.source.length).trimEnd() : row.description;
}

function TemplateSource({ content }: { content: string }) {
  return <pre>{content.split(/(\$ARGUMENTS|\$@\[\d+(?::\d*)?\]|\$@|\$\d+|\{\{[\s\S]*?\}\})/g).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</pre>;
}

export function PromptTemplatesPane({ client, sessionId, available, visible = true, onInsert }: RuntimeCatalogProps & { onInsert?: ((text: string) => void) | undefined }) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const paneId = useId();
  const [rows, setRows] = useState<PromptTemplateRow[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<PromptTemplateRow>();
  const [content, setContent] = useState("");
  const [args, setArgs] = useState("");
  const [filter, setFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [prepared, setPrepared] = useState<string>();
  const [sourceOpen, setSourceOpen] = useState(true);
  const [busy, setBusy] = useState<Busy>();
  const [error, setError] = useState("");
  const generation = useRef(0);
  const busyRef = useRef(false);
  const selectedRef = useRef<PromptTemplateRow | undefined>(undefined);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const invoke = useRuntimeCatalog(client, sessionId);
  const canRead = preview || (available && !!sessionId);

  const select = useCallback(async (row: PromptTemplateRow, epoch: number) => {
    if (epoch !== generation.current) return;
    selectedRef.current = undefined;
    setSelected(row);
    setContent("");
    setPrepared(undefined);
    setSourceOpen(true);
    setArgs("");
    const value = preview ? { template: row, content: getPreviewTemplateContent(row.id) } : await invoke("templates.get", { sessionId: sessionId!, id: row.id, version: row.version });
    if (epoch === generation.current) { selectedRef.current = value.template; setSelected(value.template); setContent(value.content); }
  }, [invoke, preview, sessionId]);

  const load = useCallback(async (epoch: number, after?: string) => {
    const result = preview ? { templates: PREVIEW_TEMPLATES, nextCursor: undefined } : await invoke("templates.list", { sessionId: sessionId!, ...(after ? { cursor: after } : {}), limit: 50 });
    if (epoch !== generation.current) return;
    setRows((current) => after ? [...current, ...result.templates] : result.templates);
    setCursor(result.nextCursor);
    if (!after && visibleRef.current) {
      const first = result.templates.find((row) => row.id === selectedRef.current?.id) ?? [...result.templates].sort((a, b) => a.name.localeCompare(b.name))[0];
      if (first) {
        if (first.id !== selectedRef.current?.id || first.version !== selectedRef.current?.version) await select(first, epoch);
        else setSelected(first);
      }
      else { selectedRef.current = undefined; setSelected(undefined); setContent(""); setPrepared(undefined); }
    }
  }, [invoke, preview, sessionId, select]);

  const run = useCallback(async (operation: Busy, action: (epoch: number) => Promise<void>) => {
    if (busyRef.current) return;
    const epoch = generation.current;
    busyRef.current = true;
    setBusy(operation);
    setError("");
    try { await action(epoch); }
    catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, zh ? "模板操作失败" : "Template operation failed")); }
    finally { if (epoch === generation.current) { busyRef.current = false; setBusy(undefined); } }
  }, [zh]);

  useEffect(() => {
    generation.current++;
    busyRef.current = false;
    selectedRef.current = undefined;
    setBusy(undefined);
    setRows([]);
    setCursor(undefined);
    setSelected(undefined);
    setContent("");
    setArgs("");
    setPrepared(undefined);
    setFilter("");
    setSourceFilter("all");
    setError("");
    return () => { generation.current++; };
  }, [invoke, available, preview]);

  useEffect(() => {
    if (visible && canRead) void run("list", (epoch) => load(epoch));
  }, [load, run, visible, canRead]);

  const expand = () => {
    if (!selected || busy || !canRead) return;
    void run("prepare", async (epoch) => {
      const text = preview ? preparePreviewTemplate(selected.id, args) : (await invoke("templates.prepare", { sessionId: sessionId!, id: selected.id, version: selected.version, arguments: args })).text;
      if (epoch === generation.current) { setPrepared(text); setSourceOpen(false); }
    });
  };
  const filtered = [...rows].filter((row) => (sourceFilter === "all" || templateSource(row).scope === sourceFilter) && `${row.name} ${description(row)} ${row.source}`.toLowerCase().includes(filter.trim().toLowerCase())).sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  const listKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".runtime-template-row:not(:disabled)")];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !buttons.length) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <section className="runtime-catalog-pane runtime-templates-pane" lang={zh ? "zh-CN" : "en"} aria-label={zh ? "提示词模板" : "Prompt templates"}>
      <CatalogHeading title={zh ? "提示词模板" : "Prompt templates"} scope={zh ? "当前会话 · 已加载模板" : "Current session · Loaded templates"}
        demo={preview && marks ? (zh ? "演示" : "Demo") : undefined}
        description={zh ? "选择模板，填写参数，预览后放入主对话。" : "Choose a template, add arguments, then preview and insert into your conversation."}
        actions={<><span className="runtime-template-count">{rows.length}{cursor ? "+" : ""}<span>{zh ? "个模板" : "templates"}</span></span><button type="button" className="btn small outline" disabled={!!busy || !canRead} onClick={() => void run("list", (epoch) => load(epoch))}><Icon name="refresh" extra="xs" />{busy === "list" ? (zh ? "刷新中…" : "Refreshing…") : (zh ? "刷新模板列表" : "Refresh templates")}</button></>} />
      {error ? <p role="alert" className="runtime-catalog-notice error"><Icon name="alert-c" extra="xs" /><span>{error}</span></p> : null}
      {!canRead ? <CatalogEmpty icon="file-code" title={zh ? "连接活动会话后可用" : "Connect an active session"}>{zh ? "模板读取自当前会话，连接后可查看、展开并插入。" : "Templates come from the active session. Connect to inspect, expand, and insert them."}</CatalogEmpty> : <div className="runtime-template-layout">
        <aside className="runtime-template-library" aria-label={zh ? "已加载模板列表" : "Loaded template library"}>
          <div className="runtime-catalog-search"><Icon name="search" extra="xs" /><input type="search" aria-label={zh ? "筛选模板" : "Filter templates"} placeholder={zh ? "搜索模板…" : "Search templates…"} value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
          <div className="runtime-catalog-filters runtime-template-source-filters" aria-label={zh ? "模板来源筛选" : "Filter template source"}>{([["all", zh ? "全部" : "All"], ["project", zh ? "项目" : "Project"], ["user", zh ? "用户" : "User"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={sourceFilter === value} onClick={() => setSourceFilter(value)}>{label}</button>)}</div>
          <div className="runtime-template-list-heading"><span>{zh ? "模板库" : "Library"}</span><span aria-label={zh ? "上下键移动，回车选择" : "Arrow keys to move, Enter to select"}><Icon name="keyboard" extra="xs" /><kbd>↑↓</kbd><kbd>↵</kbd></span></div>
          <div className="runtime-template-list" onKeyDown={listKeys}>
            {filtered.map((row) => <button type="button" key={row.id} className={`runtime-template-row${selected?.id === row.id ? " selected" : ""}`} aria-pressed={selected?.id === row.id} disabled={!!busy} onClick={() => void run("select", (epoch) => select(row, epoch))}>
              <div className="runtime-template-row-title"><Icon name="file-code" extra="xs" /><strong>{row.name}</strong><Icon name="chevron-r" extra="xs" /></div>
              {description(row) ? <span className="runtime-template-description">{description(row)}</span> : null}
              <span className="runtime-template-source-label"><Icon name={templateSource(row).scope === "project" ? "folder" : "user"} extra="xs" />{sourceLabel(row, zh)}</span>
            </button>)}
            {!filtered.length ? <CatalogEmpty icon={busy === "list" ? "refresh" : "file"} title={busy === "list" ? (zh ? "读取模板…" : "Loading templates…") : rows.length ? (zh ? "没有匹配的模板" : "No matching templates") : (zh ? "当前会话没有已加载模板" : "No templates loaded")}>{busy === "list" ? undefined : rows.length ? (zh ? "调整搜索关键词或来源筛选。" : "Try another search term or source.") : (zh ? "将 Markdown 模板放入 .omp/prompts，再重建运行会话。" : "Add Markdown templates to .omp/prompts, then recreate the Runtime session.")}</CatalogEmpty> : null}
          </div>
          {cursor ? <button type="button" className="btn small outline runtime-template-more" disabled={!!busy} onClick={() => void run("list", (epoch) => load(epoch, cursor))}>{zh ? "更多模板" : "More templates"}<Icon name="chevron-d" extra="xs" /></button> : null}
        </aside>
        <div className="runtime-template-editor">
          {selected ? <div key={selected.id} className="runtime-template-detail">
            <header className="runtime-template-detail-heading"><span className="runtime-template-source-label"><Icon name={templateSource(selected).scope === "project" ? "folder" : "user"} extra="xs" />{sourceLabel(selected, zh)}</span><h4><span>/</span>{selected.name}</h4>{description(selected) ? <p>{description(selected)}</p> : null}</header>
            <details className="runtime-template-source" open={sourceOpen} onToggle={(event) => setSourceOpen(event.currentTarget.open)}><summary><span><Icon name="file-code" extra="xs" />{zh ? "模板原文" : "Template source"}</span><Icon name="chevron-d" extra="xs" /></summary>{content ? <TemplateSource content={content} /> : <p>{busy ? (zh ? "读取模板原文…" : "Reading template source…") : (zh ? "模板原文为空" : "Template source is empty")}</p>}</details>
            <form className="runtime-template-arguments" onSubmit={(event) => { event.preventDefault(); expand(); }}>
              <label htmlFor={`${paneId}-arguments`}>{zh ? "参数" : "Arguments"}<span>{zh ? "含空格的参数用引号包裹" : "Quote arguments that contain spaces"}</span></label>
              <div><input id={`${paneId}-arguments`} className="input mono" aria-label={zh ? "参数（可用引号包住含空格的参数）" : "Arguments (quote values containing spaces)"} placeholder={zh ? '例如："src/app.ts" "重点检查错误处理"' : 'e.g. "src/app.ts" "focus on error handling"'} maxLength={32000} value={args} disabled={!!busy} onChange={(event) => { setArgs(event.target.value); setPrepared(undefined); }} /><button type="submit" className={`btn small ${prepared === undefined ? "primary" : "outline"}`} disabled={!!busy || !canRead}><Icon name="wand" extra="xs" />{busy === "prepare" ? (zh ? "展开中…" : "Expanding…") : (zh ? "预览展开结果" : "Preview expansion")}</button></div>
              <span className="runtime-template-arguments-hint">{zh ? "支持 $1、$2、$ARGUMENTS 和原生模板语法。Enter 预览。" : "Supports $1, $2, $ARGUMENTS, and native template syntax. Enter to preview."}</span>
            </form>
            <div className={`runtime-template-output${prepared !== undefined ? " prepared" : ""}`}>
              <div className="runtime-template-output-heading"><span><Icon name="eye" extra="xs" />{zh ? "展开预览" : "Expansion preview"}</span><span>{prepared === undefined ? (zh ? "等待预览" : "Awaiting preview") : prepared.length ? `${prepared.length.toLocaleString()} ${zh ? "字符" : "characters"}` : (zh ? "展开结果为空" : "Expansion is empty")}</span></div>
              {prepared !== undefined ? <textarea className="runtime-template-output-text" aria-label={zh ? "展开的提示词" : "Expanded prompt"} readOnly spellCheck={false} rows={8} value={prepared} /> : <CatalogEmpty icon="wand" title={zh ? "先看看提示词的展开结果" : "Preview the expanded prompt"}>{zh ? "填写需要的参数后预览，确认内容再放入对话。" : "Add any arguments, preview the expansion, and review the text before inserting."}</CatalogEmpty>}
            </div>
            <footer className="runtime-template-insert"><span><Icon name={prepared ? "check" : "message"} extra="xs" />{zh ? "插入后可在主对话编辑并发送。" : "Edit and send from the main conversation after inserting."}</span><button type="button" className="btn small primary" disabled={!!busy || !prepared || !onInsert} onClick={() => { try { onInsert?.(prepared!); } catch (cause) { setError(hostErrorMessage(cause, zh ? "无法插入模板" : "Cannot insert template")); } }}><Icon name="message" extra="xs" />{zh ? "放入主对话输入框" : "Insert into main Composer"}<Icon name="chevron-r" extra="xs" /></button></footer>
          </div> : <CatalogEmpty icon="file-code" title={rows.length ? (zh ? "选择一个提示词模板" : "Choose a prompt template") : (zh ? "模板工作区" : "Template workspace")}>{zh ? "在左侧查看模板来源，右侧填写参数并预览结果。" : "Browse templates on the left, then add arguments and preview on the right."}</CatalogEmpty>}
        </div>
      </div>}
      {canRead ? <footer className="runtime-catalog-footnote"><Icon name="folder" extra="xs" /><span>{zh ? "默认用户模板位于 ~/.omp/agent/prompts，项目模板位于 .omp/prompts。磁盘修改后需重建运行会话。" : "Default user templates live in ~/.omp/agent/prompts; project templates in .omp/prompts. Recreate the Runtime session after file changes."}</span></footer> : null}
    </section>
  );
}
