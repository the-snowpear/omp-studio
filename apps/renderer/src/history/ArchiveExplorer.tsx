import { useEffect, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { ArchiveTranscriptDetail, ArchiveStatsGroup, NativeArchiveTranscript, NativeArchiveCall, NativeArchiveGrepHit, ArchiveQueryResultMap } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewArchiveTranscript, previewArchiveActivity } from "../preview/archivePreview";
import { hostErrorMessage } from "../hostError";

// Keep reads local to the inspector: changing display language never resets its controls.
export function ArchiveTranscriptInspector({ client, sessionId, targetSessionId }: {
  client?: StudioClient | undefined; sessionId?: string | undefined; targetSessionId: string;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview } = usePreviewMode();
  const [detail, setDetail] = useState<ArchiveTranscriptDetail>("auto");
  const [budget, setBudget] = useState(16000);
  const [lastTurns, setLastTurns] = useState(0);
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
  return <section className="archive-transcript" aria-label={zh ? "会话转录" : "Session transcript"}>
    <h4>{zh ? "会话转录" : "Session transcript"}</h4>
    <div className="archive-toolbar">
      <label>{zh ? "详细程度" : "Detail"}<AppSelect value={detail} onChange={event => setDetail(event.target.value as ArchiveTranscriptDetail)}>
        <option value="auto">{zh ? "自动" : "Auto"}</option><option value="brief">{zh ? "简要" : "Brief"}</option>
        <option value="normal">{zh ? "标准" : "Normal"}</option><option value="full">{zh ? "完整" : "Full"}</option>
      </AppSelect></label>
      <label>{zh ? "字符预算" : "Character budget"}<AppSelect value={budget} onChange={event => setBudget(Number(event.target.value))}>
        {[4000, 16000, 64000].map(value => <option key={value} value={value}>{value.toLocaleString()}</option>)}
      </AppSelect></label>
      <label>{zh ? "回合" : "Turns"}<AppSelect value={lastTurns} onChange={event => setLastTurns(Number(event.target.value))}>
        <option value={0}>{zh ? "全部" : "All"}</option><option value={1}>{zh ? "最后 1 轮" : "Last turn"}</option>
        <option value={5}>{zh ? "最后 5 轮" : "Last 5 turns"}</option><option value={20}>{zh ? "最后 20 轮" : "Last 20 turns"}</option>
      </AppSelect></label>
    </div>
    {busy ? <p role="status">{zh ? "读取转录…" : "Loading transcript…"}</p> : error ? <p className="archive-error" role="alert">{error}</p> : result ? <>
      <p className="archive-meta">{zh ? `${result.turns} 轮 · ${result.records} 条记录 · 省略 ${result.omitted} 条` : `${result.turns} turns · ${result.records} records · ${result.omitted} omitted`}</p>
      <pre className="archive-transcript-text">{result.text}</pre>
    </> : <p className="muted">{zh ? "连接 Runtime 后可读取转录。" : "Connect the Runtime to read transcripts."}</p>}
  </section>;
}

type ActivityView = "calls" | "grep" | "stats";
type ActivityRows = NativeArchiveCall[] | NativeArchiveGrepHit[] | ArchiveQueryResultMap["archive.stats.read"]["rows"];
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
  return <section className="archive-activity" aria-label={zh ? "归档调用与统计" : "Archived calls and statistics"}>
    <form className="archive-toolbar" onSubmit={event => { event.preventDefault(); setSearch(pattern); }}>
      <label>{zh ? "查看" : "View"}<AppSelect value={view} onChange={event => setView(event.target.value as ActivityView)}>
        <option value="stats">{zh ? "调用统计" : "Call statistics"}</option><option value="calls">{zh ? "工具调用" : "Tool calls"}</option><option value="grep">{zh ? "转录正则搜索" : "Transcript regex search"}</option>
      </AppSelect></label>
      {view === "stats" ? <label>{zh ? "分组" : "Group by"}<AppSelect value={group} onChange={event => setGroup(event.target.value as ArchiveStatsGroup)}>
        {([['tool','工具','Tool'],['day','日期','Day'],['model','模型','Model'],['version','版本','Version'],['project','工作区','Workspace'],['session','会话','Session']] as const).map(([value, chinese, english]) => <option key={value} value={value}>{zh ? chinese : english}</option>)}
      </AppSelect></label> : null}
      <label>{zh ? "开始" : "Since"}<input className="input" type="datetime-local" value={since} onChange={event => setSince(event.target.value)} /></label>
      <label>{zh ? "结束" : "Until"}<input className="input" type="datetime-local" value={until} onChange={event => setUntil(event.target.value)} /></label>
      <label><span>{zh ? "子代理" : "Subagents"}</span><input type="checkbox" checked={subagents} onChange={event => setSubagents(event.target.checked)} /></label>
      {view === "grep" ? <><label className="archive-search">{zh ? "正则表达式" : "Regular expression"}<input className="input" value={pattern} onChange={event => setPattern(event.target.value)} maxLength={256}/></label><button className="btn outline" disabled={busy}>{zh ? "搜索" : "Search"}</button></> : null}
    </form>
    {!preview && !available ? <p className="muted">{zh ? "连接 Runtime 后可查询历史活动。" : "Connect the Runtime to query history activity."}</p> : busy ? <p role="status">{zh ? "读取中…" : "Loading…"}</p> : error ? <p className="archive-error" role="alert">{error}</p> : !rows.length ? <p className="muted">{zh ? "此范围内暂无匹配记录。" : "No matching records in this range."}</p> : view === "stats" ?
      <table className="archive-stats"><thead><tr><th>{zh ? "分组" : "Group"}</th><th>{zh ? "调用" : "Calls"}</th><th>{zh ? "错误" : "Errors"}</th></tr></thead><tbody>{(rows as ArchiveQueryResultMap["archive.stats.read"]["rows"]).map((row, index) => <tr key={index}><td>{row.key ?? (zh ? "未知" : "Unknown")}</td><td>{row.calls}</td><td>{row.errors}</td></tr>)}</tbody></table>
      : (rows as Array<NativeArchiveCall | NativeArchiveGrepHit>).map((row, index) => <article className="archive-text-row" key={index}><div className="archive-meta"><strong>{row.tool}</strong><span>{row.session}{row.agent ? ` / ${row.agent}` : ""}</span><span>{row.at ? new Date(row.at).toLocaleString(zh ? "zh-CN" : "en-US") : ""}</span></div>{"args" in row ? <><pre className="archive-transcript-text">{JSON.stringify(row.args, null, 2)}</pre><p>{row.result}</p></> : <p>{row.text}</p>}</article>)}
    {truncated ? <p className="muted tiny">{zh ? "显示最近 20 项，可缩小时间范围。" : "Showing the latest 20 entries. Narrow the time range to see others."}</p> : null}
  </section>;
}
