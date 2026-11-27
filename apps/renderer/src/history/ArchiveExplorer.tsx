import { useEffect, useState, type ReactNode } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { ArchiveTranscriptDetail, ArchiveStatsGroup, NativeArchiveTranscript, NativeArchiveCall, NativeArchiveGrepHit, ArchiveQueryResultMap } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { Icon, type IconName } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewArchiveTranscript, previewArchiveActivity } from "../preview/archivePreview";
import { hostErrorMessage } from "../hostError";

export interface ArchiveTranscriptPreferences { detail: ArchiveTranscriptDetail; budget: number; lastTurns: number; }
export const initialArchiveTranscriptPreferences = (): ArchiveTranscriptPreferences => ({ detail: "auto", budget: 16000, lastTurns: 0 });

function ArchiveState({ icon, children, tone }: { icon: IconName; children: ReactNode; tone?: "error" }) {
  return <p className="ax-state" data-tone={tone} role={tone === "error" ? "alert" : undefined}><Icon name={icon} extra="sm" /><span>{children}</span></p>;
}

// A parent that replaces its detail while refreshing keeps these controls with the selection.
export function ArchiveTranscriptInspector({ client, sessionId, targetSessionId, preferences, onPreferencesChange }: {
  client?: StudioClient | undefined; sessionId?: string | undefined; targetSessionId: string;
  preferences?: ArchiveTranscriptPreferences;
  onPreferencesChange?: (next: ArchiveTranscriptPreferences) => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview } = usePreviewMode();
  const [localPreferences, setLocalPreferences] = useState(initialArchiveTranscriptPreferences);
  const { detail, budget, lastTurns } = preferences ?? localPreferences;
  const setPreferences = onPreferencesChange ?? setLocalPreferences;
  const [result, setResult] = useState<NativeArchiveTranscript>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError("");
    setBusy(false);
    setResult(undefined);
    if (!preview && (!client || !sessionId)) return;
    setBusy(true);
    const read = preview ? Promise.resolve(previewArchiveTranscript(targetSessionId, zh)) : client!.query("archive.transcript.read", {
      sessionId: sessionId!, targetSessionId, detail, budget,
      ...(lastTurns > 0 ? { turns: [-lastTurns, -1] as [number, number] } : {}),
    });
    void read.then(value => { if (!cancelled) setResult(value); }, cause => {
      if (!cancelled) setError(hostErrorMessage(cause, zh ? "转录读取失败" : "Unable to read transcript"));
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [client, sessionId, targetSessionId, detail, budget, lastTurns, preview, zh]);
  return <section className="ax-card archive-transcript" aria-label={zh ? "会话转录" : "Session transcript"}>
    <header className="ax-card-head">
      <h4><Icon name="message" extra="sm" />{zh ? "会话转录" : "Session transcript"}</h4>
      {result && !busy ? <span className="ax-meta">{zh ? `${result.turns} 轮 · ${result.records} 条记录${result.omitted ? ` · 省略 ${result.omitted} 条` : ""}` : `${result.turns} turns · ${result.records} records${result.omitted ? ` · ${result.omitted} omitted` : ""}`}</span> : null}
    </header>
    <div className="ax-controls">
      <label className="ax-field"><span>{zh ? "详细程度" : "Detail"}</span><AppSelect value={detail} onChange={event => setPreferences({ detail: event.target.value as ArchiveTranscriptDetail, budget, lastTurns })}>
        <option value="auto">{zh ? "自动" : "Auto"}</option><option value="brief">{zh ? "简要" : "Brief"}</option>
        <option value="normal">{zh ? "标准" : "Normal"}</option><option value="full">{zh ? "完整" : "Full"}</option>
      </AppSelect></label>
      <label className="ax-field"><span>{zh ? "字符预算" : "Character budget"}</span><AppSelect value={budget} onChange={event => setPreferences({ detail, budget: Number(event.target.value), lastTurns })}>
        {[4000, 16000, 64000].map(value => <option key={value} value={value}>{value.toLocaleString()}</option>)}
      </AppSelect></label>
      <label className="ax-field"><span>{zh ? "回合" : "Turns"}</span><AppSelect value={lastTurns} onChange={event => setPreferences({ detail, budget, lastTurns: Number(event.target.value) })}>
        <option value={0}>{zh ? "全部" : "All"}</option><option value={1}>{zh ? "最后 1 轮" : "Last turn"}</option>
        <option value={5}>{zh ? "最后 5 轮" : "Last 5 turns"}</option><option value={20}>{zh ? "最后 20 轮" : "Last 20 turns"}</option>
      </AppSelect></label>
    </div>
    {busy ? <p className="ax-state" role="status"><i className="ax-spinner" aria-hidden /><span>{zh ? "读取转录…" : "Loading transcript…"}</span></p>
      : error ? <ArchiveState icon="alert-c" tone="error">{error}</ArchiveState>
      : result ? <pre className="archive-transcript-text">{result.text}</pre>
      : <ArchiveState icon="plug">{zh ? "连接 Runtime 后可读取转录。" : "Connect the Runtime to read transcripts."}</ArchiveState>}
  </section>;
}

type ActivityView = "calls" | "grep" | "stats";
type StatRow = ArchiveQueryResultMap["archive.stats.read"]["rows"][number];
type ActivityRows = NativeArchiveCall[] | NativeArchiveGrepHit[] | StatRow[];

function highlight(text: string, match: string | undefined): ReactNode {
  if (!match) return text;
  const at = text.indexOf(match);
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{match}</mark>{text.slice(at + match.length)}</>;
}

export function ArchiveActivityPane({ client, sessionId, scope, active, available }: {
  client?: StudioClient | undefined; sessionId?: string | undefined; scope: "workspace" | "all"; active: boolean; available: boolean;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview } = usePreviewMode();
  const [view, setView] = useState<ActivityView>("stats");
  const [group, setGroup] = useState<ArchiveStatsGroup>("tool");
  const [pattern, setPattern] = useState("");
  const [search, setSearch] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [subagents, setSubagents] = useState(true);
  const [rows, setRows] = useState<ActivityRows>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setRows([]); setError(""); setTruncated(false); setBusy(false);
    if (!active || (!preview && (!client || !sessionId || !available)) || (view === "grep" && !search)) return;
    const input = { sessionId: sessionId ?? "", scope, subagents,
      ...(since ? { since: new Date(since).getTime() } : {}), ...(until ? { until: new Date(until).getTime() } : {}) };
    setBusy(true);
    const read = preview ? Promise.resolve({ rows: previewArchiveActivity(view, zh), truncated: false })
      : view === "stats" ? client!.query("archive.stats.read", { ...input, by: group })
      : view === "grep" ? client!.query("archive.messages.grep", { ...input, pattern: search })
      : client!.query("archive.calls.list", input);
    void read.then(value => { if (!cancelled) { setRows(value.rows); setTruncated(value.truncated); } }, cause => {
      if (!cancelled) setError(hostErrorMessage(cause, zh ? "历史活动读取失败" : "Unable to read history activity"));
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [client, sessionId, scope, active, available, preview, zh, view, group, search, since, until, subagents]);

  const views: Array<[ActivityView, IconName, string]> = [["stats", "chart", zh ? "调用统计" : "Call statistics"], ["calls", "tool-list", zh ? "工具调用" : "Tool calls"], ["grep", "search", zh ? "正则搜索" : "Regex search"]];
  const groups = ([["tool", "工具", "Tool"], ["day", "日期", "Day"], ["model", "模型", "Model"], ["version", "版本", "Version"], ["project", "工作区", "Workspace"], ["session", "会话", "Session"]] as const);
  const stamp = (at: string | number | null | undefined) => at ? new Date(at).toLocaleString(zh ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const stats = view === "stats" ? rows as StatRow[] : [];
  const peak = Math.max(1, ...stats.map(row => row.calls));
  const totals = stats.reduce((sum, row) => ({ calls: sum.calls + row.calls, errors: sum.errors + row.errors }), { calls: 0, errors: 0 });

  const body = !preview && !available ? <ArchiveState icon="plug">{zh ? "连接 Runtime 后可查询历史活动。" : "Connect the Runtime to query history activity."}</ArchiveState>
    : busy ? <p className="ax-state" role="status"><i className="ax-spinner" aria-hidden /><span>{zh ? "读取中…" : "Loading…"}</span></p>
    : error ? <ArchiveState icon="alert-c" tone="error">{error}</ArchiveState>
    : view === "grep" && !search ? <ArchiveState icon="search">{zh ? "输入正则表达式后搜索已归档的转录。" : "Enter a regular expression to search archived transcripts."}</ArchiveState>
    : !rows.length ? <ArchiveState icon="archive">{zh ? "此范围内暂无匹配记录。" : "No matching records in this range."}</ArchiveState>
    : view === "stats" ? <>
      <div className="ax-totals">
        <div><strong>{totals.calls.toLocaleString()}</strong><span>{zh ? "总调用" : "Total calls"}</span></div>
        <div data-tone={totals.errors ? "error" : undefined}><strong>{totals.errors.toLocaleString()}</strong><span>{zh ? "错误" : "Errors"}</span></div>
        <div><strong>{totals.calls ? `${(100 - totals.errors / totals.calls * 100).toFixed(totals.errors ? 1 : 0)}%` : "—"}</strong><span>{zh ? "成功率" : "Success rate"}</span></div>
      </div>
      <table className="archive-stats">
        <thead><tr><th>{zh ? "分组" : "Group"}</th><th>{zh ? "调用" : "Calls"}</th><th>{zh ? "错误" : "Errors"}</th></tr></thead>
        <tbody>{stats.map((row, index) => <tr key={index}>
          <td><div className="ax-key-cell"><span className="ax-key">{row.key ?? (zh ? "未知" : "Unknown")}</span><span className="ax-bar" aria-hidden><i style={{ width: `${Math.max(2, row.calls / peak * 100)}%` }} /></span></div></td>
          <td>{row.calls.toLocaleString()}</td>
          <td>{row.errors ? <span className="ax-error-count">{row.errors.toLocaleString()}</span> : <span className="ax-zero">0</span>}</td>
        </tr>)}</tbody>
      </table>
    </>
    : <ol className="ax-records">{(rows as Array<NativeArchiveCall | NativeArchiveGrepHit>).map((row, index) => {
      const failed = "isError" in row && row.isError === true;
      return <li className="archive-text-row ax-record" key={index} data-error={failed || undefined}>
        <div className="ax-record-head">
          <span className="ax-tool"><Icon name="tool-list" extra="sm" />{row.tool}</span>
          <span className="ax-record-origin">{row.session}{row.agent ? <> · <b>{row.agent}</b></> : null}</span>
          <time className="ax-record-time" dateTime={row.at ? new Date(row.at).toISOString() : undefined}>{stamp(row.at)}</time>
        </div>
        {"args" in row ? <>
          <pre className="ax-args">{JSON.stringify(row.args, null, 2)}</pre>
          {row.result ? <p className="ax-result"><Icon name={failed ? "alert-c" : "check"} extra="sm" /><span>{row.result}</span></p> : null}
        </> : <p className="ax-hit">{highlight(row.text, row.match)}</p>}
      </li>;
    })}</ol>;

  return <section className="archive-activity" aria-label={zh ? "归档调用与统计" : "Archived calls and statistics"}>
    <form className="ax-filterbar" onSubmit={event => { event.preventDefault(); setSearch(pattern); }}>
      <div className="seg ax-views" role="group" aria-label={zh ? "查看" : "View"}>
        {views.map(([value, icon, label]) => <button key={value} type="button" className={view === value ? "active" : ""} aria-pressed={view === value} onClick={() => setView(value)}><Icon name={icon} extra="sm" />{label}</button>)}
      </div>
      <div className="ax-filters">
        {view === "stats" ? <label className="ax-field"><span>{zh ? "分组" : "Group by"}</span><AppSelect value={group} onChange={event => setGroup(event.target.value as ArchiveStatsGroup)}>
          {groups.map(([value, chinese, english]) => <option key={value} value={value}>{zh ? chinese : english}</option>)}
        </AppSelect></label> : null}
        <label className="ax-field"><span>{zh ? "开始" : "Since"}</span><input className="input" type="datetime-local" value={since} onChange={event => setSince(event.target.value)} /></label>
        <label className="ax-field"><span>{zh ? "结束" : "Until"}</span><input className="input" type="datetime-local" value={until} onChange={event => setUntil(event.target.value)} /></label>
        <label className="ax-check"><input type="checkbox" checked={subagents} onChange={event => setSubagents(event.target.checked)} /><span>{zh ? "包含子代理" : "Include subagents"}</span></label>
      </div>
      {view === "grep" ? <div className="ax-search">
        <label className="ax-search-field"><Icon name="search" extra="sm" /><input aria-label={zh ? "正则表达式" : "Regular expression"} placeholder={zh ? "正则表达式，例如 fail(ed|ure)" : "Regular expression, e.g. fail(ed|ure)"} value={pattern} onChange={event => setPattern(event.target.value)} maxLength={256} spellCheck={false} /></label>
        <button className="btn small primary" disabled={busy}>{zh ? "搜索" : "Search"}</button>
      </div> : null}
    </form>
    <div className="ax-results">{body}</div>
    {truncated ? <p className="ax-foot">{zh ? "显示最近 20 项，可缩小时间范围。" : "Showing the latest 20 entries. Narrow the time range to see others."}</p> : null}
  </section>;
}
