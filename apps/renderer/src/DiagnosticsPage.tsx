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
import { ProcessMemoryPanel } from "./ProcessMemoryPanel";
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
import { useI18n } from "./i18n";
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

const PREVIEW_CYCLE: ReadonlyArray<{ id: PreviewDiagScenario; labelKey: string }> = [
  { id: "update", labelKey: "diagnostics.previewUpdateAvailable" },
  { id: "ok", labelKey: "diagnostics.previewEnvironmentOk" },
  { id: "fail", labelKey: "diagnostics.previewCheckFailed" },
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

function previewInstaller(scenario: PreviewDiagScenario, t: (key: string) => string): RuntimeInstallState {
  const mock = PREVIEW_DIAGNOSTICS;
  if (scenario === "fail") {
    return { status: "failed", version: mock.version, signature: "unknown", message: t("diagnostics.previewActivationFailed") };
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

function primaryLabel(action: DiagnosticsHero["primary"], busy: DiagAction | null, t: (key: string) => string): string {
  if (action === "install") return busy?.kind === "install" ? t("diagnostics.installProgress") : t("diagnostics.installRuntime");
  if (action === "update") return busy?.kind === "update" ? t("diagnostics.updateProgress") : t("diagnostics.updateRuntime");
  if (action === "reconnect") return busy?.kind === "reconnect" || busy?.kind === "restart" ? t("diagnostics.connectProgress") : t("diagnostics.reconnect");
  return busy?.kind === "recheck" ? t("diagnostics.recheckProgress") : t("diagnostics.recheck");
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
  const { t } = useI18n();
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

  const previewInstallerState = previewInstaller(scenario, t);
  const currentPreviewScenario = PREVIEW_CYCLE.find((item) => item.id === scenario);
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
    }, (k, p) => t(k, p as any)),
    [viewRuntime, viewEnv, viewDiag, viewCaps, t],
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
      show(mode === "reconnect" ? t("diagnostics.reconnectedRuntimeDemo") : t("diagnostics.recheckedOmpDemo"), "check");
      return;
    }
    beginAction(
      mode === "reconnect"
        ? { kind: "reconnect", label: t("diagnostics.requestingConnection"), step: 1, steps: 2 }
        : { kind: "recheck", label: t("diagnostics.rechecking"), step: 1, steps: 1 },
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
        beginAction({ kind: "recheck", label: t("diagnostics.refreshingDiagnostics"), step: 1, steps: 1 });
      }
      const queried = await refreshQueries();
      if (reconnected) {
        show(t("diagnostics.runtimeReconnected"), "check");
      } else if (queried) {
        show(t("diagnostics.ompRechecked"), "check");
      } else {
        show(t("diagnostics.recheckFailed"), "alert-c");
      }
    } catch {
      show(t("diagnostics.recheckFailed"), "alert-c");
    } finally {
      setBusy(null);
    }
  }, [beginAction, client, preview, show, runtime, env, refreshQueries, t]);

  const checkUpdate = useCallback(async (notify: boolean) => {
    if (preview) {
      if (notify) {
        show(
          scenario === "update"
            ? t("diagnostics.updateCheckedDemo", { version: mock.availableVersion })
            : scenario === "ok"
              ? t("diagnostics.latestArtifactDemo")
              : t("diagnostics.checkUpdateFailedDemo"),
          scenario === "fail" ? "alert-c" : "check",
        );
      }
      return;
    }
    if (notify) beginAction({ kind: "check-update", label: t("diagnostics.comparingLocalArtifact"), step: 1, steps: 1 });
    try {
      const next = await queryWithTimeout(() => client.query("environment.get", {}));
      setEnv(next);
      if (!notify) return;
      if (next.installer.status === "update-available") {
        show(
          next.installer.availableVersion
            ? t("diagnostics.foundLocalUpdateWith", { version: next.installer.availableVersion })
            : t("diagnostics.foundLocalUpdate"),
          "update",
        );
      } else if (next.installer.status === "not-installed") {
        show(next.installer.availableVersion ? t("diagnostics.notInstalledWithArtifact", { version: next.installer.availableVersion }) : t("diagnostics.noInstallableArtifact"), "package");
      } else if (next.installer.status === "failed") {
        show(next.installer.message ?? t("diagnostics.installStateFailed"), "alert-c");
      } else {
        show(t("diagnostics.latestArtifact"), "check");
      }
    } catch (error) {
      if (notify) show(isUpdateCheckTimeout(error) ? t("diagnostics.updateCheckTimeout") : t("diagnostics.updateCheckFailed"), "alert-c");
    } finally {
      if (notify) setBusy(null);
    }
  }, [beginAction, client, preview, scenario, mock.availableVersion, show, t]);

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
      const labels = { install: t("diagnostics.installedRuntimeDemo"), update: t("diagnostics.updatedRuntimeDemo"), reinstall: t("diagnostics.reinstalledRuntimeDemo") };
      show(labels[kind], "check");
      return;
    }
    beginAction({
      kind,
      label: kind === "update" ? t("diagnostics.updatingRuntime") : kind === "reinstall" ? t("diagnostics.reinstallingRuntime") : t("diagnostics.installingRuntime"),
      step: 1,
      steps: 2,
    });
    try {
      const handle = await client.command("runtime.install", {});
      const receipt = await waitForCommandReceipt(client, handle.requestId);
      beginAction({
        kind,
        label: t("diagnostics.refreshingEnv"),
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
        show(kind === "update" ? t("diagnostics.runtimeUpdated") : kind === "reinstall" ? t("diagnostics.runtimeReinstalled") : t("diagnostics.runtimeInstalled"), "check");
      } else {
        const message = receipt.status === "failed" ? receipt.error.message : t("diagnostics.installIncomplete");
        show(message, "alert-c");
      }
    } catch (error) {
      show(error instanceof Error ? error.message : t("diagnostics.installFailed"), "alert-c");
    } finally {
      setBusy(null);
    }
  }, [beginAction, client, preview, show]);

  const restartRuntime = useCallback(async () => {
    setConfirmRestart(false);
    if (preview) {
      show(t("diagnostics.restartedDemo"), "check");
      return;
    }
    beginAction({ kind: "restart", label: t("diagnostics.stoppingManagedProcess"), step: 1, steps: 3 });
    try {
      const result = await ensureRuntimeConnection(client, { force: true }, (progress) => {
        beginAction({ kind: "restart", ...progress });
      });
      beginAction({ kind: "restart", label: t("diagnostics.refreshingDiagnostics"), step: 3, steps: 3 });
      await refreshQueries();
      if (result.ok) show(t("diagnostics.runtimeRestarted"), "check");
      else show(result.message, "alert-c");
    } catch (error) {
      show(error instanceof Error ? error.message : t("diagnostics.restartRuntimeFailed"), "alert-c");
    } finally {
      setBusy(null);
    }
  }, [beginAction, client, preview, show, refreshQueries]);

  const openLogDir = useCallback(async () => {
    if (preview) {
      show(t("diagnostics.openLogsDemoToast"), "folder");
      return;
    }
    const api = window.ompStudioChrome;
    if (api?.openLogDir === undefined) {
      show(t("diagnostics.openLogsUnavailable"), "alert-c");
      return;
    }
    try {
      const result = await api.openLogDir();
      if (result.ok) show(t("diagnostics.openedLogs"), "folder");
      else show(result.message, "alert-c");
    } catch (error) {
      show(error instanceof Error ? error.message : t("diagnostics.openLogsFailed"), "alert-c");
    }
  }, [preview, show]);

  const exportLogs = useCallback(async () => {
    if (preview) {
      show(t("diagnostics.exportLogsDemoToast"), "export");
      return;
    }
    const api = window.ompStudioChrome;
    if (api?.exportLogs === undefined) {
      show(t("diagnostics.exportLogsUnavailable"), "alert-c");
      return;
    }
    try {
      const result = await api.exportLogs();
      if (result.ok) show(t("diagnostics.exportedLogs"), "export");
      else if ("cancelled" in result && result.cancelled) return;
      else show("message" in result ? result.message : t("diagnostics.exportLogsFailed"), "alert-c");
    } catch (error) {
      show(error instanceof Error ? error.message : t("diagnostics.exportLogsFailed"), "alert-c");
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
    const lines: string[] = [t("diagnostics.reportTitle")];
    if (preview) {
      lines.push(
        `${t("diagnostics.reportOmpVersion")}: ${mock.version}`,
        `${t("diagnostics.reportAvailableArtifact")}: ${mock.availableVersion}`,
        `${t("diagnostics.reportUpstreamVersion")}: ${mock.upstreamVersion} (${mock.upstreamCommit})`,
        `${t("diagnostics.reportPlatform")}: ${mock.platform} · ${mock.arch}`,
        `${t("diagnostics.reportDemoScenario")}: ${scenario}`,
        "",
        `Capabilities: ${mock.capabilities.join(", ")}`,
        "",
        `${t("diagnostics.reportRecentErrors")}:`,
        ...mock.errors.map((error) => `  ${error.time} [${error.src}] ${error.msg}`),
      );
    } else {
      const authority = viewDiag?.authority ?? viewEnv?.authority;
      const capList = viewCaps?.capabilities ?? [];
      lines.push(
        `${t("diagnostics.reportOmpVersion")}: ${viewRuntime?.runtimeVersion ?? "—"}`,
        `${t("diagnostics.reportUpstreamVersion")}: ${viewRuntime?.upstreamVersion ?? "—"}${viewRuntime?.upstreamCommit ? ` (${viewRuntime.upstreamCommit.slice(0, 7)})` : ""}`,
        `${t("diagnostics.reportRuntimeStatus")}: ${viewRuntime ? formatRuntimeConnectionLine(viewRuntime, (k) => t(k)) : t("diagnostics.cannotRead")}`,
        `${t("diagnostics.reportManagedInstall")}: ${viewEnv?.installer.status ?? "—"}${viewEnv?.installer.availableVersion ? ` · ${t("diagnostics.updatableTo", { version: viewEnv.installer.availableVersion })}` : ""}`,
        `${t("diagnostics.reportBackend")}: ${viewRuntime?.backend ?? "—"}`,
        `${t("diagnostics.reportPlatform")}: ${viewEnv ? `${viewEnv.platform} · ${viewEnv.arch}` : "—"}`,
        `${t("diagnostics.reportAuthority")}: ${authority ? `${authority.authorityId} · epoch ${authority.authorityEpoch}` : "—"}`,
        `${t("diagnostics.reportGeneratedAt")}: ${viewDiag?.generatedAt ? fmtDateTime(viewDiag.generatedAt) : "—"}`,
        "",
        `Capabilities (${capList.length}): ${capList.map((capability) => `${capability.id}@${capability.grade}`).join(", ") || "—"}`,
        "",
        `${t("diagnostics.reportDiagEntries")} (${viewDiag?.entries.length ?? 0}):`,
        ...(viewDiag?.entries ?? []).map((entry) => `  ${fmtTime(entry.occurredAt)} [${entry.level} · ${entry.scope}] ${formatDiagnosticEntryMessage(entry)}`),
      );
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      show(t("diagnostics.diagReportCopied"), "copy");
    } catch {
      show(t("diagnostics.diagReportCopyFailed"), "alert-c");
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
          <h1>{t("diagnostics.title")}</h1>
          <p className="muted small">{t("diagnostics.desc")}</p>
          {preview ? <p className="tiny muted">{t("diagnostics.previewNote")}</p> : null}
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
              {currentPreviewScenario ? t(currentPreviewScenario.labelKey) : ""}
            </button>
          ) : null}
          <button type="button" className="btn outline" disabled={busy !== null} onClick={() => void checkUpdate(true)}>
            <Icon name="update" extra="sm" />{t("diagnostics.checkUpdate")}
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
            {primaryLabel(view.hero.primary, busy, t)}
          </button>
          {view.hero.kind === "down" || view.hero.kind === "failed" ? (
            <button type="button" className="btn outline" disabled={busy !== null || !canReinstall} onClick={() => setConfirmReinstall(true)}>
              <Icon name="refresh" extra="sm" />{t("diagnostics.reinstallRuntime")}
            </button>
          ) : null}
        </div>
      </section>

      <ProcessMemoryPanel enabled={!preview} />
      {busy !== null ? (
        <ActionProgressBar label={busy.label} step={busy.step} steps={busy.steps} />
      ) : null}

      <div className="diag-ver-grid">
        <div className="diag-ver">
          <div className="dv-k">{t("diagnostics.managedRuntimeTitle")}</div>
          <div className="dv-v">{installer?.version ?? t("common.notInstalled")}</div>
          <div className="dv-s">
            {installer?.status === "update-available" && installer.availableVersion
              ? t("diagnostics.updatableTo", { version: installer.availableVersion })
              : installer?.status === "not-installed" && installer.availableVersion
                ? t("diagnostics.localArtifact", { version: installer.availableVersion })
                : installer?.status === "failed"
                  ? installer.message ?? t("diagnostics.installFailed")
                  : installer?.status === "installed"
                    ? t("diagnostics.isCurrentInstall")
                    : t("diagnostics.noManagedInstall")}
          </div>
        </div>
        <div className="diag-ver">
          <div className="dv-k">{t("diagnostics.runningRuntimeTitle")}</div>
          <div className="dv-v">{viewRuntime?.runtimeVersion ?? "—"}</div>
          <div className="dv-s">{viewRuntime ? formatRuntimeConnectionLine(viewRuntime, (k) => t(k)) : t("diagnostics.cannotReadConnection")}</div>
        </div>
        <div className="diag-ver">
          <div className="dv-k">{t("diagnostics.upstreamOmpTitle")}</div>
          <div className="dv-v">{viewRuntime?.upstreamVersion ?? "—"}</div>
          <div className="dv-s">{viewRuntime?.upstreamCommit ? viewRuntime.upstreamCommit.slice(0, 7) : t("diagnostics.noCommit")}</div>
        </div>
      </div>

      {viewRuntime?.status === "disconnected" || viewRuntime?.status === "unavailable" ? (
        <div className="diag-kv" aria-label={t("diagnostics.disconnectDetailsAria")}>
          {formatRuntimeConnectionFacts(viewRuntime).map((fact) => (
            <div className="dk" key={fact.label}>
              <div className="k">{fact.label}</div>
              <div className="v">{fact.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="diag-section">
        <h3>{t("diagnostics.envCheckTitle")}</h3>
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
                    {check.action === "install" ? t("common.install") : check.action === "update" ? t("common.update") : t("common.view")}
                  </button>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="diag-section">
        <h3>{t("diagnostics.maintenanceTitle")}</h3>
        <div className="set-section">
          <div className="set-row">
            <div>
              <div className="sr-label">{t("diagnostics.checkUpdateLabel")}</div>
              <div className="sr-desc">{t("diagnostics.checkUpdateDesc")}</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" disabled={busy !== null} onClick={() => void checkUpdate(true)}>
                <Icon name="update" extra="sm" />{t("diagnostics.checkUpdateLabel")}
              </button>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="sr-label">{t("diagnostics.reinstallRuntimeLabel")}</div>
              <div className="sr-desc">{t("diagnostics.reinstallRuntimeDesc")}</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" disabled={busy !== null || !canReinstall} onClick={() => setConfirmReinstall(true)}>
                <Icon name="refresh" extra="sm" />{t("common.reinstall")}
              </button>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="sr-label">{t("diagnostics.copyReportLabel")}</div>
              <div className="sr-desc">{t("diagnostics.copyReportDesc")}</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" onClick={() => void copyReport()}>
                <Icon name="copy" extra="sm" />{t("common.copy")}
              </button>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="sr-label">{t("diagnostics.restartRuntimeLabel")}</div>
              <div className="sr-desc">{t("diagnostics.restartRuntimeDesc")}</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" disabled={busy !== null || !canRestart} onClick={() => setConfirmRestart(true)}>
                <Icon name="refresh" extra="sm" />{t("common.restart")}
              </button>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="sr-label">{t("diagnostics.exportLogsLabel")}</div>
              <div className="sr-desc">{t("diagnostics.exportLogsDesc")}</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" onClick={() => void exportLogs()}>
                <Icon name="export" extra="sm" />{t("common.export")}
              </button>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="sr-label">{t("diagnostics.openLogsLabel")}</div>
              <div className="sr-desc">{t("diagnostics.openLogsDesc")}</div>
            </div>
            <div className="sr-control">
              <button type="button" className="btn outline" onClick={() => void openLogDir()}>
                <Icon name="folder" extra="sm" />{t("common.open")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirmRestart ? (
        <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={() => { if (busy === null) setConfirmRestart(false); }}>
          <section
            className="modal create-project-modal create-branch-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="diagRestartTitle"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="create-project-head">
              <div>
                <span className="create-project-kicker">RUNTIME</span>
                <h2 id="diagRestartTitle">{t("diagnostics.restartConfirmTitle")}</h2>
                <p className="create-branch-sub">{t("diagnostics.restartConfirmDesc")}</p>
              </div>
              <button type="button" className="icon-btn" aria-label={t("common.close")} disabled={busy !== null} onClick={() => setConfirmRestart(false)}><Icon name="x" /></button>
            </div>
            <div className="create-project-foot">
              <button type="button" className="btn outline" disabled={busy !== null} onClick={() => setConfirmRestart(false)}>{t("common.cancel")}</button>
              <button type="button" className="btn primary" autoFocus disabled={busy !== null} onClick={() => void restartRuntime()}>{t("diagnostics.confirmRestart")}</button>
            </div>
          </section>
        </div>
      ) : null}

      {confirmReinstall ? (
        <div className="diag-confirm" role="dialog" aria-labelledby="diagReinstallTitle" aria-modal="true">
          <div>
            <div id="diagReinstallTitle" className="sr-label">{t("diagnostics.reinstallConfirmTitle")}</div>
            <p className="sr-desc">{t("diagnostics.reinstallConfirmDesc")}</p>
          </div>
          <div className="diag-confirm-acts">
            <button type="button" className="btn outline" onClick={() => setConfirmReinstall(false)}>{t("common.cancel")}</button>
            <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void installRuntime("reinstall")}>{t("diagnostics.confirmReinstall")}</button>
          </div>
        </div>
      ) : null}

      <div className="diag-section" id="diagProblems">
        <h3><Icon name="alert-c" extra="sm" />{t("diagnostics.recentIssuesTitle")}</h3>
        <div className="card" style={{ padding: 6 }}>
          {preview && scenario !== "ok" && scenario !== "fail" ? mock.errors.map((error) => (
            <div className="prob-row diag-err-row" key={`${error.time}-${error.src}`}>
              <span className="prob-sev sev-red" role="img" aria-label={t("diagnostics.levelError")}><Icon name="alert-c" extra="sm" /></span>
              <span className="mono tiny muted">{error.time}</span>
              <span className="chip gray xs">{error.src}</span>
              <span className="prob-msg">{error.msg}</span>
            </div>
          )) : problems.length ? problems.map((entry) => (
            <div className="prob-row diag-err-row" key={entry.entryId}>
              <span className={`prob-sev ${entry.level === "error" ? "sev-red" : ""}`} style={entry.level === "warning" ? { color: "var(--amber)" } : undefined} role="img" aria-label={entry.level === "error" ? t("diagnostics.levelError") : t("diagnostics.levelWarning")}>
                <Icon name={entry.level === "error" ? "alert-c" : "alert"} extra="sm" />
              </span>
              <span className="mono tiny muted">{fmtTime(entry.occurredAt)}</span>
              <span className="chip gray xs">{entry.scope}</span>
              <span className="prob-msg">{formatDiagnosticEntryMessage(entry)}</span>
            </div>
          )) : (
            <div className="muted small" style={{ padding: "10px 8px" }}>{t("diagnostics.noRecentErrorsOrWarnings")}</div>
          )}
        </div>
      </div>

      <details className="diag-advanced">
        <summary><Icon name="chevron-r" extra="sm" /> {t("diagnostics.advancedDetailsSummary")}</summary>
        <div className="da-body">
          <div className="diag-caps" style={{ marginBottom: 12 }}>
            {capList.length ? capList.map((capability) => (
              <span key={capability.id} className={`chip ${GRADE_TONE[capability.grade] ?? "gray"}`} data-tip={`${capability.grade} · v${capability.version}`}>{capability.id}</span>
            )) : <span className="muted small">{t("diagnostics.noCapabilities")}</span>}
          </div>
          <div className="term" style={{ fontSize: "10.5px" }}>
            {preview ? mock.logs.map((line, index) => (
              <div key={index} className={line.tone === "err" ? "err" : "muted"}>{line.text}</div>
            )) : (viewDiag?.entries.length ? viewDiag.entries.map((entry) => (
              <div key={entry.entryId} className={entry.level === "error" ? "err" : entry.level === "warning" ? "warn" : "muted"}>
                {`${fmtTime(entry.occurredAt)} [${entry.level} · ${entry.scope}] ${formatDiagnosticEntryMessage(entry)}`}
              </div>
            )) : <div className="muted">{t("diagnostics.noRawLogEntries")}</div>)}
          </div>
        </div>
      </details>

      <p className="tiny muted" style={{ marginTop: 16 }}>{t("diagnostics.lastChecked", { time: formatCheckedAt(viewDiag?.generatedAt) })}</p>
      <ToastHost message={notice?.text ?? null} icon={notice?.icon ?? "info"} onDismiss={dismissNotice} />
    </div>
  );
}
