import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientBootstrap, CommandInput, StudioClient } from "@omp-studio/client-contract";
import { validateJudgmentBatchSpec, type JudgmentBatchSpec, type JudgmentBatchRow, type JudgmentBatchPage, type JudgmentResultMap, type JudgmentQuestion } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { PREVIEW_JUDGMENT_BATCH, PREVIEW_JUDGMENT_ITEMS, PREVIEW_JUDGMENT_SPEC } from "../preview/judgmentsPreview";
import "./judgments.css";

type QuestionDraft = { id: string; type: "bool" | "choice" | "score"; instructions: string; criteria: string };
type Confirmation = { kind: "create"; spec: JudgmentBatchSpec } | { kind: "retry" | "cancel" | "close"; batch: JudgmentBatchRow };
const emptyQuestion = (index = 1): QuestionDraft => ({ id: "q" + index, type: "bool", instructions: "", criteria: "" });
function buildSpec(intent: string, itemsText: string, json: boolean, questions: QuestionDraft[], concurrency: number, retries: number, minOk: number): JudgmentBatchSpec {
  const items: JudgmentBatchSpec["items"] = json ? JSON.parse(itemsText) : itemsText.split(/\r?\n/u).filter(line => line.trim()).map((state, key) => ({ key, state }));
  const questionMap: Record<string, JudgmentQuestion> = {};
  for (const question of questions) {
    if (["__proto__", "constructor", "prototype"].includes(question.id) || Object.hasOwn(questionMap, question.id)) throw new Error("Question IDs must be unique and safe");
    const lines = question.criteria.split(/\r?\n/u).filter(line => line.trim());
    questionMap[question.id] = question.type === "bool" ? { type: "bool", instructions: question.instructions }
      : question.type === "score" ? { type: "score", instructions: question.instructions, criteria: lines }
        : { type: "choice", instructions: question.instructions, criteria: Object.fromEntries(lines.map(line => { const colon = line.indexOf(":"); return colon < 0 ? [line.trim(), null] : [line.slice(0, colon).trim(), line.slice(colon + 1).trim() || null]; })) };
  }
  const spec = { intent, items, questions: questionMap, concurrency, retries, minOk }; validateJudgmentBatchSpec(spec); return spec;
}

export function JudgmentsPane({ client, workspaceId, sessionId, available, capabilities }: {
  client?: StudioClient | undefined; workspaceId?: string | undefined; sessionId?: string | undefined;
  available: boolean; capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
}) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const t = (cn: string, en: string) => zh ? cn : en;
  const [open, setOpen] = useState(false); const [batches, setBatches] = useState<JudgmentBatchRow[]>([]);
  const [listCursor, setListCursor] = useState<string>(); const [nextCursor, setNextCursor] = useState<string>();
  const [selected, setSelected] = useState<string>(); const [page, setPage] = useState<JudgmentBatchPage>();
  const [offset, setOffset] = useState(0); const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const [attachId, setAttachId] = useState(""); const [form, setForm] = useState(false);
  const [intent, setIntent] = useState(""); const [items, setItems] = useState(""); const [jsonItems, setJsonItems] = useState(false);
  const [questions, setQuestions] = useState<QuestionDraft[]>([emptyQuestion()]);
  const [concurrency, setConcurrency] = useState(4); const [retries, setRetries] = useState(1); const [minOk, setMinOk] = useState(1);
  const [confirmation, setConfirmation] = useState<Confirmation>(); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [refresh, setRefresh] = useState(0);
  const generation = useRef(0); const busyRef = useRef(false); const confirmRef = useRef<HTMLButtonElement>(null);
  const canRead = preview || (available && !!client && !!sessionId && capabilities?.capabilities.some(item => item.id === "judgments.read" && item.grade !== "unavailable") === true);
  const canCreate = preview || (canRead && capabilities?.capabilities.some(item => item.id === "judgments.create" && item.grade !== "unavailable") === true);
  const invoke = useCallback(async <K extends keyof JudgmentResultMap>(kind: K, input: CommandInput<K>): Promise<JudgmentResultMap[K]> => {
    if (!client || !sessionId || !available) throw new Error("Batch judgments need a connected active session");
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: JudgmentResultMap[K] }>(client, handle.requestId)).result;
  }, [client, sessionId, available]);
  useEffect(() => {
    generation.current++; busyRef.current = false; setBusy(false); setError(""); setNotice(""); setConfirmation(undefined);
    setBatches(preview ? [structuredClone(PREVIEW_JUDGMENT_BATCH)] : []); setPage(undefined); setSelected(undefined); setOffset(0); setListCursor(undefined); setNextCursor(undefined); setPreviousOffsets([]);
    setForm(false); setIntent(""); setItems(""); setQuestions([emptyQuestion()]); setAttachId("");
    return () => { generation.current++; };
  }, [sessionId, workspaceId, preview, available]);
  useEffect(() => { if (confirmation) confirmRef.current?.focus(); }, [confirmation]);
  useEffect(() => {
    if (!open || !canRead || preview || !sessionId) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!document.hidden) {
          const result = await invoke("judgments.list", { sessionId, ...(listCursor ? { cursor: listCursor } : {}), limit: 50 });
          if (active) { setBatches(result.batches); setNextCursor(result.nextCursor); }
        }
      } catch (cause) { if (active) setError(hostErrorMessage(cause, "Cannot read judgment batches")); }
      finally { if (active) timer = setTimeout(() => void poll(), 4000); }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [open, canRead, preview, sessionId, listCursor, invoke, refresh]);
  useEffect(() => {
    setPage(undefined);
    if (!open || !canRead || !selected) return;
    if (preview) { const batch = batches.find(row => row.id === selected); if (batch) setPage({ batch, items: batch.id === "demo-judgment" ? PREVIEW_JUDGMENT_ITEMS : [{ key: "demo", answers: { result: { type: "bool", bool: 0.97 } } }], offset: 0, nextOffset: batch.done }); return; }
    if (!sessionId) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!document.hidden) {
          const result = await invoke("judgments.read", { sessionId, id: selected, offset, limit: 25 });
          if (active) setPage(result);
        }
      } catch (cause) { if (active) setError(hostErrorMessage(cause, "Cannot read this batch")); }
      finally { if (active) timer = setTimeout(() => void poll(), 4000); }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [open, canRead, selected, offset, preview, sessionId, invoke, refresh, preview ? batches : undefined]);
  const choose = (id: string) => { setSelected(id); setOffset(0); setPreviousOffsets([]); setError(""); setConfirmation(undefined); };
  const run = async (action: (epoch: number) => Promise<void>) => {
    if (busyRef.current) return;
    const epoch = generation.current; busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(epoch); }
    catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, "Judgment operation failed")); }
    finally { if (epoch === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  const submit = () => void run(async epoch => {
    if (!confirmation) return;
    if (preview) {
      if (confirmation.kind === "close") { setBatches(rows => rows.filter(row => row.id !== confirmation.batch.id)); setSelected(undefined); }
      else if (confirmation.kind === "cancel") setBatches(rows => rows.map(row => row.id === confirmation.batch.id ? { ...row, running: false, error: "Demo: cancelled" } : row));
      else { const batch = { ...PREVIEW_JUDGMENT_BATCH, id: "demo-" + crypto.randomUUID(), intent: confirmation.kind === "create" ? confirmation.spec.intent : confirmation.batch.intent, total: 1, done: 1, failed: 0, cost: 0 }; setBatches(rows => [batch, ...rows]); choose(batch.id); setForm(false); }
      setConfirmation(undefined); return;
    }
    if (!sessionId) throw new Error("No active session");
    if (confirmation.kind === "create" || confirmation.kind === "retry") {
      const result = confirmation.kind === "create" ? await invoke("judgments.create", { sessionId, spec: confirmation.spec }) : await invoke("judgments.retry", { sessionId, id: confirmation.batch.id });
      if (epoch !== generation.current) return;
      choose(result.batch.id); setForm(false); setListCursor(undefined);
    } else {
      const { kind, batch } = confirmation;
      await invoke(kind === "close" ? "judgments.close" : "judgments.cancel", { sessionId, id: batch.id });
      if (epoch !== generation.current) return;
      if (kind === "close") { setSelected(undefined); setPage(undefined); }
    }
    setConfirmation(undefined); setRefresh(value => value + 1);
  });
  const saveResults = () => void run(async epoch => {
    if (preview) { setNotice(t("演示：结果已存入产物库", "Demo: results saved to artifact library")); return; }
    if (!client || !sessionId || !page || page.batch.running) throw new Error("Wait for the batch to finish or cancel it before saving results");
    const batchId = page.batch.id; let start = 0; let parts = 0;
    do {
      if (epoch !== generation.current) return;
      const result = await invoke("judgments.read", { sessionId, id: batchId, offset: start, limit: 50 });
      if (epoch !== generation.current) return;
      if (result.batch.running || (result.nextOffset === start && start < result.batch.done)) throw new Error("Batch results changed; refresh before saving");
      const handle = await client.command("artifacts.saveText", { kind: "judgment", name: `${batchId}-part-${++parts}.json`, text: JSON.stringify({ schemaVersion: 1, ...result }), ...(workspaceId ? { workspaceId } : {}), sessionId, runId: batchId });
      await waitReceipt(client, handle.requestId);
      if (epoch !== generation.current) return;
      setNotice(t(`已保存 ${parts} 份结果；可在产物库导出。`, `Saved ${parts} result parts; export them from the artifact library.`));
      if (result.nextOffset >= result.batch.done) break;
      start = result.nextOffset;
    } while (parts < 10000);
  });
  const updateQuestion = (index: number, patch: Partial<QuestionDraft>) => setQuestions(rows => rows.map((row, position) => position === index ? { ...row, ...patch } : row));
  return <details className="judgments-pane" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("批量评审", "Batch judgments")}{preview ? t(" · 演示", " · Demo") : ""}</summary>
    {open ? <div className="judgments-content">
      <p className="small muted">{t("使用当前会话的 Judge 模型链。仅显示本会话主代理的批次；关闭批次会释放内存，已保存的产物继续保留。", "Uses this session’s Judge chain. Shows batches owned by the main agent in this session. Closing releases memory and preserves saved artifacts.")}</p>
      {!canRead ? <p role="status" className="muted">{t("连接支持批量评审的活动会话后可用。", "Connect an active session with batch judgment support.")}</p> : null}
      {error ? <p role="alert" className="judgment-error">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
      <div className="judgment-toolbar"><button className="btn small" disabled={!canCreate || busy} onClick={() => { setForm(value => !value); setConfirmation(undefined); }}>{t("新建批次", "New batch")}</button><button className="btn small outline" disabled={!canRead || busy} onClick={() => setRefresh(value => value + 1)}>{t("刷新", "Refresh")}</button><input className="input mono" aria-label={t("批次 ID", "Batch ID")} placeholder="jdgb-…" value={attachId} maxLength={512} onChange={event => setAttachId(event.target.value)} /><button className="btn small outline" disabled={!canRead || busy || !attachId.trim()} onClick={() => choose(attachId.trim())}>{t("接续查看", "Attach")}</button></div>
      {form ? <section className="judgment-form" aria-label={t("新建评审批次", "Create judgment batch")}>
        <label>{t("名称", "Label")}<input className="input" maxLength={256} value={intent} onChange={event => setIntent(event.target.value)} /></label>
        <label>{t("输入格式", "Input format")}<select className="select" value={jsonItems ? "json" : "lines"} onChange={event => setJsonItems(event.target.value === "json")}><option value="lines">{t("每行一条文本", "One text item per line")}</option><option value="json">JSON: [{'{"key":"id","state":"text or object"}'}]</option></select></label>
        <label>{t("待评审内容", "Items to judge")}<textarea className="input mono" rows={5} maxLength={600000} value={items} onChange={event => setItems(event.target.value)} /></label>
        <label className="small">{t("导入文本或 JSON（最大 600 KB）", "Import text or JSON (up to 600 KB)")}<input type="file" accept=".txt,.json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (!file) return; void run(async epoch => { if (file.size > 600000) throw new Error("Input file exceeds 600 KB"); const text = await file.text(); if (epoch === generation.current) { setItems(text); setJsonItems(file.name.toLowerCase().endsWith(".json")); } }); event.target.value = ""; }} /></label>
        {questions.map((question, index) => <fieldset key={index} disabled={busy} className="judgment-question"><legend>{t("问题", "Question")} {index + 1}</legend><div className="judgment-toolbar"><label>ID<input className="input mono" value={question.id} maxLength={128} onChange={event => updateQuestion(index, { id: event.target.value })} /></label><label>{t("类型", "Type")}<select className="select" value={question.type} onChange={event => updateQuestion(index, { type: event.target.value as QuestionDraft["type"], criteria: "" })}><option value="bool">{t("是 / 否概率", "Yes / no probability")}</option><option value="choice">{t("分类", "Choice")}</option><option value="score">{t("有序评分", "Ordered score")}</option></select></label><button className="btn small" disabled={questions.length === 1} onClick={() => setQuestions(rows => rows.filter((_, position) => position !== index))}>{t("移除问题", "Remove question")}</button></div><label>{t("判断说明", "Instructions")}<textarea className="input" rows={2} maxLength={8000} value={question.instructions} onChange={event => updateQuestion(index, { instructions: event.target.value })} /></label>{question.type !== "bool" ? <label>{question.type === "choice" ? t("每行：选项: 判断标准（至少两项）", "One option: rubric per line (at least two)") : t("每行一个评分等级，从低到高（至少两级）", "One level per line, lowest to highest (at least two)")}<textarea className="input" rows={3} maxLength={64000} value={question.criteria} onChange={event => updateQuestion(index, { criteria: event.target.value })} /></label> : null}</fieldset>)}
        <button className="btn small outline" disabled={busy || questions.length >= 16} onClick={() => setQuestions(rows => [...rows, emptyQuestion(rows.length + 1)])}>{t("添加问题", "Add question")}</button>
        <div className="judgment-toolbar"><label>{t("并发", "Concurrency")}<input className="input" type="number" min={1} max={32} value={concurrency} onChange={event => setConcurrency(event.target.valueAsNumber)} /></label><label>{t("单条自动重试", "Retries per item")}<input className="input" type="number" min={0} max={5} value={retries} onChange={event => setRetries(event.target.valueAsNumber)} /></label><label>{t("最低成功数", "Minimum successes")}<input className="input" type="number" min={0} max={500} value={minOk} onChange={event => setMinOk(event.target.valueAsNumber)} /></label></div>
        {preview ? <button className="btn small" onClick={() => { setIntent(PREVIEW_JUDGMENT_SPEC.intent); setItems(JSON.stringify(PREVIEW_JUDGMENT_SPEC.items, null, 2)); setJsonItems(true); setQuestions([{ id: "clear", type: "bool", instructions: PREVIEW_JUDGMENT_SPEC.questions.clear!.instructions, criteria: "" }]); }}>{t("填入演示内容", "Fill demo content")}</button> : null}
        <button className="btn small primary" disabled={busy || !canCreate} onClick={() => { try { setConfirmation({ kind: "create", spec: buildSpec(intent, items, jsonItems, questions, concurrency, retries, minOk) }); setError(""); } catch (cause) { setError(hostErrorMessage(cause, "Invalid batch input")); } }}>{t("检查并准备开始", "Review before starting")}</button>
      </section> : null}
      {confirmation ? <section className="judgment-confirm" aria-label={t("确认批次操作", "Confirm batch action")}>
        <p>{confirmation.kind === "create" ? `${confirmation.spec.intent} · ${confirmation.spec.items.length} ${t("条", "items")} · ${Object.keys(confirmation.spec.questions).length} ${t("个问题", "questions")} · ${t("并发", "concurrency")} ${confirmation.spec.concurrency} · ${t("每条最多尝试", "attempts per item")} ${confirmation.spec.retries + 1}` : `${confirmation.batch.intent} · ${confirmation.batch.id}`}</p>
        <p>{confirmation.kind === "create" || confirmation.kind === "retry" ? t(confirmation.kind === "retry" ? `将为 ${confirmation.batch.failed} 条失败项新建批次，保留原结果。使用当前 Judge 链，会产生模型费用；回退和重试也可能计费。` : "将按上方冻结的内容发起模型请求。使用当前 Judge 链，会产生模型费用；回退和重试也可能计费。", "Starts paid requests using the current Judge chain. Failed-item retries create a separate batch and preserve original results. Fallback attempts may also be billed.") : confirmation.kind === "cancel" ? t("停止尚未完成的请求；已发生的费用仍保留。", "Abort unfinished requests; costs already incurred remain.") : t("关闭并释放批次输入和结果。请先保存需要的结果；已保存产物继续保留。", "Close and release inputs and results. Save required results first; saved artifacts remain.")}</p>
        {confirmation.kind === "create" ? <details><summary>{t("检查实际请求内容", "Inspect the request")}</summary><pre>{JSON.stringify(confirmation.spec, null, 2)}</pre></details> : null}
        <button ref={confirmRef} className="btn small primary" disabled={busy || !canRead} onClick={submit}>{t("确认执行", "Confirm")}</button><button className="btn small" disabled={busy} onClick={() => setConfirmation(undefined)}>{t("返回", "Back")}</button>
      </section> : null}
      <div className="judgment-workspace"><nav className="judgment-batches" aria-label={t("评审批次", "Judgment batches")}>{batches.map(batch => <button className={selected === batch.id ? "selected" : ""} key={batch.id} onClick={() => choose(batch.id)}><strong>{batch.intent}</strong><span className="small mono">{batch.done}/{batch.total} · {batch.failed} {t("失败", "failed")} · ${batch.cost.toFixed(4)}</span><span className="small muted">{batch.running ? t("运行中", "Running") : t("已结束", "Finished")}</span></button>)}{!batches.length ? <p className="small muted">{t("暂无本会话批次", "No batches in this session")}</p> : null}<div className="judgment-toolbar">{listCursor ? <button className="btn small" onClick={() => setListCursor(undefined)}>{t("回到开头", "First page")}</button> : null}{nextCursor ? <button className="btn small" onClick={() => setListCursor(nextCursor)}>{t("更多批次", "More batches")}</button> : null}</div></nav>
      <section className="judgment-results" aria-label={t("评审结果", "Judgment results")}>{page ? <>
        <h3>{page.batch.intent}</h3><p className="small mono">{page.batch.id} · {page.batch.done}/{page.batch.total} · ${page.batch.cost.toFixed(4)} · {page.batch.elapsedS}s</p><progress aria-label={t("完成进度", "Completion")} value={page.batch.done} max={Math.max(1, page.batch.total)} />
        {page.batch.error ? <p className="judgment-error">{page.batch.error}</p> : null}<p className="small muted">{page.batch.model ?? t("等待模型结果", "Awaiting a model result")}</p>
        <div className="judgment-toolbar"><button className="btn small" disabled={busy || !page.batch.running} onClick={() => setConfirmation({ kind: "cancel", batch: page.batch })}>{t("取消批次", "Cancel batch")}</button><button className="btn small" disabled={busy || page.batch.running || !page.batch.failed || !canCreate} onClick={() => setConfirmation({ kind: "retry", batch: page.batch })}>{t("重试失败项", "Retry failed items")}</button><button className="btn small" disabled={busy || page.batch.running} onClick={saveResults}>{t("保存全部结果", "Save all results")}</button><button className="btn small outline" disabled={busy} onClick={() => setConfirmation({ kind: "close", batch: page.batch })}>{t("关闭批次", "Close batch")}</button></div>
        <p className="small muted">{t("JSON 结果按页存入产物库，在媒体页选择产物后可导出。", "JSON results are saved as pages in the artifact library; export them from Media.")}</p>
        <div className="judgment-table"><table><thead><tr><th>Key</th><th>{t("结果", "Result")}</th><th>{t("模型", "Model")}</th></tr></thead><tbody>{page.items.map((item, index) => <tr key={page.offset + index}><td className="mono">{String(item.key)}</td><td>{item.error ? <span className="judgment-error">{item.error}</span> : Object.entries(item.answers ?? {}).map(([id, answer]) => <details key={id}><summary><strong>{id}</strong>: {answer.type === "bool" ? `P(yes) ${(answer.bool * 100).toFixed(1)}%` : answer.type === "choice" ? answer.choice : answer.score.toFixed(3)}</summary><pre>{JSON.stringify(answer, null, 2)}</pre></details>)}</td><td className="small">{item.model ?? "—"}</td></tr>)}</tbody></table></div>
        <div className="judgment-toolbar"><button className="btn small" disabled={!previousOffsets.length || busy} onClick={() => { setOffset(previousOffsets.at(-1)!); setPreviousOffsets(rows => rows.slice(0, -1)); }}>{t("上一页", "Previous")}</button><span className="small">{page.offset + (page.items.length ? 1 : 0)}–{page.nextOffset} / {page.batch.done}</span><button className="btn small" disabled={busy || page.nextOffset >= page.batch.done} onClick={() => { setPreviousOffsets(rows => [...rows, offset]); setOffset(page.nextOffset); }}>{t("下一页", "Next")}</button></div>
      </> : <p className="muted">{selected ? t("正在读取批次…", "Reading batch…") : t("选择批次查看进度与结果", "Select a batch to view progress and results")}</p>}</section></div>
    </div> : null}
  </details>;
}
