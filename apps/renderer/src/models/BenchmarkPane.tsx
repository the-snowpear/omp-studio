import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AvailableModelRecord, CommandInput, StudioClient } from "@omp-studio/client-contract";
import { validateBenchmarkSpec, type BenchmarkRun, type BenchmarkSnapshot, type BenchmarkSpec, type BenchmarkResultMap, type BenchmarkStats } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { PREVIEW_BENCHMARK } from "../preview/benchmarksPreview";
import "./benchmark.css";

type Props = { client: StudioClient; sessionId?: string | undefined; workspaceId?: string | undefined; available: boolean; models: readonly AvailableModelRecord[] };
type Metric = "ttftMs" | "tokensPerSecond" | "generationTps" | "prefillTps";
const running = (run: BenchmarkRun) => run.state === "running" || run.state === "cancelling";
export function BenchmarkPane({ client, sessionId, workspaceId, available, models }: Props) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const t = (cn: string, en: string) => zh ? cn : en;
  const [runs, setRuns] = useState<BenchmarkRun[]>([]); const [selected, setSelected] = useState<string>(); const [snapshot, setSnapshot] = useState<BenchmarkSnapshot>();
  const [picked, setPicked] = useState<string[]>([]); const [search, setSearch] = useState(""); const [profile, setProfile] = useState<BenchmarkSpec["profile"]>("chat");
  const [count, setCount] = useState(3); const [concurrency, setConcurrency] = useState(1); const [maxTokens, setMaxTokens] = useState(512); const [inputBytes, setInputBytes] = useState(32768); const [prompt, setPrompt] = useState("");
  const [review, setReview] = useState<BenchmarkSpec>(); const [closeReview, setCloseReview] = useState(false);
  const [metric, setMetric] = useState<Metric>("ttftMs"); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0); const busyRef = useRef(false); const confirmRef = useRef<HTMLButtonElement>(null);
  const enabled = preview || (available && !!sessionId);
  const invoke = useCallback(async <K extends keyof BenchmarkResultMap>(kind: K, input: CommandInput<K>): Promise<BenchmarkResultMap[K]> => {
    const handle = await client.command(kind, input); return (await waitReceipt<{ result: BenchmarkResultMap[K] }>(client, handle.requestId)).result;
  }, [client]);
  useEffect(() => {
    epoch.current++; busyRef.current = false; setBusy(false); setError(""); setNotice(""); setReview(undefined); setCloseReview(false);
    setRuns(preview ? [PREVIEW_BENCHMARK.run] : []); setSelected(preview ? PREVIEW_BENCHMARK.run.id : undefined); setSnapshot(preview ? PREVIEW_BENCHMARK : undefined); setPicked([]);
    return () => { epoch.current++; };
  }, [preview, sessionId, available]);
  useEffect(() => { if (review) confirmRef.current?.focus(); }, [review]);
  useEffect(() => {
    if (preview || !enabled || !sessionId) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!document.hidden) {
          const list = await invoke("benchmarks.list", { sessionId });
          if (!active) return; setRuns(list.runs);
          const id = selected ?? list.runs.at(-1)?.id;
          if (id) { const result = await invoke("benchmarks.read", { sessionId, id }); if (active) { setSnapshot(result); if (!selected) setSelected(id); } }
        }
      } catch (cause) { if (active) setError(hostErrorMessage(cause, "Benchmark status unavailable")); }
      finally { if (active) timer = setTimeout(() => void poll(), 1500); }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [preview, enabled, sessionId, selected, invoke, refresh]);
  const runAction = async (action: (generation: number) => Promise<void>) => {
    if (busyRef.current) return; const generation = epoch.current; busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(generation); } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, "Benchmark action failed")); }
    finally { if (generation === epoch.current) { busyRef.current = false; setBusy(false); } }
  };
  const choices = useMemo(() => preview ? PREVIEW_BENCHMARK.run.spec.models.map(selector => ({ selector, name: selector })) : models.filter(model => (model.kind ?? "chat") === "chat").map(model => ({ selector: model.selector, name: model.name })), [models, preview]);
  const filtered = choices.filter(model => `${model.name} ${model.selector}`.toLowerCase().includes(search.toLowerCase()));
  const ranked = useMemo(() => [...(snapshot?.models ?? [])].sort((left, right) => {
    const a = (snapshot?.run.spec.profile === "mix" ? left.byChallenge.chat : left.stats)?.[metric].mean;
    const b = (snapshot?.run.spec.profile === "mix" ? right.byChallenge.chat : right.stats)?.[metric].mean;
    if (a === undefined) return b === undefined ? 0 : 1; if (b === undefined) return -1;
    return metric === "ttftMs" ? a - b : b - a;
  }), [snapshot, metric]);
  const prepare = () => {
    const spec: BenchmarkSpec = { models: picked, profile, runs: count, concurrency, maxTokens,
      ...(profile === "prefill" || profile === "mix" ? { prefillBytes: inputBytes } : {}), ...(profile === "cache" ? { cachePrefixBytes: inputBytes } : {}),
      ...((profile === "chat" || profile === "generation") && prompt.trim() ? { prompt: prompt.trim() } : {}),
    };
    try { validateBenchmarkSpec(spec); setReview(structuredClone(spec)); setError(""); } catch (cause) { setError(hostErrorMessage(cause, "Invalid benchmark input")); }
  };
  const start = () => void runAction(async generation => {
    if (!review) return;
    if (preview) { const value = { ...structuredClone(PREVIEW_BENCHMARK), run: { ...PREVIEW_BENCHMARK.run, id: "demo-" + crypto.randomUUID(), spec: review } }; setSnapshot(value); setRuns(rows => [...rows, value.run]); setSelected(value.run.id); setReview(undefined); return; }
    const value = await invoke("benchmarks.start", { sessionId: sessionId!, spec: review });
    if (generation === epoch.current) { setSelected(value.run.id); setSnapshot({ run: value.run, models: [] }); setReview(undefined); setRefresh(value => value + 1); }
  });
  const save = () => void runAction(async generation => {
    if (!snapshot || running(snapshot.run)) return;
    if (preview) { setNotice(t("演示：报告已存入产物库", "Demo: report saved to artifact library")); return; }
    const handle = await client.command("artifacts.saveText", { kind: "benchmark", name: snapshot.run.id + ".json", text: JSON.stringify({ schemaVersion: 1, ...snapshot }), ...(workspaceId ? { workspaceId } : {}), sessionId: snapshot.run.sessionId, runId: snapshot.run.id });
    await waitReceipt(client, handle.requestId); if (generation === epoch.current) setNotice(t("报告已存入产物库，可在媒体页导出。", "Report saved. Export it from the Media artifact library."));
  });
  return <div className="benchmark-pane">
    <p className="muted">{t("对比原生基准工作负载。每个模型会发起多次独立请求；切换会话会中止当前测试。", "Compare native benchmark workloads. Each model receives multiple independent requests. Switching sessions cancels the run.")}{preview ? t(" · 演示", " · Demo") : ""}</p>
    {!enabled ? <p role="status">{t("连接活动会话后可运行基准。", "Connect an active session to run benchmarks.")}</p> : null}
    {error ? <p role="alert" className="benchmark-error">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    <details className="benchmark-setup" open={!snapshot}><summary>{t("测试配置", "Benchmark configuration")}</summary>
      <div className="benchmark-config-grid"><div><label>{t("搜索聊天模型", "Search chat models")}<input className="input" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="benchmark-models">{filtered.slice(0, 100).map(model => <label key={model.selector}><input type="checkbox" checked={picked.includes(model.selector)} disabled={busy || (!picked.includes(model.selector) && picked.length >= 8)} onChange={event => setPicked(rows => event.target.checked ? [...rows, model.selector] : rows.filter(id => id !== model.selector))} /><span>{model.name}<small className="muted">{model.selector}</small></span></label>)}</div><p className="small muted">{picked.length}/8 {t("已选", "selected")}{filtered.length > 100 ? t(" · 请搜索缩小范围", " · Search to narrow the list") : ""}</p>{picked.length ? <p className="small mono">{picked.join(", ")}</p> : null}</div>
      <div className="benchmark-fields"><label>{t("工作负载", "Workload")}<select className="select" value={profile} onChange={event => { const value = event.target.value as BenchmarkSpec["profile"]; setProfile(value); setMetric(value === "prefill" ? "prefillTps" : value === "generation" ? "generationTps" : "ttftMs"); if (value === "cache") { setCount(Math.min(count, 10)); setConcurrency(Math.min(concurrency, 4)); } }}><option value="chat">Chat</option><option value="prefill">Prefill</option><option value="generation">Generation</option><option value="mix">Mix</option><option value="cache">Cache · cold / warm</option></select></label>
        <label>{profile === "cache" ? t("每个模型的冷/热对数", "Cold/warm pairs per model") : t("每个模型的请求数", "Requests per model")}<input className="input" type="number" min={1} max={profile === "cache" ? 10 : 20} value={count} onChange={event => setCount(Number(event.target.value))} /></label>
        <label>{t("单模型并发", "Concurrency per model")}<input className="input" type="number" min={1} max={profile === "cache" ? 4 : 8} value={concurrency} onChange={event => setConcurrency(Number(event.target.value))} /></label>
        <label>{t("每次最大输出 token", "Max output tokens per request")}<input className="input" type="number" min={1} max={8192} value={maxTokens} onChange={event => setMaxTokens(Number(event.target.value))} /></label>
        {profile === "mix" || profile === "prefill" || profile === "cache" ? <label>{t("合成输入字节数", "Synthetic input bytes")}<input className="input" type="number" min={1024} max={262144} step={1024} value={inputBytes} onChange={event => setInputBytes(Number(event.target.value))} /></label> : <label>{t("自定义提示词（留空用原生工作负载）", "Custom prompt (blank uses native workload)")}<textarea className="input" rows={3} maxLength={8000} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>}
      </div></div><button className="btn small primary" disabled={!enabled || busy || runs.some(running)} onClick={prepare}>{t("检查测试请求", "Review benchmark requests")}</button>
    </details>
    {review ? <section className="benchmark-review" aria-label={t("确认基准测试", "Confirm benchmark")}><p>{review.models.join(", ")} · {review.profile} · {review.models.length * review.runs * (review.profile === "cache" ? 2 : 1)} {t("次模型请求", "model requests")} · {review.maxTokens} {t("输出 token / 次", "output tokens/request")}</p><p>{t("这会产生模型费用。实际费用取决于输入、输出、服务档位及重试；展示的零费用也可能表示价格缺失。", "This starts paid model requests. Actual costs depend on input, output, service tier and retries. Zero reported cost may mean missing pricing.")}</p><details><summary>{t("查看冻结配置", "Inspect reviewed configuration")}</summary><pre>{JSON.stringify(review, null, 2)}</pre></details><button ref={confirmRef} className="btn small primary" disabled={busy || !enabled} onClick={start}>{t("确认并开始基准", "Confirm and start benchmark")}</button><button className="btn small" onClick={() => setReview(undefined)}>{t("返回", "Back")}</button></section> : null}
    <div className="benchmark-toolbar"><label>{t("本 Runtime 的测试", "Runs in this Runtime")}<select className="select" value={selected ?? ""} onChange={event => { setSelected(event.target.value); setCloseReview(false); if (preview) setSnapshot({ ...PREVIEW_BENCHMARK, run: runs.find(run => run.id === event.target.value)! }); else setSnapshot(undefined); }}><option value="" disabled>{t("选择测试", "Choose run")}</option>{runs.map(run => <option key={run.id} value={run.id}>{run.spec.profile} · {new Date(run.createdAt).toLocaleTimeString()} · {run.state}</option>)}</select></label><label>{t("排名指标", "Rank by")}<select className="select" value={metric} onChange={event => setMetric(event.target.value as Metric)}><option value="ttftMs">TTFT ↓</option><option value="tokensPerSecond">Total tok/s ↑</option><option value="generationTps">Decode tok/s ↑</option><option value="prefillTps">Prefill tok/s ↑</option></select></label></div>
    {snapshot ? <>
      <p className="small mono">{snapshot.run.state} · {snapshot.run.id}</p>{snapshot.run.error ? <p role="alert">{snapshot.run.error}</p> : null}
      <div className="benchmark-toolbar"><button className="btn small" disabled={busy || !enabled || snapshot.run.state !== "running"} onClick={() => void runAction(async generation => { if (preview) { setSnapshot(value => value ? { ...value, run: { ...value.run, state: "cancelled" } } : value); return; } await invoke("benchmarks.cancel", { sessionId: sessionId!, id: snapshot.run.id }); if (generation === epoch.current) setRefresh(value => value + 1); })}>{t("取消测试", "Cancel run")}</button><button className="btn small outline" disabled={busy || running(snapshot.run)} onClick={save}>{t("保存基准报告", "Save benchmark report")}</button><button className="btn small outline" disabled={busy || running(snapshot.run)} onClick={() => setCloseReview(true)}>{t("关闭测试记录", "Close run")}</button></div>
      {closeReview ? <div className="benchmark-review"><p>{t("关闭会释放当前内存报告，请先保存。已保存的产物会保留。", "Closing releases this report from memory. Save it first; saved artifacts remain.")}</p><button className="btn small" disabled={busy} onClick={() => void runAction(async generation => { if (!preview) await invoke("benchmarks.close", { sessionId: sessionId!, id: snapshot.run.id }); if (generation === epoch.current) { setRuns(rows => rows.filter(row => row.id !== snapshot.run.id)); setSelected(undefined); setSnapshot(undefined); setCloseReview(false); setRefresh(value => value + 1); } })}>{t("确认关闭", "Confirm close")}</button><button className="btn small" onClick={() => setCloseReview(false)}>{t("返回", "Back")}</button></div> : null}
      <p className="small muted">{t("费用仅含原生报告记录的请求；失败请求可能仍计费。Mix 排名使用 Chat 项，展开行查看各工作负载。", "Costs cover requests recorded by the native report; failures may still be billed. Mix ranking uses Chat. Expand rows for each workload.")}</p>
      <div className="benchmark-table"><table><thead><tr><th>#</th><th>{t("模型", "Model")}</th><th>{t("进度", "Progress")}</th><th>TTFT p50/p95 ms</th><th>Prefill tok/s</th><th>Decode tok/s</th><th>Total tok/s</th><th>USD / {t("成功请求", "success")}</th></tr></thead><tbody>{ranked.map((row, index) => {
        const stats: BenchmarkStats | null | undefined = snapshot.run.spec.profile === "mix" ? row.byChallenge.chat : row.stats;
        return <tr key={row.selector}><td>{stats ? index + 1 : "—"}</td><td><details><summary>{row.model}</summary><pre>{JSON.stringify({ byChallenge: row.byChallenge, measurements: row.measurements }, null, 2)}</pre></details></td><td>{row.completed}/{row.total} · {row.failed} {t("失败", "failed")}<br /><span className="muted">{row.inFlight} {t("进行中", "in flight")}</span></td><td>{stats ? `${stats.ttftMs.p50.toFixed(0)} / ${stats.ttftMs.p95.toFixed(0)}` : "—"}</td><td>{stats?.prefillTps.mean.toFixed(1) ?? "—"}</td><td>{stats?.generationTps.mean.toFixed(1) ?? "—"}</td><td>{stats?.tokensPerSecond.mean.toFixed(1) ?? "—"}</td><td>{stats ? "$" + stats.cost.toFixed(5) : "—"}</td></tr>;
      })}</tbody></table></div>
    </> : <p className="muted">{t("尚无基准报告；不会自动发起测试。", "No benchmark report; tests start only when you request them.")}</p>}
  </div>;
}
