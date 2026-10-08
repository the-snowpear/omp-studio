import { useEffect, useRef, useState } from "react";
import type {
  ClientBootstrap,
  StudioClient,
  CommandInput,
} from "@omp-studio/client-contract";
import type {
  GcCategory,
  GcStatus,
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
  const { preview } = usePreviewMode(),
    { resolvedLanguage } = useI18n(),
    zh = resolvedLanguage === "zh";
  const [categories, setCategories] = useState<GcCategory[]>([
      "blobs",
      "archive",
      "wal",
    ]),
    [gc, setGc] = useState<GcStatus>({ phase: "idle" }),
    [exportState, setExport] = useState<SessionExportStatus>({ phase: "idle" });
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
    if (preview) return;
    const [gcResult, exportResult] = await Promise.allSettled([
      supports("maintenance.gc.status")
        ? read("maintenance.gc.status", { sessionId: sessionId! })
        : Promise.resolve(undefined),
      supports("maintenance.export.status")
        ? read("maintenance.export.status", { sessionId: sessionId! })
        : Promise.resolve(undefined),
    ]);
    if (current !== epoch.current) return;
    if (gcResult.status === "fulfilled" && gcResult.value)
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
    const current = ++epoch.current;
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
    if (!active) {
      setConfirm(false);
    setExportConfirm(false);
      return;
    }
    if (!preview && available) void refreshStatus();
  }, [active, capabilities?.hash, client, sessionId, available, preview]);
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
    const timer = setInterval(() => {
      if (reading || document.hidden) return;
      reading = true;
      void refreshStatus().finally(() => {
        reading = false;
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [active, preview, available, gc.phase, exportState.phase, sessionId]);
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
        setGc({ phase: "previewing" });
        const result = preview
          ? previewGc(categories)
          : await read("maintenance.gc.preview", {
              sessionId: sessionId!,
              categories,
            });
        if (current === epoch.current)
          setGc({
            phase: "complete",
            preview: result,
            summary: result.summary,
          });
      }
      if (kind === "apply") {
        const plan = gc.preview;
        if (!plan) return;
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
            }
          : await read("maintenance.gc.apply", {
              sessionId: sessionId!,
              token: plan.token,
            });
        if (current === epoch.current) {
          setGc({ phase: "complete", summary: result });
          if (preview)
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
            {preview ? (
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
            <label className="tiny muted">{zh ? "导出格式" : "Export format"} <select className="select" value={exportFormat} disabled={working} onChange={event => setExportFormat(event.target.value as "archive" | "html")}><option value="archive">ZIP · dump all</option><option value="html">HTML</option></select></label>
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
                ? "范围为本机 OMP 数据目录，与独立 CLI 共用。先查看原生扫描结果，再确认执行。"
                : "Applies to the local OMP data directory shared with the CLI. Review the native scan before applying."}
            </p>
          </div>
          <button
            className="btn outline"
            disabled={
              !supports("maintenance.gc.preview") ||
              working ||
              !categories.length
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
                  setGc({ phase: "idle" });
                  setConfirm(false);
    setExportConfirm(false);
                }}
              />
              {label(category)}
            </label>
          ))}
        </fieldset>
        {gc.error ? (
          <p role="alert" className="maintenance-error">
            {gc.error}
          </p>
        ) : null}
        {summary ? (
          <>
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
            {summary.errors.map((value, index) => (
              <p key={index} role="alert" className="maintenance-error">
                {value}
              </p>
            ))}
            <div className="maintenance-actions">
              <WorkspaceStatus
                state={
                  summary.errors.length
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
            aria-label={zh ? "确认本地清理" : "Confirm local cleanup"}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-head">
              {zh
                ? "执行所选范围的清理？"
                : "Apply cleanup to the selected categories?"}
            </header>
            <div className="modal-body">
              <p>
                {zh
                  ? "原生清理器会重新检查文件与存活会话。删除无引用附件或过期文件后无法通过 Studio 撤销。"
                  : "The native collector rechecks files and live sessions. Deletion of unreferenced attachments or expired files cannot be undone in Studio."}
              </p>
              <p>{categories.map(label).join(" · ")}</p>
              {preview ? (
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
