import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput } from "@omp-studio/client-contract";
import type {
  StudioIdaResultMap,
  StudioIdaStatus,
} from "@omp-studio/studio-protocol";
import type { SessionOptionsProps } from "../models/SessionOptionsPane";
import { PREVIEW_IDA } from "../preview/idaPreview";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { IdaDatabaseTools } from "./IdaDatabaseTools";
import { WorkspaceDialog, WorkspaceEmpty, WorkspaceStatus } from "../workspaces/Workspace";
import "../models/sessionOptions.css";
import "./ida.css";

type Confirmation =
  | { kind: "configure"; enabled: boolean; installDir: string; python: string }
  | { kind: "open"; path: string }
  | { kind: "run"; id: string; code: string }
  | { kind: "save" | "close"; id: string };
export function IdaPane({
  client,
  sessionId,
  available,
  visible = true,
  capabilities,
}: SessionOptionsProps) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [showTools, setShowTools] = useState(false);
  const [status, setStatus] = useState<StudioIdaStatus>();
  const [selected, setSelected] = useState<string>();
  const [enabled, setEnabled] = useState(true);
  const [installDir, setInstallDir] = useState("");
  const [python, setPython] = useState("");
  const [path, setPath] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<StudioIdaResultMap["ida.run"]>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation>();
  const epoch = useRef(0);
  const lock = useRef(false);
  const configLoaded = useRef(false);
  const can = (kind: string) =>
    preview ||
    (available &&
      !!sessionId &&
      capabilities?.capabilities.some(
        (item) => item.id === kind && item.grade !== "unavailable",
      ) === true);
  const canRead = can("ida.status.details");
  const invoke = useCallback(
    async <K extends keyof StudioIdaResultMap>(
      kind: K,
      input: CommandInput<K>,
    ): Promise<StudioIdaResultMap[K]> => {
      const handle = await client.command(kind, input);
      return (
        await waitReceipt<{ result: StudioIdaResultMap[K] }>(
          client,
          handle.requestId,
          330_000,
        )
      ).result;
    },
    [client],
  );
  useEffect(() => {
    epoch.current++;
    lock.current = false;
    configLoaded.current = false;
    setBusy(false);
    setError("");
    setResult(undefined);
    setNotice("");
    setConfirm(undefined);
    setShowTools(false);
    setSelected(undefined);
    setStatus(preview ? structuredClone(PREVIEW_IDA) : undefined);
    return () => {
      epoch.current++;
    };
  }, [preview, sessionId]);
  useEffect(() => {
    if (!visible || !canRead) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!document.hidden) {
          const value = preview
            ? structuredClone(PREVIEW_IDA)
            : await invoke("ida.status.details", { sessionId: sessionId! });
          if (active) {
            if (!preview) setStatus(value);
            if (!configLoaded.current) {
              setEnabled(value.enabled);
              setInstallDir(value.installDir);
              setPython(value.python);
              configLoaded.current = true;
            }
          }
        }
      } catch (cause) {
        if (active)
          setError(
            hostErrorMessage(
              cause,
              zh ? "IDA 状态读取失败" : "Cannot read IDA status",
            ),
          );
      } finally {
        if (active && !preview) timer = setTimeout(() => void poll(), 4000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [visible, canRead, preview, sessionId, invoke, zh]);
  const run = async () => {
    if (!confirm || lock.current || !canRead) return;
    const generation = epoch.current;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (preview) {
        setNotice(
          zh
            ? "演示：操作已完成，本机 IDA 和文件未更改。"
            : "Demo: operation complete. Local IDA and files are unchanged.",
        );
        if (confirm.kind === "close")
          setStatus((current) =>
            current
              ? {
                  ...current,
                  databases: current.databases.filter(
                    (row) => row.id !== confirm.id,
                  ),
                }
              : current,
          );
      } else {
        if (confirm.kind === "configure") {
          const value = await invoke("ida.configure", {
            sessionId: sessionId!,
            enabled: confirm.enabled,
            installDir: confirm.installDir,
            python: confirm.python,
          });
          if (generation === epoch.current) setStatus(value);
        } else if (confirm.kind === "open") {
          const value = await invoke("ida.open", {
            sessionId: sessionId!,
            path: confirm.path,
          });
          if (generation === epoch.current) setSelected(value.database.id);
        } else if (confirm.kind === "run") {
          const value = await invoke("ida.run", {
            sessionId: sessionId!,
            id: confirm.id,
            code: confirm.code,
            timeoutMs: 120_000,
          });
          if (generation === epoch.current) setResult(value);
        } else {
          const value = await invoke(
            confirm.kind === "save" ? "ida.save" : "ida.close",
            { sessionId: sessionId!, id: confirm.id },
          );
          if (generation === epoch.current)
            setNotice(
              (zh ? "已完成，恢复副本：" : "Completed. Recovery copy: ") +
                value.backup,
            );
        }
        if (generation === epoch.current) {
          const value = await invoke("ida.status.details", { sessionId: sessionId! });
          if (generation === epoch.current) setStatus(value);
        }
      }
      if (generation === epoch.current) setConfirm(undefined);
    } catch (cause) {
      if (generation === epoch.current)
        setError(
          hostErrorMessage(
            cause,
            zh
              ? "IDA 操作失败；请查询状态后再决定是否重试。"
              : "IDA operation failed. Check its status before retrying.",
          ),
        );
    } finally {
      if (generation === epoch.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  const db =
    status?.databases.find((row) => row.id === selected) ??
    status?.databases[0];
  return (
    <section className="ida-pane" aria-label="IDA">
      <div className="session-options-actions">
        <button type="button" className="btn small outline" disabled={!can("ida.view")} onClick={() => setShowTools(true)}>{zh ? "数据库视图与编辑" : "Database views and edits"}</button>
      </div>
      {showTools ? <WorkspaceDialog title={zh ? "数据库视图与编辑" : "Database views and edits"} onClose={() => setShowTools(false)}><IdaDatabaseTools client={client} sessionId={sessionId} available={available} /></WorkspaceDialog> : null}

      <h2>
        IDA{" "}
        {preview ? (
          <span className="chip gray xs">{zh ? "演示" : "Demo"}</span>
        ) : null}
      </h2>
      <p className="muted">
        {zh
          ? "管理当前项目的原生 IDA 数据库。运行、保存和关闭前会保留恢复副本。"
          : "Manage native IDA databases in this project. Run, save and close keep a recovery copy first."}
      </p>
      {!canRead ? (
        <WorkspaceEmpty
          icon="plug"
          title={
            zh
              ? "此 Runtime 尚不支持 IDA 管理"
              : "IDA management is unavailable"
          }
        >
          {zh
            ? "连接支持此能力的 Runtime 后重试。"
            : "Connect a Runtime that supports this capability."}
        </WorkspaceEmpty>
      ) : null}
      {error ? (
        <p className="session-options-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <details
        className="ida-configuration"
        open={status !== undefined && !status.available}
      >
        <summary>
          {zh ? "安装与依赖配置" : "Installation and dependencies"}
        </summary>
        <div className="ida-fields">
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {zh ? "启用 IDA" : "Enable IDA"}
          </label>
          <label>
            {zh ? "安装目录" : "Install directory"}
            <input
              className="input"
              value={installDir}
              onChange={(event) => setInstallDir(event.target.value)}
              placeholder={zh ? "留空自动检测" : "Leave empty to detect"}
            />
          </label>
          <label>
            Python
            <input
              className="input"
              value={python}
              onChange={(event) => setPython(event.target.value)}
              placeholder={
                zh
                  ? "需支持 ida_domain 与 idapro"
                  : "Must provide ida_domain and idapro"
              }
            />
          </label>
          <button
            className="btn primary"
            disabled={busy || !can("ida.configure")}
            onClick={() =>
              setConfirm({ kind: "configure", enabled, installDir, python })
            }
          >
            {zh ? "保存并检测" : "Save and detect"}
          </button>
        </div>
        {status?.reason ? <p role="status">{status.reason}</p> : null}
        {status?.detectedInstall ? (
          <p className="small muted">
            {status.detectedInstall} · {status.detectedPython}
          </p>
        ) : null}
      </details>
      <div className="session-options-row">
        <label>
          {zh ? "二进制或数据库文件" : "Binary or database file"}
          <input
            className="input"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={zh ? "文件路径" : "File path"}
          />
        </label>
        <button
          className="btn primary"
          disabled={
            !status?.available || busy || !path.trim() || !can("ida.open")
          }
          onClick={() => setConfirm({ kind: "open", path: path.trim() })}
        >
          {zh ? "打开数据库" : "Open database"}
        </button>
      </div>
      {db ? (
        <div className="model-presets">
          <div className="model-presets-list">
            {status?.databases.map((row) => (
              <button
                type="button"
                key={row.id}
                aria-pressed={row.id === db.id}
                onClick={() => setSelected(row.id)}
              >
                <b>{row.module}</b>
                <WorkspaceStatus state={row.busy ? "running" : "idle"} />
              </button>
            ))}
          </div>
          <div className="model-presets-detail">
            <h3>{db.module}</h3>
            <p className="small muted">
              {db.format} · {db.arch} · {db.bitness} bit{" "}
              {db.dirty ? (zh ? "· 未保存更改" : "· Unsaved changes") : ""}
            </p>
            <details>
              <summary>{zh ? "数据库详情" : "Database details"}</summary>
              <p className="mono">{db.path}</p>
              <p className="mono">{db.id}</p>
              {db.current ? (
                <p>
                  {db.current.method} ·{" "}
                  {new Date(db.current.startedAt).toLocaleString()}
                </p>
              ) : null}
            </details>
            <div className="session-options-row">
              <button
                className="btn outline"
                disabled={busy || db.busy || !can("ida.save")}
                onClick={() => setConfirm({ kind: "save", id: db.id })}
              >
                {zh ? "保存" : "Save"}
              </button>
              <button
                className="btn outline"
                disabled={busy || db.busy || !can("ida.close")}
                onClick={() => setConfirm({ kind: "close", id: db.id })}
              >
                {zh ? "保存并关闭" : "Save and close"}
              </button>
            </div>
            <label className="ida-code">
              Python
              <textarea
                className="input mono"
                rows={7}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                spellCheck={false}
              />
            </label>
            <div className="session-options-row">
              <button
                className="btn primary"
                disabled={busy || db.busy || !code.trim() || !can("ida.run")}
                onClick={() => setConfirm({ kind: "run", id: db.id, code })}
              >
                {zh ? "运行请求" : "Run request"}
              </button>
              <button
                className="btn outline danger"
                disabled={(!busy && !db.busy) || !can("ida.database.cancel")}
                onClick={() => {
                  if (preview) {
                    setNotice(
                      zh ? "演示：请求已取消" : "Demo: request cancelled",
                    );
                    return;
                  }
                  void invoke("ida.database.cancel", {
                    sessionId: sessionId!,
                    id: db.id,
                  })
                    .then((value) =>
                      setNotice(
                        value.cancelled
                          ? zh
                            ? "已请求取消"
                            : "Cancellation requested"
                          : zh
                            ? "没有属于 Studio 的活动请求"
                            : "No active request owned by Studio",
                      ),
                    )
                    .catch((cause) =>
                      setError(
                        hostErrorMessage(cause, "Cannot cancel IDA request"),
                      ),
                    );
                }}
              >
                {zh ? "停止请求" : "Stop request"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <WorkspaceEmpty title={zh ? "没有打开的数据库" : "No open databases"}>
          {zh
            ? "选择文件后打开；数据库由原生项目 Broker 管理。"
            : "Open a file. Databases are managed by the native project broker."}
        </WorkspaceEmpty>
      )}
      {result ? (
        <section>
          <h3>
            {result.error
              ? zh
                ? "请求失败"
                : "Request failed"
              : zh
                ? "执行结果"
                : "Result"}
          </h3>
          {result.error ? (
            <p role="alert" className="session-options-error">
              {result.error}
            </p>
          ) : null}
          <pre className="ida-output">
            {result.output}
            {result.value ?? ""}
          </pre>
          <details>
            <summary>
              {zh ? "恢复副本与完整结果" : "Recovery copy and full result"}
            </summary>
            <p className="mono">{result.backup}</p>
            <p className="mono">{result.resultFile}</p>
          </details>
          {result.truncated ? (
            <p>
              {zh
                ? "显示内容已截断，完整结果保存在上述文件。"
                : "Display truncated. Full result is saved in the file above."}
            </p>
          ) : null}
        </section>
      ) : null}
      {confirm ? (
        <div
          className="session-options-confirm"
          role="dialog"
          aria-label={zh ? "确认 IDA 操作" : "Confirm IDA action"}
        >
          <strong>{zh ? "确认操作" : "Confirm action"}</strong>
          {confirm.kind === "configure" ? (
            <p>
              {zh
                ? "将安装目录和 Python 配置保存到原生全局设置。"
                : "Save the install directory and Python configuration to native global settings."}
            </p>
          ) : confirm.kind === "open" ? (
            <p>{confirm.path}</p>
          ) : (
            <p>
              {status?.databases.find((database) => database.id === confirm.id)
                ?.name ?? (zh ? "所选数据库" : "Selected database")}{" "}
              ·{" "}
              {zh
                ? "修改前保存恢复副本；关闭会影响使用此项目数据库的其他代理。"
                : "Keep a recovery copy before changes. Closing affects other agents using this project's database."}
            </p>
          )}
          {confirm.kind === "run" ? (
            <pre className="ida-output">{confirm.code}</pre>
          ) : null}
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void run()}
          >
            {zh ? "确认" : "Confirm"}
          </button>
          <button
            className="btn outline"
            disabled={busy}
            onClick={() => setConfirm(undefined)}
          >
            {zh ? "取消" : "Cancel"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
