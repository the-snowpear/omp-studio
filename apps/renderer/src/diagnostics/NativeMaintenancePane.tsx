import { AppSelect } from "../AppSelect";
import { useEffect, useRef, useState } from "react";
import type {
  ClientBootstrap,
  StudioClient,
  CommandInput,
} from "@omp-studio/client-contract";
import type {
  GcCategory,
  GcStatus,
  GcStripOptions,
  MaintenanceResultMap,
  SessionExportStatus,
  NativeConnectionCheck,
} from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import {
  previewGc,
  previewSessionExport,
  previewConnectionCheck,
} from "../preview/maintenancePreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { WorkspaceEmpty, WorkspaceStatus } from "../workspaces/Workspace";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import "./maintenance.css";
const CATEGORIES: GcCategory[] = ["blobs", "archive", "wal", "stale"];
const LABELS: Record<GcCategory, [string, string]> = {
  blobs: ["无引用附件", "Unreferenced attachments"],
  archive: ["冷会话归档", "Cold session archive"],
  wal: ["数据库日志", "Database journals"],
  stale: ["过期报告与副本", "Expired reports and replicas"],
};
export function NativeMaintenancePane({
  client,
  sessionId,
  available,
  capabilities,
  active,
}: {
  client: StudioClient;
  sessionId?: string | undefined;
  available: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
  active: boolean;
}) {
  const { preview, marks } = usePreviewMode(),
    { resolvedLanguage } = useI18n(),
    zh = resolvedLanguage === "zh";
  const [categories, setCategories] = useState<GcCategory[]>([
      "blobs",
      "archive",
      "wal",
    ]),
    [gc, setGc] = useState<GcStatus>({ phase: "idle" }),
    [exportState, setExport] = useState<SessionExportStatus>({ phase: "idle" });
  const [stripEnabled, setStripEnabled] = useState(false);
  const [stripDays, setStripDays] = useState("");
  const stripDaysValid = stripDays.trim() === "" || (Number.isSafeInteger(Number(stripDays)) && Number(stripDays) >= 0);
  const strip: GcStripOptions | undefined = stripEnabled
    ? (stripDays.trim() === "" ? {} : { idleDays: Number(stripDays) })
    : undefined;
  const [connection, setConnection] = useState<NativeConnectionCheck>(),
    [latency, setLatency] = useState<number>();
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [exportFormat,setExportFormat]=useState<"archive"|"html">("archive");
  const [exportConfirm,setExportConfirm]=useState(false);
  const epoch = useRef(0),
    lock = useRef(false);
  const doc = useSurfaceDocument();
  const statusEpoch = useRef(0);
  const gcRevision = useRef(0);
  function invalidateGcPreview() {
    gcRevision.current++;
    setGc({ phase: "idle" });
    setConfirm(false);
  }
  const supports = (kind: string) =>
    preview ||
    !!(
      sessionId &&
      available &&
      capabilities?.capabilities.some(
        (row) => row.id === kind && row.grade !== "unavailable",
      )
    );
  async function read<K extends keyof MaintenanceResultMap>(
    kind: K,
    input: CommandInput<K>,
  ): Promise<MaintenanceResultMap[K]> {
    const handle = await client.command(kind, input);
    return (
      await waitReceipt<{ result: MaintenanceResultMap[K] }>(
        client,
        handle.requestId,
      )
    ).result;
  }
  async function refreshStatus(current = epoch.current) {
    if (preview || !active || doc.hidden) return;
    const readingEpoch = statusEpoch.current;
    const revision = gcRevision.current;
    const [gcResult, exportResult] = await Promise.allSettled([
      supports("maintenance.gc.status")
        ? read("maintenance.gc.status", { sessionId: sessionId! })
        : Promise.resolve(undefined),
      supports("maintenance.export.status")
        ? read("maintenance.export.status", { sessionId: sessionId! })
        : Promise.resolve(undefined),
    ]);
    if (current !== epoch.current || readingEpoch !== statusEpoch.current || doc.hidden) return;
    if (revision === gcRevision.current && gcResult.status === "fulfilled" && gcResult.value)
      setGc(gcResult.value);
    if (exportResult.status === "fulfilled" && exportResult.value)
      setExport(exportResult.value);
    const failed = [gcResult, exportResult].find(
      (row) => row.status === "rejected",
    );
    if (failed?.status === "rejected")
      setError(
        hostErrorMessage(
          failed.reason,
          zh ? "读取维护状态失败" : "Cannot read maintenance status",
        ),
      );
  }
  useEffect(() => {
    epoch.current++;
    statusEpoch.current++;
    gcRevision.current++;
    lock.current = false;
    setBusy("");
    setConfirm(false);
    setExportConfirm(false);
    setError("");
    setNotice("");
    setGc({ phase: "idle" });
    setExport({ phase: "idle" });
    setConnection(undefined);

    return () => {
      epoch.current++;
    };
  }, [client, sessionId, available, preview]);
  useEffect(() => {
    statusEpoch.current++;
    if (!active) {
      setConfirm(false);
      setExportConfirm(false);
      return;
    }
    const visibilityChanged = () => {
      statusEpoch.current++;
      if (doc.hidden) {
        setConfirm(false);
        setExportConfirm(false);
      } else if (!preview && available) void refreshStatus();
    };
    if (!preview && available && !doc.hidden) void refreshStatus();
    doc.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      statusEpoch.current++;
      doc.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [active, capabilities?.hash, client, sessionId, available, preview, doc]);
  useEffect(() => {
    if (
      !active ||
      preview ||
      !available ||
      (!["previewing", "applying"].includes(gc.phase) &&
        exportState.phase !== "exporting")
    )
      return;
    let reading = false;
    let timer: number | undefined;
    const poll = () => {
      if (reading || doc.hidden) return;
      reading = true;
      void refreshStatus().finally(() => { reading = false; });
    };
    const visibilityChanged = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = doc.hidden ? undefined : window.setInterval(poll, 1500);
    };
    visibilityChanged();
    doc.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      doc.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [active, preview, available, gc.phase, exportState.phase, sessionId, doc]);
  useEffect(() => {
    const plan = gc.preview;
    if (!plan) return;
    const timeout = setTimeout(
      () => {
        setConfirm(false);
    setExportConfirm(false);
        setGc((current) => {
          if (current.preview?.token !== plan.token) return current;
          const { preview: _preview, ...rest } = current;
          return rest;
        });
        setNotice(
          zh
            ? "清理预览已过期，请重新扫描。"
            : "The cleanup preview expired. Scan again.",
        );
      },
      Math.max(0, Math.min(300001, plan.expiresAt - Date.now())),
    );
    return () => clearTimeout(timeout);
  }, [gc.preview, zh]);
  async function run(kind: "preview" | "apply" | "export" | "connection") {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    setError("");
    setNotice("");
    const current = epoch.current;
    try {
      if (kind === "preview") {
        gcRevision.current++;
        setGc({ phase: "previewing" });
        const result = preview
          ? previewGc(categories, strip)
          : await read("maintenance.gc.preview", {
              sessionId: sessionId!,
              categories,
              ...(strip === undefined ? {} : { strip }),
            });
        if (current === epoch.current) {
          gcRevision.current++;
          if (stripEnabled && !result.summary.strip) {
            setGc({ phase: "failed", summary: result.summary, error: zh
              ? "此 Runtime 未提供供应商回放信息预览，不能确认此操作。未执行清理；请升级 Runtime 后重新扫描。"
              : "This Runtime did not report a provider replay preview, so the operation cannot be confirmed. Nothing was applied; update the Runtime and scan again." });
          } else setGc({ phase: "complete", preview: result, summary: result.summary });
        }
      }
      if (kind === "apply") {
        const plan = gc.preview;
        if (!plan || (stripEnabled && !plan.summary.strip)) return;
        gcRevision.current++;
        setConfirm(false);
    setExportConfirm(false);
        setGc({ phase: "applying", summary: plan.summary });
        const result = preview
          ? {
              ...plan.summary,
              applied: true,
              checkedAt: Date.now(),
              rows: plan.summary.rows.map((row) => ({
                ...row,
                changed: row.candidates,
              })),
              ...(plan.summary.strip ? { strip: { ...plan.summary.strip, changed: plan.summary.strip.candidates } } : {}),
            }
          : await read("maintenance.gc.apply", {
              sessionId: sessionId!,
              token: plan.token,
            });
        if (current === epoch.current) {
          gcRevision.current++;
          setGc({ phase: "complete", summary: result });
          if (preview && marks)
            setNotice(
              zh
                ? "演示清理完成，未修改任何文件。"
                : "Demo completed; no files were changed.",
            );
        }
      }
      if (kind === "export") {
        setExport({ phase: "exporting" });
        const result = preview
          ? previewSessionExport(exportFormat)
          : await read("maintenance.session.export", { sessionId: sessionId!, format: exportFormat });
        if (current === epoch.current) setExport({ phase: "complete", result });
      }
      if (kind === "connection") {
        const start = performance.now(),
          result = preview
            ? previewConnectionCheck()
            : await read("maintenance.connection.check", {
                sessionId: sessionId!,
              });
        if (current === epoch.current) {
          setConnection(result);
          setLatency(Math.round(performance.now() - start));
        }
      }
    } catch (cause) {
      if (current === epoch.current) {
        setError(
          hostErrorMessage(cause, zh ? "维护操作失败" : "Maintenance failed"),
        );
        if (kind === "preview" || kind === "apply") {
          gcRevision.current++;
          setGc(state => ({ phase: "failed", ...(state.summary ? { summary: state.summary } : {}) }));
        }
        if (!preview && available) void refreshStatus(current);
      }
    } finally {
      if (current === epoch.current) {
        lock.current = false;
        setBusy("");
      }
    }
  }
  const working =
    !!busy ||
    ["previewing", "applying"].includes(gc.phase) ||
    exportState.phase === "exporting";
  const label = (category: GcCategory) => LABELS[category][zh ? 0 : 1];
  const summary = gc.summary,
    plan = gc.preview;
  return (
    <section
      className="native-maintenance"
      aria-label={zh ? "原生维护" : "Native maintenance"}
    >
      <header className="workspace-section-heading">
        <div>
          <h2>
            {zh ? "会话与本地数据" : "Sessions and local data"}{" "}
            {preview && marks ? (
              <span className="chip gray xs">{zh ? "演示" : "Demo"}</span>
            ) : null}
          </h2>
          <p>
            {zh
              ? "执行 OMP 原生导出与清理，保留实际结果和失败原因。"
              : "Run native OMP exports and cleanup with their actual results and errors."}
          </p>
        </div>
        <button
          className="btn outline"
          disabled={!supports("maintenance.gc.status") || !!busy}
          onClick={() => void refreshStatus()}
        >
          {zh ? "刷新执行状态" : "Refresh operation status"}
        </button>
      </header>
      {!preview && !available ? (
        <WorkspaceEmpty
          title={
            zh
              ? "连接 Runtime 后可执行维护"
              : "Connect the Runtime to run maintenance"
          }
        />
      ) : null}
      {error ? (
        <p className="maintenance-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <section className="maintenance-section">
        <header>
          <div>
            <h3>{zh ? "完整会话导出" : "Full session export"}</h3>
            <p>
              {zh
                ? "ZIP 包含主会话、子代理与模型请求载荷；HTML 用于浏览已保存的分支和子会话。另存副本不随内部清理删除。"
                : "ZIP includes the main transcript, child agents and model request payload. HTML presents saved branches and child sessions. Saved copies remain independent of internal cleanup."}
            </p>
            <label className="tiny muted">{zh ? "导出格式" : "Export format"} <AppSelect className="select" value={exportFormat} disabled={working} onChange={event => setExportFormat(event.target.value as "archive" | "html")}><option value="archive">ZIP · dump all</option><option value="html">HTML</option></AppSelect></label>
          </div>
          <button
            className="btn outline"
            disabled={!supports("maintenance.session.export") || working}
            onClick={() => setExportConfirm(true)}
          >
            {busy === "export" || exportState.phase === "exporting"
              ? zh
                ? "导出中…"
                : "Exporting…"
              : zh
                ? "导出当前会话"
                : "Export current session"}
          </button>
        </header>
        {exportState.error ? (
          <p role="alert" className="maintenance-error">
            {exportState.error}
          </p>
        ) : null}
        {exportState.result?.warnings.map((warning,index)=><p key={index} role="alert" className="maintenance-error">{warning}</p>)}
        {exportState.result ? (
          <div className="maintenance-export">
            <span>{exportState.result.asset.name}</span>
            <span className="muted">
              {(exportState.result.asset.bytes / 1024).toFixed(0)} KiB · {exportState.result.members} {zh ? "个文件" : "files"}
            </span>
            <button
              className="btn small outline"
              disabled={!preview && !globalThis.ompStudioChrome?.exportArtifact}
              onClick={() => {
                if (preview) {
                  if (marks)
                    setNotice(
                      zh
                        ? "演示产物不会写入本机。"
                        : "Demo artifacts are not written to disk.",
                    );
                  return;
                }
                void globalThis.ompStudioChrome!.exportArtifact!({
                  artifactId: exportState.result!.asset.artifactId,
                })
                  .then((result) => {
                    if (!result.ok) setError(result.message);
                  })
                  .catch((cause) =>
                    setError(
                      hostErrorMessage(cause, zh ? "另存失败" : "Save failed"),
                    ),
                  );
              }}
            >
              {zh ? "另存副本…" : "Save a copy…"}
            </button>
          </div>
        ) : null}
      </section>
      <section className="maintenance-section">
        <header>
          <div>
            <h3>{zh ? "清理预览" : "Cleanup preview"}</h3>
            <p>
              {zh
                ? "范围为当前 Runtime 的 OMP 数据目录，与 CLI 共用，不只当前会话或工作区。先查看原生扫描结果，再确认执行。"
                : "Applies to this Runtime's OMP data directory shared with the CLI, not only the current session or workspace. Review the native scan before applying."}
            </p>
          </div>
          <button
            className="btn outline"
            disabled={
              !supports("maintenance.gc.preview") ||
              working ||
              (!categories.length && !stripEnabled) ||
              (stripEnabled && !stripDaysValid)
            }
            onClick={() => void run("preview")}
          >
            {busy === "preview" || gc.phase === "previewing"
              ? zh
                ? "扫描中…"
                : "Scanning…"
              : zh
                ? "扫描并预览"
                : "Scan and preview"}
          </button>
        </header>
        <fieldset className="maintenance-categories" disabled={working}>
          <legend className="sr-only">
            {zh ? "清理范围" : "Cleanup categories"}
          </legend>
          {CATEGORIES.map((category) => (
            <label key={category}>
              <input
                type="checkbox"
                checked={categories.includes(category)}
                onChange={(event) => {
                  setCategories((old) =>
                    event.target.checked
                      ? [...old, category]
                      : old.filter((value) => value !== category),
                  );
                  invalidateGcPreview();
                  setExportConfirm(false);
                }}
              />
              {label(category)}
            </label>
          ))}
        </fieldset>
        <fieldset className="maintenance-strip" disabled={working || !supports("maintenance.gc.preview")}>
          <legend className="sr-only">{zh ? "供应商回放信息" : "Provider replay data"}</legend>
          <label className="maintenance-strip-toggle">
            <input type="checkbox" checked={stripEnabled} onChange={event => {
              setStripEnabled(event.target.checked);
              invalidateGcPreview();
            }} />
            <span>{zh ? "移除供应商回放信息" : "Remove provider replay data"}</span>
          </label>
          <p id="maintenance-strip-help">
            {zh
              ? "保留会话正文、最新回放轮次及恢复上下文所需的原生状态，只移除过期的供应商回放信息。不是压缩或删除会话。"
              : "Keep transcript content, the latest replay turn and native state required to restore context. Remove only expired provider replay data, not session content or filesystem compression."}
          </p>
          {stripEnabled ? <div className="maintenance-strip-options">
            <label>
              <span>{zh ? "空闲天数" : "Idle days"}</span>
              <input className="input" type="number" min={0} step={1} value={stripDays}
                placeholder={zh ? "继承原生设置" : "Native setting"}
                aria-describedby="maintenance-strip-help"
                aria-invalid={!stripDaysValid || undefined}
                onChange={event => {
                  setStripDays(event.target.value);
                  invalidateGcPreview();
                }} />
            </label>
            <span className="tiny muted">{zh ? "主会话 · 子代理 · 已归档会话；原生写入宽限期与活动租约保护仍生效。" : "Main, child and archived transcripts; native write grace and live-session leases still apply."}</span>
          </div> : null}
          {stripEnabled && !stripDaysValid ? <p className="maintenance-error" role="alert">{zh ? "请输入不小于 0 的整数天数，或留空继承原生设置。" : "Enter a non-negative whole number of days, or leave blank to inherit native settings."}</p> : null}
        </fieldset>
        {gc.error ? (
          <p role="alert" className="maintenance-error">
            {gc.error}
          </p>
        ) : null}
        {summary ? (
          <>
            {summary.rows.length > 0 ? <>
              <p className="tiny muted">
                {zh
                  ? `冷会话：${summary.policy.coldDays} 天；至少保留最近 ${summary.policy.keepGlobal} 个会话，每个工作区 ${summary.policy.keepPerWorkspace} 个。报告保留 ${summary.policy.staleDays} 天及最近 ${summary.policy.staleKeep} 份。`
                  : `Cold after ${summary.policy.coldDays} days; retain ${summary.policy.keepGlobal} sessions globally and ${summary.policy.keepPerWorkspace} per workspace. Reports: ${summary.policy.staleDays} days and newest ${summary.policy.staleKeep}.`}
              </p>
            <div className="maintenance-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{zh ? "类别" : "Category"}</th>
                    <th>{zh ? "候选项" : "Candidates"}</th>
                    <th>{zh ? "已处理" : "Changed"}</th>
                    <th>{zh ? "跳过活动项" : "Active skipped"}</th>
                    <th>{zh ? "涉及大小" : "Affected size"}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.rows.map((row) => (
                    <tr key={row.category}>
                      <td>{label(row.category)}</td>
                      <td>{row.candidates}</td>
                      <td>{row.changed}</td>
                      <td>{row.skippedActive}</td>
                      <td>
                        {row.bytes
                          ? (row.bytes / 1048576).toFixed(1) + " MiB"
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </> : null}
            {summary.strip ? <div className="maintenance-strip-result">
              <h4>{zh ? "供应商回放信息" : "Provider replay data"}</h4>
              <p className="tiny muted">
                {zh
                  ? `空闲至少 ${summary.strip.idleDays} 天；范围为主会话、子代理与归档。保留正文和最新回放轮次，跳过活动租约。`
                  : `Idle for at least ${summary.strip.idleDays} days; main, child and archived transcripts. Content and the latest replay turn are kept; live leases are skipped.`}
              </p>
              <div className="maintenance-table-wrap">
                <table aria-label={zh ? "回放信息扫描结果" : "Replay data scan results"}>
                  <thead><tr>
                    <th>{zh ? "扫描主会话" : "Main sessions scanned"}</th>
                    <th>{zh ? "候选记录文件" : "Candidate transcripts"}</th>
                    <th>{zh ? "已重写文件" : "Transcripts rewritten"}</th>
                    <th>{zh ? "跳过活动项" : "Live skipped"}</th>
                    <th>{zh ? "计划移除回放的记录" : "Records with replay to remove"}</th>
                    <th>{zh ? "可移除回放（JSONL）" : "Removable replay (JSONL)"}</th>
                  </tr></thead>
                  <tbody><tr>
                    <td>{summary.strip.scannedSessions}</td><td>{summary.strip.candidates}</td>
                    <td>{summary.strip.changed}</td><td>{summary.strip.skippedActive}</td>
                    <td>{summary.strip.records}</td><td>{(summary.strip.bytes / 1024).toFixed(1)} KiB</td>
                  </tr></tbody>
                </table>
              </div>
              <p className="tiny muted">{zh
                ? "记录数和大小来自原生扫描的移除计划；大小按未压缩 JSONL 计，不等于回收的磁盘空间。执行会重查候选，已重写数以实际结果为准。"
                : "Records and bytes describe the native removal plan, measured as uncompressed JSONL, not reclaimed disk space. Apply rechecks candidates; the rewritten count reports the actual effect."}</p>
            </div> : null}
            {summary.errors.map((value, index) => (
              <p key={index} role="alert" className="maintenance-error">
                {value}
              </p>
            ))}
            <div className="maintenance-actions">
              <WorkspaceStatus
                state={
                  gc.phase === "failed" || summary.errors.length
                    ? "failed"
                    : summary.applied
                      ? "completed"
                      : "prepared"
                }
              />
              {plan ? (
                <>
                  <span className="tiny muted">
                    {zh ? "预览有效至" : "Preview expires"}{" "}
                    {new Date(plan.expiresAt).toLocaleTimeString()}
                  </span>
                  <button
                    className="btn danger outline"
                    disabled={
                      !supports("maintenance.gc.apply") ||
                      working ||
                      !!summary.errors.length ||
                      (stripEnabled && !plan.summary.strip) ||
                      Date.now() > plan.expiresAt
                    }
                    onClick={() => setConfirm(true)}
                  >
                    {zh ? "确认清理…" : "Apply cleanup…"}
                  </button>
                </>
              ) : null}
            </div>
          </>
        ) : (
          <p className="tiny muted">
            {zh ? "尚未扫描，未执行任何清理。" : "No scan or cleanup has run."}
          </p>
        )}
      </section>
      <section className="maintenance-section">
        <header>
          <div>
            <h3>{zh ? "Studio 连接诊断" : "Studio connection check"}</h3>
            <p>
              {zh
                ? "检查 Bridge、会话归属和当前模型可用性，不发送模型请求。"
                : "Check the Bridge, session identity and model availability without making model requests."}
            </p>
          </div>
          <button
            className="btn outline"
            disabled={!supports("maintenance.connection.check") || working}
            onClick={() => void run("connection")}
          >
            {zh ? "检查连接" : "Check connection"}
          </button>
        </header>
        {connection ? (
          <>
            <span className="tiny muted">
              {zh ? "往返耗时" : "Round trip"} {preview ? "—" : latency} ms
            </span>
            <ul className="maintenance-checks">
              {connection.checks.map((check) => (
                <li key={check.id}>
                  <span>
                    {check.id === "bridge"
                      ? "Studio Bridge"
                      : check.id === "session"
                        ? zh
                          ? "会话"
                          : "Session"
                        : zh
                          ? "模型"
                          : "Model"}
                  </span>
                  <span className={"maintenance-check-" + check.status}>
                    {check.status === "ok"
                      ? zh
                        ? "正常"
                        : "OK"
                      : check.status === "warning"
                        ? zh
                          ? "需检查"
                          : "Needs attention"
                        : zh
                          ? "失败"
                          : "Failed"}
                  </span>
                  <details>
                    <summary>{zh ? "详情" : "Details"}</summary>
                    <code>{check.detail}</code>
                  </details>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
      {confirm && plan ? (
        <div className="modal-backdrop" onClick={() => setConfirm(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={zh ? "确认 OMP 数据清理" : "Confirm OMP data cleanup"}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-head">
              {zh
                ? "执行所选范围的清理？"
                : "Apply cleanup to the previewed scope?"}
            </header>
            <div className="modal-body">
              <p>
                {zh
                  ? "原生清理器会在当前 Runtime 的 OMP 数据目录内，按预览范围重新检查文件与活动会话。"
                  : "The native collector rechecks files and live sessions in this Runtime's OMP data directory, within the previewed scope."}
              </p>
              {plan.summary.rows.length ? <p>{plan.summary.rows.map(row => label(row.category)).join(" · ")}</p> : null}
              {plan.summary.rows.some(row => row.category === "blobs" || row.category === "stale") ? <p>{zh
                ? "删除无引用附件或过期文件后，无法通过 Studio 撤销。"
                : "Deleting unreferenced attachments or expired files cannot be undone in Studio."}</p> : null}
              {plan.summary.strip ? <p>
                {zh
                  ? `移除空闲至少 ${plan.summary.strip.idleDays} 天的供应商回放信息：${plan.summary.strip.candidates} 个记录文件、${plan.summary.strip.records} 条记录。正文和最新回放轮次保留；移除的回放信息无法由 Studio 撤销。`
                  : `Remove provider replay data after ${plan.summary.strip.idleDays} idle days: ${plan.summary.strip.candidates} transcripts, ${plan.summary.strip.records} records. Content and the latest replay turn are kept; removed replay data cannot be restored by Studio.`}
              </p> : null}
              {preview && marks ? (
                <p>
                  {zh
                    ? "演示操作不会修改真实文件。"
                    : "Demo actions do not modify real files."}
                </p>
              ) : null}
            </div>
            <footer className="modal-foot">
              <button className="btn outline" onClick={() => setConfirm(false)}>
                {zh ? "取消" : "Cancel"}
              </button>
              <button
                className="btn danger solid"
                disabled={working || Date.now() > plan.expiresAt}
                onClick={() => void run("apply")}
              >
                {zh ? "执行清理" : "Apply cleanup"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {exportConfirm?<div className="modal-backdrop" onClick={()=>setExportConfirm(false)}><section className="modal" role="dialog" aria-modal="true" aria-label={zh?"确认完整导出":"Confirm full export"} onClick={event=>event.stopPropagation()}><header className="modal-head">{zh?"导出当前会话？":"Export the current session?"}</header><div className="modal-body"><p>{zh?"文件包含原始上下文与工具内容，ZIP 还会包含模型请求载荷。分享前请检查敏感信息。":"The file contains raw context and tool content. ZIP also includes the model request payload. Review sensitive content before sharing."}</p><p>{exportFormat==="archive"?"ZIP · dump all":"HTML"} · {zh?"仅生成本地文件":"Create a local file"}</p></div><footer className="modal-foot"><button className="btn outline" onClick={()=>setExportConfirm(false)}>{zh?"取消":"Cancel"}</button><button className="btn primary" disabled={working} onClick={()=>{setExportConfirm(false);void run("export");}}>{zh?"生成导出文件":"Create export"}</button></footer></section></div>:null}
    </section>
  );
}
