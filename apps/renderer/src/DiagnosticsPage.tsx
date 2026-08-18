import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClientBootstrap,
  DiagnosticReadModel,
  EnvironmentReadModel,
  RuntimeConnection,
  RuntimeInstallState,
  StudioClient,
} from "@omp-studio/client-contract";
import { Icon } from "./icons";
import { ToastHost } from "./ToastHost";
import { usePreviewMode } from "./preview/PreviewContext";
import { PREVIEW_DIAGNOSTICS, type PreviewDiagScenario } from "./preview/fixtures";
import { waitForCommandReceipt } from "./sessionLifecycle";
import {
  deriveDiagnosticsView,
  formatCheckedAt,
  formatDiagnosticEntryMessage,
  type DiagnosticsCheck,
  type DiagnosticsHero,
} from "./diagnosticsModel";
import { isUpdateCheckTimeout, queryWithTimeout } from "./updateCheck";

type CapManifest = ClientBootstrap["capabilityManifest"];

export const DIAGNOSTICS_INTENT_KEY = "omp.diagnosticsIntent";
export type DiagnosticsIntent = "check-update";

export function setDiagnosticsIntent(intent: DiagnosticsIntent): void {
  try {
    sessionStorage.setItem(DIAGNOSTICS_INTENT_KEY, JSON.stringify({ intent }));
  } catch {
    /* sessionStorage may be blocked */
  }
}

function takeDiagnosticsIntent(): DiagnosticsIntent | null {
  try {
    const raw = sessionStorage.getItem(DIAGNOSTICS_INTENT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(DIAGNOSTICS_INTENT_KEY);
    const value = JSON.parse(raw) as { intent?: unknown };
    return value.intent === "check-update" ? "check-update" : null;
  } catch {
    return null;
  }
}

const CONTRACT = {
  export: "导出（暂未实现）",
  logDir: "日志目录（暂未实现）",
  restart: "重启（暂未实现）",
} as const;

const GRADE_TONE: Record<string, string> = {
  stable: "green",
  experimental: "blue",
  limited: "amber",
  unavailable: "gray",
};

const PREVIEW_CYCLE: ReadonlyArray<{ id: PreviewDiagScenario; label: string }> = [
  { id: "update", label: "预览：有可用更新" },
  { id: "ok", label: "预览：环境正常" },
  { id: "fail", label: "预览：检查失败" },
];

function useNotice(): [notice: { text: string; icon: string } | null, show: (text: string, icon?: string) => void, dismiss: () => void] {
  const [notice, setNotice] = useState<{ text: string; icon: string } | null>(null);
  const show = useCallback((text: string, icon = "info") => setNotice({ text, icon }), []);
  const dismiss = useCallback(() => setNotice(null), []);
  return [notice, show, dismiss];
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

function previewAuthority(): EnvironmentReadModel["authority"] {
  return { authorityId: "preview-authority" as EnvironmentReadModel["authority"]["authorityId"], authorityEpoch: 1 as EnvironmentReadModel["authority"]["authorityEpoch"] };
}

function previewGeneratedAt(): string {
  return "2026-08-18T04:03:00.000Z";
}

function previewEnvironment(scenario: PreviewDiagScenario, installer: RuntimeInstallState): EnvironmentReadModel {
  return {
    platform: "win32",
    arch: "x64",
    authority: previewAuthority(),
    runtime: previewRuntime(scenario),
    installer,
  };
}

function previewRuntime(scenario: PreviewDiagScenario): RuntimeConnection {
  const mock = PREVIEW_DIAGNOSTICS;
  if (scenario === "fail") {
    return {
      status: "unavailable",
      classification: "unavailable",
      runtimeVersion: mock.version,
      unavailableCode: "launch-failed",
      unavailableReason: "Studio Bridge handshake timed out",
    };
  }
  return {
    status: "connected",
    classification: "managed",
    runtimeVersion: mock.version,
    upstreamVersion: mock.upstreamVersion,
    upstreamCommit: mock.upstreamCommit,
  };
}

function previewInstaller(scenario: PreviewDiagScenario): RuntimeInstallState {
  const mock = PREVIEW_DIAGNOSTICS;
  if (scenario === "fail") {
    return { status: "failed", version: mock.version, signature: "unknown", message: "本地制品激活失败（演示）" };
  }
  if (scenario === "ok") {
    return { status: "installed", version: mock.version, signature: "verified" };
  }
  return {
    status: "update-available",
    version: mock.version,
    availableVersion: mock.availableVersion,
    signature: "verified",
  };
}

function previewDiagnostics(scenario: PreviewDiagScenario): DiagnosticReadModel {
  const mock = PREVIEW_DIAGNOSTICS;
  const now = previewGeneratedAt();
  if (scenario === "ok") {
    return {
      generatedAt: now,
      authority: previewAuthority(),
      redacted: true,
      entries: [{ entryId: "prev-ok" as DiagnosticReadModel["entries"][number]["entryId"], scope: "runtime" as const, level: "info" as const, message: "Runtime is connected", occurredAt: now }],
    };
  }
  const handshake: DiagnosticReadModel["entries"][number] = {
    entryId: "prev-runtime-down" as DiagnosticReadModel["entries"][number]["entryId"],
    scope: "host",
    level: "warning",
    message: "Runtime failed to start: Studio Bridge handshake timed out",
    detail: { code: "launch-failed", reason: "Studio Bridge handshake timed out" },
    occurredAt: now,
  };
  const extras = mock.errors.map((error, index) => ({
    entryId: `prev-err-${index}` as DiagnosticReadModel["entries"][number]["entryId"],
    scope: "runtime" as const,
    level: "error" as const,
    message: error.msg,
    occurredAt: now,
  }));
  return { generatedAt: now, authority: previewAuthority(), redacted: true, entries: scenario === "fail" ? [handshake, ...extras] : extras };
}

function previewCapabilities(): CapManifest {
  return {
    profile: "full-parity-v1",
    generatedAt: previewGeneratedAt(),
    hash: "preview-capabilities",
    capabilities: PREVIEW_DIAGNOSTICS.capabilities.map((id) => ({
      id,
      grade: "stable",
      version: 1,
      evidence: "preview",
    })),
  };
}

function heroIcon(kind: DiagnosticsHero["kind"]): string {
  if (kind === "ok") return "check";
  if (kind === "update" || kind === "installing") return "update";
  if (kind === "missing") return "package";
  return "alert-c";
}

function heroClass(kind: DiagnosticsHero["kind"]): string {
  if (kind === "ok") return "ok";
  if (kind === "update" || kind === "installing") return "warn";
  return "fail";
}

function primaryLabel(action: DiagnosticsHero["primary"], busy: boolean): string {
  if (action === "install") return busy ? "正在安装…" : "安装 Runtime";
  if (action === "update") return busy ? "正在更新…" : "更新 Runtime";
  return busy ? "正在检测…" : "重新检测";
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
  runtime?: RuntimeConnection;
  environment?: EnvironmentReadModel;
}) {
  const { preview } = usePreviewMode();
  const mock = PREVIEW_DIAGNOSTICS;
  const [scenario, setScenario] = useState<PreviewDiagScenario>("update");
  const [diag, setDiag] = useState<DiagnosticReadModel | undefined>(diagnostics);
  const [caps, setCaps] = useState<CapManifest | undefined>(capabilities);
  const [env, setEnv] = useState<EnvironmentReadModel | undefined>(environment);
  const [busy, setBusy] = useState(false);
  const [confirmReinstall, setConfirmReinstall] = useState(false);
  const [notice, show, dismissNotice] = useNotice();

  useEffect(() => setDiag(diagnostics), [diagnostics]);
  useEffect(() => setCaps(capabilities), [capabilities]);
  useEffect(() => setEnv(environment), [environment]);

  const previewInstallerState = previewInstaller(scenario);
  const viewRuntime = preview ? previewRuntime(scenario) : runtime ?? env?.runtime;
  const viewEnv = preview ? previewEnvironment(scenario, previewInstallerState) : env;
  const viewDiag = preview ? previewDiagnostics(scenario) : diag;
  const viewCaps = preview ? previewCapabilities() : caps;
  const view = useMemo(
    () => deriveDiagnosticsView({
      ...(viewRuntime === undefined ? {} : { runtime: viewRuntime }),
      ...(viewEnv === undefined ? {} : { environment: viewEnv }),
      ...(viewDiag === undefined ? {} : { diagnostics: viewDiag }),
      ...(viewCaps === undefined ? {} : { capabilities: viewCaps }),
    }),
    [viewRuntime, viewEnv, viewDiag, viewCaps],
  );

  const refresh = useCallback(async () => {
    if (preview) {
      show("已重新检测 OMP（演示）", "check");
      return;
    }
    setBusy(true);
    try {
      const status = runtime?.status ?? env?.runtime?.status;
      let reconnected = false;
      if (status === "unavailable" || status === "disconnected") {
        try {
          const handle = await client.command("runtime.ensure", {});
          const receipt = await waitForCommandReceipt(client, handle.requestId);
          if (receipt.status === "completed") {
            const connection = receipt.result as RuntimeConnection | undefined;
            reconnected = connection?.status === "connected";
          } else if (receipt.status === "failed") {
            show(receipt.error.message, "alert-c");
          }
        } catch (error) {
          show(error instanceof Error ? error.message : "重新连接 Runtime 失败", "alert-c");
        }
      }
      const [d, c, e] = await Promise.allSettled([
        client.query("diagnostics.get", {}),
        client.query("capabilities.get", {}),
        client.query("environment.get", {}),
      ]);
      if (d.status === "fulfilled") setDiag(d.value);
      if (c.status === "fulfilled") setCaps(c.value);
      if (e.status === "fulfilled") setEnv(e.value);
      if (reconnected) {
        show("Runtime 已重新连接", "check");
      } else if (d.status === "fulfilled") {
        show("已重新检测 OMP", "check");
      } else {
        show("重新检测失败", "alert-c");
      }
    } catch {
      show("重新检测失败", "alert-c");
    } finally {
      setBusy(false);
    }
  }, [client, preview, show, runtime, env]);

  const checkUpdate = useCallback(async (notify: boolean) => {
    if (preview) {
      if (notify) {
        show(
          scenario === "update" ? `已检查更新（演示）· ${mock.availableVersion} 可用` : scenario === "ok" ? "已是本地最新制品（演示）" : "检查更新失败（演示）",
          scenario === "fail" ? "alert-c" : "check",
        );
      }
      return;
    }
    if (notify) setBusy(true);
    try {
      const next = await queryWithTimeout(() => client.query("environment.get", {}));
      setEnv(next);
      if (!notify) return;
      if (next.installer.status === "update-available") {
        show(`发现本地更新${next.installer.availableVersion ? ` ${next.installer.availableVersion}` : ""}`, "update");
      } else if (next.installer.status === "not-installed") {
        show(next.installer.availableVersion ? `未安装 · 发现本地制品 ${next.installer.availableVersion}` : "未发现可安装的本地制品", "package");
      } else if (next.installer.status === "failed") {
        show(next.installer.message ?? "安装状态失败", "alert-c");
      } else {
        show("已是本地最新制品", "check");
      }
    } catch (error) {
      if (notify) show(isUpdateCheckTimeout(error) ? "检查更新超时" : "检查更新失败", "alert-c");
    } finally {
      if (notify) setBusy(false);
    }
  }, [client, preview, scenario, mock.availableVersion, show]);

  const checkUpdateRef = useRef(checkUpdate);
  checkUpdateRef.current = checkUpdate;
  useEffect(() => {
    void checkUpdateRef.current(takeDiagnosticsIntent() === "check-update");
  }, []);

  const installRuntime = useCallback(async (kind: "install" | "update" | "reinstall") => {
    setConfirmReinstall(false);
    if (preview) {
      const labels = { install: "已安装 Runtime（演示）", update: "已更新 Runtime（演示）", reinstall: "已重装 Runtime（演示）" };
      show(labels[kind], "check");
      return;
    }
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
        show(kind === "update" ? "托管 Runtime 已更新" : kind === "reinstall" ? "托管 Runtime 已重装" : "托管 Runtime 已安装", "check");
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

  const runPrimary = useCallback(() => {
    if (view.hero.primary === "install") void installRuntime("install");
    else if (view.hero.primary === "update") void installRuntime("update");
    else void refresh();
  }, [view.hero.primary, installRuntime, refresh]);

  const runCheckAction = useCallback((action: NonNullable<DiagnosticsCheck["action"]>) => {
    if (action === "problems") {
      document.getElementById("diagProblems")?.scrollIntoView({ block: "start" });
      return;
    }
    void installRuntime(action === "update" ? "update" : "install");
  }, [installRuntime]);

  const copyReport = useCallback(async () => {
    const lines: string[] = ["# OMP Studio 诊断报告"];
    if (preview) {
      lines.push(
        `OMP 版本: ${mock.version}`,
        `可用制品: ${mock.availableVersion}`,
        `上游版本: ${mock.upstreamVersion} (${mock.upstreamCommit})`,
        `平台: ${mock.platform} · ${mock.arch}`,
        `演示场景: ${scenario}`,
        "",
        `Capabilities: ${mock.capabilities.join(", ")}`,
        "",
        "最近错误:",
        ...mock.errors.map((error) => `  ${error.time} [${error.src}] ${error.msg}`),
      );
    } else {
      const authority = viewDiag?.authority ?? viewEnv?.authority;
      const capList = viewCaps?.capabilities ?? [];
      lines.push(
        `OMP 版本: ${viewRuntime?.runtimeVersion ?? "—"}`,
        `上游版本: ${viewRuntime?.upstreamVersion ?? "—"}${viewRuntime?.upstreamCommit ? ` (${viewRuntime.upstreamCommit.slice(0, 7)})` : ""}`,
        `运行时状态: ${viewRuntime?.status ?? "unavailable"} · ${viewRuntime?.classification ?? "—"}`,
        `托管安装: ${viewEnv?.installer.status ?? "—"}${viewEnv?.installer.availableVersion ? ` · 可更新到 ${viewEnv.installer.availableVersion}` : ""}`,
        `后端: ${viewRuntime?.backend ?? "—"}`,
        `平台: ${viewEnv ? `${viewEnv.platform} · ${viewEnv.arch}` : "—"}`,
        `授权: ${authority ? `${authority.authorityId} · epoch ${authority.authorityEpoch}` : "—"}`,
        `报告生成时间: ${viewDiag?.generatedAt ? fmtDateTime(viewDiag.generatedAt) : "—"}`,
        "",
        `Capabilities (${capList.length}): ${capList.map((capability) => `${capability.id}@${capability.grade}`).join(", ") || "—"}`,
        "",
        `诊断条目 (${viewDiag?.entries.length ?? 0}):`,
        ...(viewDiag?.entries ?? []).map((entry) => `  ${fmtTime(entry.occurredAt)} [${entry.level} · ${entry.scope}] ${formatDiagnosticEntryMessage(entry)}`),
      );
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      show("诊断报告已复制到剪贴板", "copy");
    } catch {
      show("复制失败：剪贴板不可用", "alert-c");
    }
  }, [preview, mock, scenario, viewRuntime, viewEnv, viewDiag, viewCaps, show]);

  const problems = (viewDiag?.entries ?? []).filter((entry) => entry.level === "error" || entry.level === "warning");
  const capList = viewCaps?.capabilities ?? [];
  const installer = viewEnv?.installer;
  const canReinstall = view.hero.showReinstall;

  return (
    <div className="page-wide diag-page">
      <div className="diag-head">
        <div>
          <h1>诊断中心</h1>
          <p className="muted small">检测运行状态、核对版本，并从本地签名制品安装、更新或重装 Runtime。</p>
          {preview ? <p className="tiny muted">演示数据 · 预览开时覆盖真实读模型</p> : null}
        </div>
        <div className="diag-head-actions">
          {preview ? (
            <button
              type="button"
              className="btn outline"
              onClick={() => {
                const index = PREVIEW_CYCLE.findIndex((item) => item.id === scenario);
                setScenario(PREVIEW_CYCLE[(index + 1) % PREVIEW_CYCLE.length]!.id);
              }}
            >
              {PREVIEW_CYCLE.find((item) => item.id === scenario)?.label}
            </button>
          ) : null}
          <button type="button" className="btn outline" disabled={busy} onClick={() => void checkUpdate(true)}>
            <Icon name="update" extra="sm" />检查更新
          </button>
        </div>
      </div>

      <section className={`env-summary ${heroClass(view.hero.kind)}`} aria-labelledby="diagHeroTitle">
        <span className="es-icon" aria-hidden="true"><Icon name={heroIcon(view.hero.kind)} /></span>
        <div className="es-copy">
          <b id="diagHeroTitle">{view.hero.title}</b>
          <div className="small">{view.hero.detail}</div>
        </div>
        <div className="es-actions">
          <button type="button" className="btn primary" disabled={busy} onClick={runPrimary}>
            <Icon name={view.hero.primary === "recheck" ? "pulse" : view.hero.primary === "update" ? "update" : "package"} extra="sm" />
            {primaryLabel(view.hero.primary, busy)}
          </button>
          {view.hero.kind === "down" || view.hero.kind === "failed" ? (
            <button type="button" className="btn outline" disabled={busy || !canReinstall} onClick={() => setConfirmReinstall(true)}>
              <Icon name="refresh" extra="sm" />重装
            </button>
          ) : null}
        </div>
      </section>

      <div className="diag-ver-grid">
        <div className="diag-ver">
          <div className="dv-k">托管 Runtime</div>
          <div className="dv-v">{installer?.version ?? "未安装"}</div>
          <div className="dv-s">
            {installer?.status === "update-available" && installer.availableVersion
              ? `可更新到 ${installer.availableVersion}`
              : installer?.status === "not-installed" && installer.availableVersion
                ? `本地制品 ${installer.availableVersion}`
                : installer?.status === "failed"
                  ? installer.message ?? "安装失败"
                  : installer?.status === "installed"
                    ? "已是当前安装"
                    : "尚无托管安装"}
          </div>
        </div>
        <div className="diag-ver">
          <div className="dv-k">运行中 Runtime</div>
          <div className="dv-v">{viewRuntime?.runtimeVersion ?? "—"}</div>
          <div className="dv-s">{viewRuntime ? `${viewRuntime.status}${viewRuntime.classification ? ` · ${viewRuntime.classification}` : ""}` : "无法读取连接"}</div>
        </div>
        <div className="diag-ver">
          <div className="dv-k">上游 OMP</div>
          <div className="dv-v">{viewRuntime?.upstreamVersion ?? "—"}</div>
          <div className="dv-s">{viewRuntime?.upstreamCommit ? viewRuntime.upstreamCommit.slice(0, 7) : "无 commit"}</div>
        </div>
      </div>

      <div className="diag-section">
        <h3>环境检测</h3>
        <div className="card" id="diagChecks">
          {view.checks.map((check) => (
            <div className="check-row" key={check.id}>
              <span style={{ color: `var(--${check.tone === "ok" ? "green" : check.tone === "warn" ? "amber" : "red"})` }}>
                <Icon name={check.tone === "ok" ? "check" : check.tone === "warn" ? "alert" : "x"} extra="sm" />
              </span>
              <span className="ck-name">{check.label}</span>
              <span className="ck-detail ellipsis">{check.detail}</span>
              <span className="ck-actions">
                {check.action ? (
                  <button type="button" className="btn small outline" disabled={busy && check.action !== "problems"} onClick={() => runCheckAction(check.action!)}>
                    {check.action === "install" ? "安装" : check.action === "update" ? "更新" : "查看"}
                  </button>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="diag-section">
        <h3>维护</h3>
        <div className="set-section">
          <div className="set-row">
            <div>
              <div className="sr-label">检查更新</div>
              <div className="sr-desc">对照本地签名制品与已装版本，不下载远程更新</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" disabled={busy} onClick={() => void checkUpdate(true)}>
                <Icon name="update" extra="sm" />检查更新
              </button>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="sr-label">重装 Runtime</div>
              <div className="sr-desc">用本地签名制品覆盖当前安装并重新激活</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" disabled={busy || !canReinstall} onClick={() => setConfirmReinstall(true)}>
                <Icon name="refresh" extra="sm" />重装
              </button>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="sr-label">复制诊断报告</div>
              <div className="sr-desc">复制脱敏后的版本、连接与问题摘要</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" onClick={() => void copyReport()}>
                <Icon name="copy" extra="sm" />复制
              </button>
            </div>
          </div>
          <div className={`set-row${preview ? "" : " is-unavailable"}`} data-tip={preview ? undefined : CONTRACT.export}>
            <div>
              <div className="sr-label">导出日志</div>
              <div className="sr-desc">{CONTRACT.export}</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" disabled={!preview} onClick={() => preview && show("演示：导出日志不会写文件", "export")}>
                <Icon name="export" extra="sm" />导出
              </button>
            </div>
          </div>
          <div className={`set-row${preview ? "" : " is-unavailable"}`} data-tip={preview ? undefined : CONTRACT.logDir}>
            <div>
              <div className="sr-label">打开日志目录</div>
              <div className="sr-desc">{CONTRACT.logDir}</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" disabled={!preview} onClick={() => preview && show("演示：打开日志目录不会触发外部操作", "folder")}>
                <Icon name="folder" extra="sm" />打开
              </button>
            </div>
          </div>
          <div className={`set-row${preview ? "" : " is-unavailable"}`} data-tip={preview ? undefined : CONTRACT.restart}>
            <div>
              <div className="sr-label">重启 OMP Bridge</div>
              <div className="sr-desc">{CONTRACT.restart}</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" disabled={!preview} onClick={() => preview && show("演示：重启 Bridge 不会真的重启", "refresh")}>
                <Icon name="refresh" extra="sm" />重启
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirmReinstall ? (
        <div className="diag-confirm" role="dialog" aria-labelledby="diagReinstallTitle" aria-modal="true">
          <div>
            <div id="diagReinstallTitle" className="sr-label">重装托管 Runtime？</div>
            <p className="sr-desc">会用本地签名制品覆盖当前安装并重新激活。进行中的会话可能中断。</p>
          </div>
          <div className="diag-confirm-acts">
            <button type="button" className="btn outline" onClick={() => setConfirmReinstall(false)}>取消</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void installRuntime("reinstall")}>确认重装</button>
          </div>
        </div>
      ) : null}

      <div className="diag-section" id="diagProblems">
        <h3><Icon name="alert-c" extra="sm" />最近问题</h3>
        <div className="card" style={{ padding: 6 }}>
          {preview && scenario !== "ok" && scenario !== "fail" ? mock.errors.map((error) => (
            <div className="prob-row diag-err-row" key={`${error.time}-${error.src}`}>
              <span className="prob-sev sev-red" role="img" aria-label="错误"><Icon name="alert-c" extra="sm" /></span>
              <span className="mono tiny muted">{error.time}</span>
              <span className="chip gray xs">{error.src}</span>
              <span className="ellipsis">{error.msg}</span>
            </div>
          )) : problems.length ? problems.map((entry) => (
            <div className="prob-row diag-err-row" key={entry.entryId}>
              <span className={`prob-sev ${entry.level === "error" ? "sev-red" : ""}`} style={entry.level === "warning" ? { color: "var(--amber)" } : undefined} role="img" aria-label={entry.level === "error" ? "错误" : "警告"}>
                <Icon name={entry.level === "error" ? "alert-c" : "alert"} extra="sm" />
              </span>
              <span className="mono tiny muted">{fmtTime(entry.occurredAt)}</span>
              <span className="chip gray xs">{entry.scope}</span>
              <span className="ellipsis">{formatDiagnosticEntryMessage(entry)}</span>
            </div>
          )) : (
            <div className="muted small" style={{ padding: "10px 8px" }}>无最近错误或警告</div>
          )}
        </div>
      </div>

      <details className="diag-advanced">
        <summary><Icon name="chevron-r" extra="sm" /> 高级细节 · Capability 与原始条目</summary>
        <div className="da-body">
          <div className="diag-caps" style={{ marginBottom: 12 }}>
            {capList.length ? capList.map((capability) => (
              <span key={capability.id} className={`chip ${GRADE_TONE[capability.grade] ?? "gray"}`} data-tip={`${capability.grade} · v${capability.version}`}>{capability.id}</span>
            )) : <span className="muted small">无 capability 清单</span>}
          </div>
          <div className="term" style={{ fontSize: "10.5px" }}>
            {preview ? mock.logs.map((line, index) => (
              <div key={index} className={line.tone === "err" ? "err" : "muted"}>{line.text}</div>
            )) : (viewDiag?.entries.length ? viewDiag.entries.map((entry) => (
              <div key={entry.entryId} className={entry.level === "error" ? "err" : entry.level === "warning" ? "warn" : "muted"}>
                {`${fmtTime(entry.occurredAt)} [${entry.level} · ${entry.scope}] ${formatDiagnosticEntryMessage(entry)}`}
              </div>
            )) : <div className="muted">无原始日志条目（read model 未提供）</div>)}
          </div>
        </div>
      </details>

      <p className="tiny muted" style={{ marginTop: 16 }}>上次检测 {formatCheckedAt(viewDiag?.generatedAt)}</p>
      <ToastHost message={notice?.text ?? null} icon={notice?.icon ?? "info"} onDismiss={dismissNotice} />
    </div>
  );
}
