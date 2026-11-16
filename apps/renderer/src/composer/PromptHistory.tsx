import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { StudioClient } from "@omp-studio/client-contract";
import type { PromptHistoryItem, PromptHistoryScope } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewPromptBody, previewPromptHistory } from "../preview/promptHistoryPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import type { ChipComposerHandle } from "./ChipComposer";
import "./promptHistory.css";

type Body = { prompt: string; truncated: boolean };
const PAGE = 50;
const MAX_PAGE = 200;

function relativeTime(at: number, now: number, zh: boolean): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return zh ? "刚刚" : "just now";
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return zh ? `${days} 天前` : `${days} d ago`;
  return new Date(at).toLocaleDateString(zh ? "zh-CN" : "en");
}
function baseName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

/**
 * Native prompt history (HistoryStorage / FTS), not session transcripts.
 * Bodies are read on demand and live only while the panel is open; choosing
 * one edits the Composer and never sends.
 */
export function PromptHistoryButton({ client, sessionId, ownSession, available, canDelete, composerRef, disabled }: {
  client: StudioClient | null;
  /** Runtime session used to reach the native store. */
  sessionId: string | undefined;
  /** True when sessionId is the Composer's own conversation (enables the session scope). */
  ownSession: boolean;
  available: boolean;
  canDelete: boolean;
  composerRef: RefObject<ChipComposerHandle | null>;
  disabled?: boolean;
}) {
  const document = useSurfaceDocument(), window = surfaceWindow(document);
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const tr = (zhText: string, enText: string) => zh ? zhText : enText;
  const translate = useRef(tr);
  translate.current = tr;
  const { preview, marks } = usePreviewMode();
  /* Only demo prompts depend on language; real prompts stay as typed. */
  const previewLanguage = preview ? resolvedLanguage : undefined;
  const ready = preview || (available && !!client && !!sessionId);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<PromptHistoryScope>("workspace");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [items, setItems] = useState<PromptHistoryItem[]>();
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const [bodies, setBodies] = useState<Readonly<Record<string, Body | "loading" | { error: string }>>>({});
  const bodyCache = useRef(bodies);
  bodyCache.current = bodies;
  const [bodyEpoch, setBodyEpoch] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const generation = useRef(0);
  const effectiveScope: PromptHistoryScope = scope === "session" && !ownSession && !preview ? "workspace" : scope;
  const keyOf = (item: PromptHistoryItem) => `${effectiveScope}:${item.id}:${item.revision}`;

  const close = useCallback(() => {
    setOpen(false); setBodies({}); setConfirmDelete(undefined); setError(""); setLimit(PAGE); setActive(0);
    generation.current += 1;
  }, []);

  /* A different session or data source is a different store. */
  useEffect(() => { close(); return () => { generation.current += 1; }; }, [close, client, sessionId, preview]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 180);
    return () => window.clearTimeout(timer);
  }, [query, window]);
  useEffect(() => { setActive(0); setConfirmDelete(undefined); }, [effectiveScope, debounced, limit]);

  const reload = useCallback(async (keepError = false) => {
    if (!open || !ready) return;
    const epoch = ++generation.current;
    setLoading(true); if (!keepError) setError(""); setBodies({}); setBodyEpoch(epoch);
    try {
      if (preview) {
        const rows = previewPromptHistory(effectiveScope, debounced, previewLanguage === "zh");
        if (epoch === generation.current) { setItems(rows); setTruncated(false); }
        return;
      }
      const result = await client!.query("history.prompts.list", { sessionId: sessionId!, scope: effectiveScope, limit, ...(debounced.trim() ? { query: debounced.trim() } : {}) });
      if (epoch === generation.current) { setItems(result.items); setTruncated(result.truncated); }
    } catch (cause) {
      if (epoch === generation.current) { setItems([]); setError(hostErrorMessage(cause, translate.current("无法读取输入历史", "Prompt history unavailable"))); }
    } finally {
      if (epoch === generation.current) { setLoading(false); setNow(Date.now()); }
    }
  }, [open, ready, preview, effectiveScope, debounced, previewLanguage, client, sessionId, limit]);
  useEffect(() => { void reload(); }, [reload]);

  /* Placement follows the Dictation panel: above the anchor, inside the window. */
  useLayoutEffect(() => {
    const element = panel.current, anchor = root.current;
    if (!open || !element || !anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(440, window.innerWidth - 32);
      element.style.width = `${width}px`;
      element.style.left = `${Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16))}px`;
      element.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 10)}px`;
      element.style.maxHeight = `${Math.max(200, Math.min(560, rect.top - 22))}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, window]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (panel.current?.contains(target) || root.current?.contains(target))) return;
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, close, document, window]);
  useEffect(() => { if (open) search.current?.focus(); }, [open, document]);

  const readBody = useCallback(async (item: Pick<PromptHistoryItem, "id" | "revision">): Promise<Body | undefined> => {
    const key = `${effectiveScope}:${item.id}:${item.revision}`;
    const cached = bodyCache.current[key];
    if (cached && cached !== "loading" && !("error" in cached)) return cached;
    const epoch = generation.current;
    setBodies(map => ({ ...map, [key]: "loading" }));
    try {
      const body = preview ? previewPromptBody(item.id, previewLanguage === "zh")
        : await client!.query("history.prompts.read", { sessionId: sessionId!, scope: effectiveScope, id: item.id, revision: item.revision });
      if (!body) throw new Error(translate.current("该条记录已不存在", "This entry no longer exists"));
      const next = { prompt: body.prompt, truncated: body.truncated };
      if (epoch === generation.current) setBodies(map => ({ ...map, [key]: next }));
      return epoch === generation.current ? next : undefined;
    } catch (cause) {
      if (epoch === generation.current) setBodies(map => ({ ...map, [key]: { error: hostErrorMessage(cause, translate.current("正文读取失败", "Could not read the prompt")) } }));
      return undefined;
    }
  }, [effectiveScope, preview, previewLanguage, client, sessionId]);

  const insert = async (item: PromptHistoryItem, acceptTruncated = false) => {
    const epoch = generation.current;
    const body = await readBody(item);
    if (!body || epoch !== generation.current) return;
    if (body.truncated && !acceptTruncated) { setActive(items?.indexOf(item) ?? 0); return; }
    composerRef.current?.insertText(body.prompt);
    close();
  };

  const remove = async (item: PromptHistoryItem) => {
    const key = keyOf(item);
    if (confirmDelete !== key) { setConfirmDelete(key); return; }
    setConfirmDelete(undefined);
    if (preview) { setItems(rows => rows?.filter(row => row !== item)); return; }
    const epoch = generation.current;
    try {
      const handle = await client!.command("history.prompts.delete", { sessionId: sessionId!, scope: effectiveScope, id: item.id, revision: item.revision });
      await waitReceipt(client!, handle.requestId);
      if (epoch === generation.current) setItems(rows => rows?.filter(row => !(row.id === item.id && row.revision === item.revision)));
    } catch (cause) {
      if (epoch !== generation.current) return;
      setError(hostErrorMessage(cause, translate.current("删除失败：该条记录可能已更新，列表已刷新", "Delete failed: the entry may have changed, so the list was refreshed")));
      void reload(true);
    }
  };

  const shown = items ?? [];
  const current = shown[Math.min(active, Math.max(0, shown.length - 1))];
  const currentBody = current ? bodies[keyOf(current)] : undefined;
  const currentId = current?.id, currentRevision = current?.revision;
  /* Cache invalidation can leave the selected reference unchanged. Cache writes
   * do not restart this debounce, and readBody always sees the latest cache. */
  useEffect(() => {
    if (!open || currentId === undefined || currentRevision === undefined) return;
    const epoch = generation.current;
    const timer = window.setTimeout(() => {
      if (epoch === generation.current) void readBody({ id: currentId, revision: currentRevision });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [open, currentId, currentRevision, readBody, bodyEpoch, window]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, document]);

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); composerRef.current?.focus(); return; }
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(index => Math.min(shown.length - 1, index + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    else if (event.key === "Enter" && current) { event.preventDefault(); void insert(current, currentBody !== undefined && currentBody !== "loading" && !("error" in currentBody) && currentBody.truncated); }
    else if (event.key === "Delete" && event.shiftKey && current && canDelete) { event.preventDefault(); void remove(current); }
  };

  const scopes: Array<{ id: PromptHistoryScope; label: string; tip: string; hidden?: boolean }> = useMemo(() => [
    { id: "session", label: tr("本会话", "Session"), tip: tr("只看这个会话发出的输入", "Only prompts sent from this conversation"), hidden: !ownSession && !preview },
    { id: "workspace", label: tr("本项目", "Project"), tip: tr("这个工作目录下的输入", "Prompts sent in this working directory") },
    { id: "profile", label: tr("全部", "Everywhere"), tip: tr("本机 Runtime 记录的全部输入", "Every prompt this Runtime profile recorded") },
  ], [zh, ownSession, preview]);

  const blocked = !ready ? !sessionId ? tr("打开一个会话后可用", "Available once a conversation is open") : tr("当前 Runtime 不提供输入历史", "This Runtime has no prompt history") : undefined;
  const label = tr("输入历史", "Prompt history");

  return <div ref={root} className="prompt-history">
    <button type="button" className={`icon-btn small prompt-history-btn${open ? " active" : ""}`} aria-label={label} aria-haspopup="dialog" aria-expanded={open}
      aria-disabled={blocked || disabled ? true : undefined} data-tip={blocked ?? tr("输入历史 · 选择后只填入输入框，不会发送", "Prompt history · picks fill the input, never send")}
      onPointerDown={event => event.preventDefault()} onClick={() => { if (blocked || disabled) return; if (open) close(); else { setOpen(true); setNow(Date.now()); } }}>
      <Icon name="history" extra="sm" />
    </button>
    {open ? createPortal(<div ref={panel} className="prompt-history-panel" role="dialog" aria-label={label} onKeyDown={onKey}>
      <header className="ph-head">
        <Icon name="history" extra="sm" /><b>{label}</b>{preview && marks ? <span className="chip gray xs">{tr("演示", "Demo")}</span> : null}
        <span className="spacer" />
        <span className="seg ph-scopes" role="tablist" aria-label={tr("范围", "Scope")}>
          {scopes.filter(entry => !entry.hidden).map(entry => <button key={entry.id} type="button" role="tab" aria-selected={effectiveScope === entry.id} className={effectiveScope === entry.id ? "active" : undefined} data-tip={entry.tip}
            onClick={() => { if (entry.id === effectiveScope) return; setScope(entry.id); setLimit(PAGE); }}>{entry.label}</button>)}
        </span>
      </header>
      <label className="ph-search">
        <Icon name="search" extra="sm" />
        <input ref={search} className="ph-search-input" value={query} onChange={event => setQuery(event.target.value)} placeholder={tr("搜索以前的输入…", "Search earlier prompts…")} aria-label={tr("搜索输入历史", "Search prompt history")}
          aria-controls="phList" aria-activedescendant={current ? `ph-${current.id}` : undefined} />
        {loading ? <span className="spinner" aria-hidden="true" /> : null}
      </label>
      {error ? <p className="ph-error" role="alert"><Icon name="alert" extra="sm" />{error}</p> : null}
      <ul id="phList" ref={listRef} className="ph-list" role="listbox" aria-label={label}>
        {!loading && shown.length === 0 && !error ? <li className="ph-empty">{debounced.trim() ? tr("没有匹配的输入", "No matching prompts") : tr("这里还没有记录", "Nothing recorded here yet")}</li> : null}
        {shown.map((item, index) => {
          const key = keyOf(item);
          const selected = index === active;
          return <li key={key} id={`ph-${item.id}`} data-index={index} role="option" aria-selected={selected} className={`ph-item${selected ? " is-active" : ""}`}
            onPointerEnter={() => setActive(index)} onClick={() => void insert(item)}>
            <span className="ph-preview">{item.preview}</span>
            <span className="ph-meta">
              <span>{relativeTime(item.createdAt, now, zh)}</span>
              {item.useCount > 1 ? <span>{tr(`用过 ${item.useCount} 次`, `used ${item.useCount}×`)}</span> : null}
              {effectiveScope === "profile" && item.cwd ? <span className="ph-cwd" data-tip={item.cwd}><Icon name="folder" extra="sm" />{baseName(item.cwd)}</span> : null}
              <span className="spacer" />
              {canDelete || preview ? <button type="button" className={`ph-delete${confirmDelete === key ? " is-armed" : ""}`} aria-label={confirmDelete === key ? tr("确认删除这条记录", "Confirm delete") : tr("从历史中删除", "Delete from history")}
                data-tip={confirmDelete === key ? undefined : tr("从原生输入历史中删除（Shift+Delete）", "Remove from native prompt history (Shift+Delete)")}
                onClick={event => { event.stopPropagation(); void remove(item); }}>
                <Icon name="trash" extra="sm" />{confirmDelete === key ? tr("确认删除", "Delete") : null}
              </button> : null}
            </span>
          </li>;
        })}
      </ul>
      {current ? <section className="ph-detail" aria-live="polite" aria-label={tr("完整内容", "Full prompt")}>
        {currentBody === undefined || currentBody === "loading" ? <p className="ph-detail-loading"><span className="spinner" aria-hidden="true" />{tr("读取完整内容…", "Reading the full prompt…")}</p>
          : "error" in currentBody ? <p className="ph-error"><Icon name="alert" extra="sm" />{currentBody.error}</p>
          : <>
            <pre className="ph-body">{currentBody.prompt}</pre>
            {currentBody.truncated ? <div className="ph-truncated" role="note"><Icon name="alert-c" extra="sm" />
              <span>{tr("Runtime 只返回了部分正文，插入的不是完整提示词。", "The Runtime returned only part of this prompt; what you insert is incomplete.")}</span>
              <button type="button" className="btn small outline" onClick={() => void insert(current, true)}>{tr("仍然插入", "Insert anyway")}</button>
            </div> : null}
          </>}
      </section> : null}
      <footer className="ph-foot">
        <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd>{tr("选择", "move")}<kbd className="kbd">Enter</kbd>{tr("填入输入框", "fill input")}<kbd className="kbd">Esc</kbd>{tr("关闭", "close")}</span>
        <span className="spacer" />
        {truncated ? limit < MAX_PAGE
          ? <button type="button" className="btn small ghost" onClick={() => setLimit(MAX_PAGE)}>{tr(`显示更多（最多 ${MAX_PAGE} 条）`, `Show more (up to ${MAX_PAGE})`)}</button>
          : <span className="ph-more">{tr("更早的记录请用搜索查找", "Search to find older prompts")}</span> : null}
      </footer>
    </div>, document.body) : null}
  </div>;
}
