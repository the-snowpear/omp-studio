import { useCallback, useEffect, useState } from "react";
import type {
  ClientBootstrap,
  DiagnosticReadModel,
  EnvironmentReadModel,
  StudioClient,
} from "@omp-studio/client-contract";
import { Icon } from "./icons";
import { ToastHost } from "./ToastHost";
import { usePreviewMode } from "./preview/PreviewContext";
import { PREVIEW_DIAGNOSTICS } from "./preview/fixtures";
import { waitForCommandReceipt } from "./sessionLifecycle";

type CapManifest = ClientBootstrap["capabilityManifest"];
type RuntimeConn = ClientBootstrap["runtime"];

const CONTRACT = {
  export: "导出日志不在公共 contract 中",
  logDir: "打开日志目录需要 openExternal / fileReveal 授权，不在公共 contract 中",
  restart: "重启 OMP Bridge 不在公共 contract 中",
  process: "进程与 PID 信息按 contract 设计不对外暴露",
  path: "路径不在公共 contract 中（read model 已脱敏）",
} as const;

/** Capability grade → chip tone. Preview mock has no grades, so it stays gray. */
const GRADE_TONE: Record<string, string> = {
  stable: "green",
  experimental: "blue",
  limited: "amber",
  unavailable: "gray",
};

function useNotice(): [notice: { text: string; icon: string } | null, show: (text: string, icon?: string) => void, dismiss: () => void] {
  const [notice, setNotice] = useState<{ text: string; icon: string } | null>(null);
  return [notice, (text, icon = "info") => setNotice({ text, icon }), () => setNotice(null)];
}

function fmtTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  return new Date(then).toLocaleTimeString();
}

function fmtDateTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  return new Date(then).toLocaleString();
}

function Kv({ k, v, mute }: { k: string; v: string; mute?: boolean }) {
  return (
    <div className="dk">
      <div className="k">{k}</div>
      <div className="v" style={mute ? { color: "var(--text-3)" } : undefined}>{v}</div>
    </div>
  );
}

export function DiagnosticsPage({
  client,
  diagnostics,
  capabilities,
  runtime,
  environment,
}: {
  client: StudioClient;
  diagnostics?: DiagnosticReadModel;
  capabilities?: CapManifest;
  runtime?: RuntimeConn;
  environment?: EnvironmentReadModel;
}) {
  const { preview } = usePreviewMode();
  const mock = PREVIEW_DIAGNOSTICS;
  const [diag, setDiag] = useState<DiagnosticReadModel | undefined>(diagnostics);
  const [caps, setCaps] = useState<CapManifest | undefined>(capabilities);
  const [env, setEnv] = useState<EnvironmentReadModel | undefined>(environment);
  const [busy, setBusy] = useState(false);
  const [notice, show, dismissNotice] = useNotice();

  useEffect(() => setDiag(diagnostics), [diagnostics]);
  useEffect(() => setCaps(capabilities), [capabilities]);
  useEffect(() => setEnv(environment), [environment]);

  const authority = diag?.authority ?? environment?.authority;
  const capList = caps?.capabilities ?? [];
  // Recent-errors section: only error / warning level entries.
  const problems = (diag?.entries ?? []).filter((entry) => entry.level === "error" || entry.level === "warning");

  const refresh = useCallback(async () => {
    if (preview) {
      show("已重新检测 OMP（演示）", "check");
      return;
    }
    setBusy(true);
    try {
      const [d, c, e] = await Promise.allSettled([
        client.query("diagnostics.get", {}),
        client.query("capabilities.get", {}),
        client.query("environment.get", {}),
      ]);
      if (d.status === "fulfilled") setDiag(d.value);
      if (c.status === "fulfilled") setCaps(c.value);
      if (e.status === "fulfilled") setEnv(e.value);
      show(d.status === "fulfilled" ? "已重新检测 OMP" : "重新检测失败", d.status === "fulfilled" ? "check" : "alert-c");
    } catch {
      show("重新检测失败", "alert-c");
    } finally {
      setBusy(false);
    }
  }, [client, preview, show]);

  const installRuntime = useCallback(async () => {
    if (preview) return;
    setBusy(true);
    try {
      const handle = await client.command("runtime.install", {});
      const receipt = await waitForCommandReceipt(client, handle.requestId);
      const [d, e] = await Promise.allSettled([
        client.query("diagnostics.get", {}),
        client.query("environment.get", {}),
      ]);
      if (d.status === "fulfilled") setDiag(d.value);
      if (e.status === "fulfilled") setEnv(e.value);
      if (receipt.status === "completed") {
        show("托管 Runtime 已安装", "check");
      } else {
        const message = receipt.status === "failed" ? receipt.error.message : "安装未完成";
        show(message, "alert-c");
      }
    } catch (error) {
      show(error instanceof Error ? error.message : "安装失败", "alert-c");
    } finally {
      setBusy(false);
    }
  }, [client, preview, show]);

  const copyReport = useCallback(async () => {
    const lines: string[] = ["# OMP Studio 诊断报告"];
    if (preview) {
      lines.push(
        `OMP 可执行文件: ${mock.ompPath}`,
        `OMP 版本: ${mock.version}`,
        `RPC 协议: ${mock.rpc}`,
        `Bridge 状态: ${mock.bridge}`,
        `当前工作目录: ${mock.cwd}`,
        `配置目录: ${mock.configDir}`,
        "",
        `Capabilities: ${mock.capabilities.join(", ")}`,
        "",
        "最近错误:",
        ...mock.errors.map((e) => `  ${e.time} [${e.src}] ${e.msg}`),
      );
    } else {
      lines.push(
        `OMP 版本: ${runtime?.runtimeVersion ?? "—"}`,
        `上游版本: ${runtime?.upstreamVersion ?? "—"}${runtime?.upstreamCommit ? ` (${runtime.upstreamCommit.slice(0, 7)})` : ""}`,
        `运行时状态: ${runtime?.status ?? "unavailable"} · ${runtime?.classification ?? "—"}`,
        `后端: ${runtime?.backend ?? "—"}`,
        `平台: ${environment ? `${environment.platform} · ${environment.arch}` : "—"}`,
        `授权: ${authority ? `${authority.authorityId} · epoch ${authority.authorityEpoch}` : "—"}`,
        `报告生成时间: ${diag?.generatedAt ? fmtDateTime(diag.generatedAt) : "—"}`,
        "",
        `Capabilities (${capList.length}): ${capList.map((c) => `${c.id}@${c.grade}`).join(", ") || "—"}`,
        "",
        `诊断条目 (${diag?.entries.length ?? 0}):`,
        ...(diag?.entries ?? []).map((e) => `  ${fmtTime(e.occurredAt)} [${e.level} · ${e.scope}] ${e.message}`),
      );
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      show("诊断报告已复制到剪贴板", "copy");
    } catch {
      show("复制失败：剪贴板不可用", "alert-c");
    }
  }, [preview, mock, runtime, environment, authority, diag, capList, show]);

  return (
    <div className="page-wide">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>诊断中心</h1>
          <p className="muted small">面向开源项目用户与开发者的运行状态全景。普通信息优先，高级细节已折叠。</p>
          <p className="tiny muted">
            {preview
              ? "演示数据 · 预览开时覆盖真实读模型"
              : diag
                ? "来自公共 read model（已脱敏）· 路径 / PID / 私有端点不对外暴露"
                : "无法读取诊断 read model"}
          </p>
        </div>
        <span className="spacer" />
        <div id="diagActions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn outline" onClick={() => void copyReport()}><Icon name="copy" extra="sm" />复制诊断报告</button>
          {preview ? (
            <>
              <button className="btn outline" onClick={() => show("演示：导出日志不会写文件", "export")}><Icon name="export" extra="sm" />导出日志</button>
              <button className="btn outline" onClick={() => show("演示：打开日志目录不会触发外部操作", "folder")}><Icon name="folder" extra="sm" />打开日志目录</button>
              <button className="btn outline" onClick={() => show("演示：重启 Bridge 不会真的重启", "refresh")}><Icon name="refresh" extra="sm" />重启 OMP Bridge</button>
            </>
          ) : (
            <>
              <button className="btn outline" disabled title={CONTRACT.export}><Icon name="export" extra="sm" />导出日志</button>
              <button className="btn outline" disabled title={CONTRACT.logDir}><Icon name="folder" extra="sm" />打开日志目录</button>
              <button className="btn outline" disabled title={CONTRACT.restart}><Icon name="refresh" extra="sm" />重启 OMP Bridge</button>
            </>
          )}
          {!preview && env?.installer?.status !== "installed" ? (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void installRuntime()}
              title="从本地签名制品安装托管 Runtime，不会使用系统 PATH 上的 omp"
            >
              <Icon name="package" extra="sm" />安装 Runtime
            </button>
          ) : null}
          <button className="btn primary" disabled={busy} onClick={() => void refresh()}><Icon name="pulse" extra="sm" />重新检测 OMP</button>
        </div>
      </div>

      <div className="diag-kv" id="diagKv">
        {preview ? (
          <>
            <Kv k="OMP 可执行文件" v={mock.ompPath} />
            <Kv k="OMP 版本" v={mock.version} />
            <Kv k="RPC 协议" v={mock.rpc} />
            <Kv k="Bridge 状态" v={mock.bridge} />
            <Kv k="当前工作目录" v={mock.cwd} />
            <Kv k="配置目录" v={mock.configDir} />
          </>
        ) : (
          <>
            <Kv k="OMP 版本" v={runtime?.runtimeVersion ?? "—"} />
            <Kv k="上游版本" v={runtime?.upstreamVersion ? `${runtime.upstreamVersion}${runtime.upstreamCommit ? ` (${runtime.upstreamCommit.slice(0, 7)})` : ""}` : "—"} />
            <Kv k="运行时状态" v={`${runtime?.status ?? "unavailable"} · ${runtime?.classification ?? "—"}`} />
            <Kv k="托管安装" v={env?.installer ? `${env.installer.status}${env.installer.version ? ` · ${env.installer.version}` : ""}${env.installer.message ? ` · ${env.installer.message}` : ""}` : "—"} />
            <Kv k="后端 Backend" v={runtime?.backend ?? "—"} />
            <Kv k="平台" v={environment ? `${environment.platform} · ${environment.arch}` : "—"} />
            <Kv k="授权 Authority" v={authority ? `${authority.authorityId} · epoch ${authority.authorityEpoch}` : "—"} />
            <Kv k="报告生成时间" v={diag?.generatedAt ? fmtDateTime(diag.generatedAt) : "—"} />
            <Kv k="OMP 可执行文件 / 配置目录" v="不可用（路径已脱敏）" mute />
          </>
        )}
      </div>

      <div className="diag-section">
        <h3><Icon name="cpu" extra="sm" />活跃进程</h3>
        <div className="card" style={{ padding: "0 4px" }}>
          <table className="diag-table">
            <thead><tr><th>进程</th><th>PID</th><th>角色</th><th>内存</th></tr></thead>
            <tbody id="diagProc">
              {preview ? mock.processes.map((p) => (
                <tr key={`${p.name}-${p.pid}`}><td>{p.name}</td><td>{p.pid}</td><td>{p.role}</td><td>{p.mem}</td></tr>
              )) : (
                <tr><td colSpan={4} style={{ color: "var(--text-3)" }}>{CONTRACT.process}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="diag-section">
        <h3><Icon name="zap" extra="sm" />Capability 列表（RPC 协商）</h3>
        <div className="card" style={{ padding: "12px 14px" }} id="diagCap">
          {preview ? (
            <div className="diag-caps">{mock.capabilities.map((c) => <span key={c} className="chip gray">{c}</span>)}</div>
          ) : capList.length ? (
            <div className="diag-caps">
              {capList.map((c) => (
                <span key={c.id} className={`chip ${GRADE_TONE[c.grade] ?? "gray"}`} title={`${c.grade} · v${c.version}`}>{c.id}</span>
              ))}
            </div>
          ) : (
            <span className="muted small">无 capability 清单</span>
          )}
        </div>
      </div>

      <div className="diag-section">
        <h3><Icon name="alert-c" extra="sm" />最近错误</h3>
        <div className="card" style={{ padding: 6 }} id="diagErr">
          {preview ? mock.errors.map((e) => (
            <div className="prob-row diag-err-row" key={`${e.time}-${e.src}`}>
              <span className="prob-sev sev-red" role="img" aria-label="错误"><Icon name="alert-c" extra="sm" /></span>
              <span className="mono tiny muted">{e.time}</span>
              <span className="chip gray xs">{e.src}</span>
              <span className="ellipsis">{e.msg}</span>
            </div>
          )) : problems.length ? problems.map((e) => (
            <div className="prob-row diag-err-row" key={e.entryId}>
              <span className={`prob-sev ${e.level === "error" ? "sev-red" : ""}`} style={e.level === "warning" ? { color: "var(--amber)" } : undefined} role="img" aria-label={e.level === "error" ? "错误" : "警告"}>
                <Icon name={e.level === "error" ? "alert-c" : "alert"} extra="sm" />
              </span>
              <span className="mono tiny muted">{fmtTime(e.occurredAt)}</span>
              <span className="chip gray xs">{e.scope}</span>
              <span className="ellipsis">{e.message}</span>
            </div>
          )) : (
            <div className="muted small" style={{ padding: "10px 8px" }}>无最近错误</div>
          )}
        </div>
      </div>

      <details className="diag-advanced">
        <summary><Icon name="chevron-r" extra="sm" /> 高级细节 · 原始 RPC 日志 / Extension / Plugin / MCP 错误</summary>
        <div className="da-body">
          <div className="term" style={{ fontSize: "10.5px" }}>
            {preview ? mock.logs.map((line, index) => (
              <div key={index} className={line.tone === "err" ? "err" : "muted"}>{line.text}</div>
            )) : (diag?.entries.length ? diag.entries.map((e) => (
              <div key={e.entryId} className={e.level === "error" ? "err" : e.level === "warning" ? "warn" : "muted"}>
                {`${fmtTime(e.occurredAt)} [${e.level} · ${e.scope}] ${e.message}`}
              </div>
            )) : <div className="muted">无原始日志条目（read model 未提供）</div>)}
          </div>
        </div>
      </details>

      <ToastHost message={notice?.text ?? null} icon={notice?.icon ?? "info"} onDismiss={dismissNotice} />
    </div>
  );
}
