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
  formatRuntimeConnectionFacts,
  formatRuntimeConnectionLine,
  runtimeCanReconnect,
  runtimeCanRestart,
  type DiagnosticsCheck,
  type DiagnosticsHero,
} from "./diagnosticsModel";
import { ActionProgressBar } from "./ActionProgressBar";
import { ensureRuntimeConnection } from "./runtimeEnsure";
import { isUpdateCheckTimeout, queryWithTimeout } from "./updateCheck";

type DiagAction = {
  readonly kind: "reconnect" | "restart" | "install" | "update" | "reinstall" | "recheck" | "check-update";
  readonly label: string;
  readonly step: number;
  readonly steps: number;
};

type CapManifest = ClientBootstrap["capabilityManifest"];

export const DIAGNOSTICS_INTENT_KEY = "omp.diagnosticsIntent";
export type DiagnosticsIntent = "check-update" | "reconnect" | "restart";

const DIAGNOSTICS_INTENTS: ReadonlySet<string> = new Set(["check-update", "reconnect", "restart"]);

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
    return typeof value.intent === "string" && DIAGNOSTICS_INTENTS.has(value.intent)
      ? (value.intent as DiagnosticsIntent)
      : null;
  } catch {
    return null;
  }
}

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
  if (kind === "update" || kind === "installing" || kind === "connecting") return "update";
  if (kind === "missing") return "package";
  return "alert-c";
}

function heroClass(kind: DiagnosticsHero["kind"]): string {
  if (kind === "ok") return "ok";
  if (kind === "update" || kind === "installing" || kind === "connecting") return "warn";
  return "fail";
}

function primaryLabel(action: DiagnosticsHero["primary"], busy: DiagAction | null): string {
  if (action === "install") return busy?.kind === "install" ? "正在安装…" : "安装 Runtime";
  if (action === "update") return busy?.kind === "update" ? "正在更新…" : "更新 Runtime";
  if (action === "reconnect") return busy?.kind === "reconnect" || busy?.kind === "restart" ? "正在连接…" : "重新连接 Runtime";
  return busy?.kind === "recheck" ? "正在检测…" : "重新检测";
}

function primaryIcon(action: DiagnosticsHero["primary"]): string {
  if (action === "update") return "update";
  if (action === "install") return "package";
  if (action === "reconnect") return "refresh";
  return "pulse";
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
  const [busy, setBusy] = useState<DiagAction | null>(null);
  const [confirmReinstall, setConfirmReinstall] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
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

  const refreshQueries = useCallback(async (): Promise<boolean> => {
    const [d, c, e] = await Promise.allSettled([
      client.query("diagnostics.get", {}),
      client.query("capabilities.get", {}),
      client.query("environment.get", {}),
    ]);
    if (d.status === "fulfilled") setDiag(d.value);
    if (c.status === "fulfilled") setCaps(c.value);
    if (e.status === "fulfilled") setEnv(e.value);
    return d.status === "fulfilled";
  }, [client]);

  const beginAction = useCallback((action: DiagAction) => {
    setBusy(action);
  }, []);

  const refresh = useCallback(async (mode: "recheck" | "reconnect" = "recheck") => {
    if (preview) {
      show(mode === "reconnect" ? "已重新连接 Runtime（演示）" : "已重新检测 OMP（演示）", "check");
      return;
    }
    beginAction(
      mode === "reconnect"
        ? { kind: "reconnect", label: "正在请求连接", step: 1, steps: 2 }
        : { kind: "recheck", label: "正在重新检测", step: 1, steps: 1 },
    );
    try {
      let reconnected = false;
      if (mode === "reconnect" || runtimeCanReconnect(runtime ?? env?.runtime)) {
        const result = await ensureRuntimeConnection(client, {}, (progress) => {
          beginAction({ kind: "reconnect", ...progress });
        });
        if (result.ok) {
          reconnected = true;
        } else {
          show(result.message, "alert-c");
        }
      }
      if (mode === "recheck") {
        beginAction({ kind: "recheck", label: "正在刷新诊断", step: 1, steps: 1 });
      }
      const queried = await refreshQueries();
      if (reconnected) {
        show("Runtime 已重新连接", "check");
      } else if (queried) {
        show("已重新检测 OMP", "check");
      } else {
        show("重新检测失败", "alert-c");
      }
    } catch {
      show("重新检测失败", "alert-c");
    } finally {
      setBusy(null);
    }
  }, [beginAction, client, preview, show, runtime, env, refreshQueries]);

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
    if (notify) beginAction({ kind: "check-update", label: "正在对照本地制品", step: 1, steps: 1 });
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
      if (notify) setBusy(null);
    }
  }, [beginAction, client, preview, scenario, mock.availableVersion, show]);

  const checkUpdateRef = useRef(checkUpdate);
  checkUpdateRef.current = checkUpdate;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const intent = takeDiagnosticsIntent();
    if (intent === "check-update") {
      void checkUpdateRef.current(true);
      return;
    }
    if (intent === "reconnect") {
      void refreshRef.current("reconnect");
      return;
    }
    if (intent === "restart") {
      setConfirmRestart(true);
      return;
    }
    void checkUpdateRef.current(false);
  }, []);

  const installRuntime = useCallback(async (kind: "install" | "update" | "reinstall") => {
    setConfirmReinstall(false);
    if (preview) {
      const labels = { install: "已安装 Runtime（演示）", update: "已更新 Runtime（演示）", reinstall: "已重装 Runtime（演示）" };
      show(labels[kind], "check");
      return;
    }
    beginAction({
      kind,
      label: kind === "update" ? "正在更新 Runtime" : kind === "reinstall" ? "正在重装 Runtime" : "正在安装 Runtime",
      step: 1,
      steps: 2,
    });
    try {
      const handle = await client.command("runtime.install", {});
      const receipt = await waitForCommandReceipt(client, handle.requestId);
      beginAction({
        kind,
        label: "正在刷新环境",
        step: 2,
        steps: 2,
      });
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
      setBusy(null);
    }
  }, [beginAction, client, preview, show]);

  const restartRuntime = useCallback(async () => {
    setConfirmRestart(false);
    if (preview) {
      show("已重启并重新连接 Runtime（演示）", "check");
      return;
    }
    beginAction({ kind: "restart", label: "正在停止当前托管进程", step: 1, steps: 3 });
    try {
      const result = await ensureRuntimeConnection(client, { force: true }, (progress) => {
        beginAction({ kind: "restart", ...progress });
      });
      beginAction({ kind: "restart", label: "正在刷新诊断", step: 3, steps: 3 });
      await refreshQueries();
      if (result.ok) show("Runtime 已重启并重新连接", "check");
      else show(result.message, "alert-c");
    } catch (error) {
      show(error instanceof Error ? error.message : "重启 Runtime 失败", "alert-c");
    } finally {
      setBusy(null);
    }
  }, [beginAction, client, preview, show, refreshQueries]);

  const openLogDir = useCallback(async () => {
    if (preview) {
      show("演示：打开日志目录不会触发外部操作", "folder");
      return;
    }
    const api = window.ompStudioChrome;
    if (api?.openLogDir === undefined) {
      show("当前环境无法打开日志目录", "alert-c");
      return;
    }
    try {
      const result = await api.openLogDir();
      if (result.ok) show("已打开日志目录", "folder");
      else show(result.message, "alert-c");
    } catch (error) {
      show(error instanceof Error ? error.message : "无法打开日志目录", "alert-c");
    }
  }, [preview, show]);

  const exportLogs = useCallback(async () => {
    if (preview) {
      show("演示：导出日志不会写文件", "export");
      return;
    }
    const api = window.ompStudioChrome;
    if (api?.exportLogs === undefined) {
      show("当前环境无法导出日志", "alert-c");
      return;
    }
    try {
      const result = await api.exportLogs();
      if (result.ok) show("已导出 Host 日志", "export");
      else if ("cancelled" in result && result.cancelled) return;
      else show("message" in result ? result.message : "导出失败", "alert-c");
    } catch (error) {
      show(error instanceof Error ? error.message : "导出失败", "alert-c");
    }
  }, [preview, show]);

  const runPrimary = useCallback(() => {
    if (view.hero.primary === "install") void installRuntime("install");
    else if (view.hero.primary === "update") void installRuntime("update");
    else if (view.hero.primary === "reconnect") void refresh("reconnect");
    else void refresh("recheck");
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
        `运行时状态: ${viewRuntime ? formatRuntimeConnectionLine(viewRuntime) : "无法读取"}`,
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
  const canRestart = runtimeCanRestart(viewRuntime);

  return (
    <div className="page-wide diag-page">
      <div className="diag-head">
        <div>
          <h1>诊断中心</h1>
          <p className="muted small">检测运行状态、核对版本，并从本地签名制品安装、更新或重装 Runtime。断开时可重新连接；已连接时可重启托管进程，完成后会自动重新连接。</p>
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
          <button type="button" className="btn outline" disabled={busy !== null} onClick={() => void checkUpdate(true)}>
            <Icon name="update" extra="sm" />检查更新
          </button>
        </div>
      </div>

      <section className={`env-summary ${heroClass(view.hero.kind)}`} aria-labelledby="diagHeroTitle" aria-busy={busy !== null}>
        <span className="es-icon" aria-hidden="true"><Icon name={heroIcon(view.hero.kind)} /></span>
        <div className="es-copy">
          <b id="diagHeroTitle">{view.hero.title}</b>
          <div className="small">{view.hero.detail}</div>
        </div>
        <div className="es-actions">
          <button type="button" className="btn primary" disabled={busy !== null} onClick={runPrimary}>
            <Icon name={primaryIcon(view.hero.primary)} extra="sm" />
            {primaryLabel(view.hero.primary, busy)}
          </button>
          {view.hero.kind === "down" || view.hero.kind === "failed" ? (
            <button type="button" className="btn outline" disabled={busy !== null || !canReinstall} onClick={() => setConfirmReinstall(true)}>
              <Icon name="refresh" extra="sm" />重装
            </button>
          ) : null}
        </div>
      </section>
      {busy !== null ? (
        <ActionProgressBar label={busy.label} step={busy.step} steps={busy.steps} />
      ) : null}

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
          <div className="dv-s">{viewRuntime ? formatRuntimeConnectionLine(viewRuntime) : "无法读取连接"}</div>
        </div>
        <div className="diag-ver">
          <div className="dv-k">上游 OMP</div>
          <div className="dv-v">{viewRuntime?.upstreamVersion ?? "—"}</div>
          <div className="dv-s">{viewRuntime?.upstreamCommit ? viewRuntime.upstreamCommit.slice(0, 7) : "无 commit"}</div>
        </div>
      </div>

      {viewRuntime?.status === "disconnected" || viewRuntime?.status === "unavailable" ? (
        <div className="diag-kv" aria-label="Runtime 断开详情">
          {formatRuntimeConnectionFacts(viewRuntime).map((fact) => (
            <div className="dk" key={fact.label}>
              <div className="k">{fact.label}</div>
              <div className="v">{fact.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="diag-section">
        <h3>环境检测</h3>
        <div className="card" id="diagChecks">
          {view.checks.map((check) => (
            <div className="check-row" key={check.id}>
              <span style={{ color: `var(--${check.tone === "ok" ? "green" : check.tone === "warn" ? "amber" : "red"})` }}>
                <Icon name={check.tone === "ok" ? "check" : check.tone === "warn" ? "alert" : "x"} extra="sm" />
              </span>
              <span className="ck-name">{check.label}</span>
              <span className="ck-detail wrap">{check.detail}</span>
              <span className="ck-actions">
                {check.action ? (
                  <button type="button" className="btn small outline" disabled={busy !== null && check.action !== "problems"} onClick={() => runCheckAction(check.action!)}>
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
              <button type="button" className="btn outline" disabled={busy !== null} onClick={() => void checkUpdate(true)}>
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
              <button type="button" className="btn outline" disabled={busy !== null || !canReinstall} onClick={() => setConfirmReinstall(true)}>
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
          <div className="set-row">
            <div>
              <div className="sr-label">重启 Runtime</div>
              <div className="sr-desc">停止当前托管进程并重新启动，完成后会自动重新连接。进行中的会话可能中断。</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" disabled={busy !== null || !canRestart} onClick={() => setConfirmRestart(true)}>
                <Icon name="refresh" extra="sm" />重启
              </button>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="sr-label">导出日志</div>
              <div className="sr-desc">另存近期 Host 日志。路径留在系统对话框，不会进入界面。</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" onClick={() => void exportLogs()}>
                <Icon name="export" extra="sm" />导出
              </button>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="sr-label">打开日志目录</div>
              <div className="sr-desc">在资源管理器中打开 Host 日志目录。</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" onClick={() => void openLogDir()}>
                <Icon name="folder" extra="sm" />打开
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirmRestart ? (
        <div className="diag-confirm" role="dialog" aria-labelledby="diagRestartTitle" aria-modal="true">
          <div>
            <div id="diagRestartTitle" className="sr-label">重启 Runtime？</div>
            <p className="sr-desc">会停止当前托管进程并重新启动，完成后会自动重新连接。进行中的会话可能中断。</p>
          </div>
          <div className="diag-confirm-acts">
            <button type="button" className="btn outline" onClick={() => setConfirmRestart(false)}>取消</button>
            <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void restartRuntime()}>确认重启</button>
          </div>
        </div>
      ) : null}

      {confirmReinstall ? (
        <div className="diag-confirm" role="dialog" aria-labelledby="diagReinstallTitle" aria-modal="true">
          <div>
            <div id="diagReinstallTitle" className="sr-label">重装托管 Runtime？</div>
            <p className="sr-desc">会用本地签名制品覆盖当前安装并重新激活。进行中的会话可能中断。</p>
          </div>
          <div className="diag-confirm-acts">
            <button type="button" className="btn outline" onClick={() => setConfirmReinstall(false)}>取消</button>
            <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void installRuntime("reinstall")}>确认重装</button>
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
              <span className="prob-msg">{error.msg}</span>
            </div>
          )) : problems.length ? problems.map((entry) => (
            <div className="prob-row diag-err-row" key={entry.entryId}>
              <span className={`prob-sev ${entry.level === "error" ? "sev-red" : ""}`} style={entry.level === "warning" ? { color: "var(--amber)" } : undefined} role="img" aria-label={entry.level === "error" ? "错误" : "警告"}>
                <Icon name={entry.level === "error" ? "alert-c" : "alert"} extra="sm" />
              </span>
              <span className="mono tiny muted">{fmtTime(entry.occurredAt)}</span>
              <span className="chip gray xs">{entry.scope}</span>
              <span className="prob-msg">{formatDiagnosticEntryMessage(entry)}</span>
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
