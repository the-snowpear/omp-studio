import type {
  ClientBootstrap,
  DiagnosticEntry,
  DiagnosticReadModel,
  EnvironmentReadModel,
  RuntimeAutoRespawnStatus,
  RuntimeClassification,
  RuntimeConnection,
  RuntimeDisconnectCode,
  RuntimeInstallState,
  RuntimeUnavailableCode,
} from "@omp-studio/client-contract";
import { zh } from "./i18n/locales/zh";

type CapabilityManifest = ClientBootstrap["capabilityManifest"];

/**
 * Translation function signature used by the diagnostics copy builders.
 * `t` resolves i18n keys (optionally with `{param}` interpolation) to localized
 * strings. React components pass `useI18n().t`; non-React callers may pass
 * `translate(locale, key, params)` from I18nContext. Every builder defaults to
 * `zhT` so existing callers keep producing the original Chinese copy.
 */
export type I18nT = (key: string, params?: Record<string, unknown>) => string;

function lookupKey(dict: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split(".");
  let current: unknown = dict;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

function formatParams(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return key in params ? String(params[key]) : match;
  });
}

/** Fallback translator: resolves keys against the zh dictionary. */
const zhT: I18nT = (key, params) => {
  const template = lookupKey(zh as unknown as Record<string, unknown>, key);
  if (template === undefined) return key;
  return formatParams(template, params);
};

export type DiagnosticsHeroKind = "ok" | "update" | "missing" | "down" | "failed" | "installing" | "connecting";
export type DiagnosticsHeroAction = "recheck" | "install" | "update" | "reconnect";
export type DiagnosticsCheckTone = "ok" | "warn" | "error";
export type DiagnosticsCheckAction = "install" | "update" | "problems";

export interface DiagnosticsHero {
  readonly kind: DiagnosticsHeroKind;
  readonly title: string;
  readonly detail: string;
  readonly primary: DiagnosticsHeroAction;
  readonly showReinstall: boolean;
}

export interface DiagnosticsCheck {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly tone: DiagnosticsCheckTone;
  readonly action?: DiagnosticsCheckAction;
}

export interface DiagnosticsViewModel {
  readonly hero: DiagnosticsHero;
  readonly checks: ReadonlyArray<DiagnosticsCheck>;
  readonly problemCount: number;
}

export interface DiagnosticsFact {
  readonly label: string;
  readonly value: string;
}

/**
 * i18n KEYS for runtime connection status labels. The key sets are stable
 * identifiers; resolve with `t(key)` at use sites.
 */
const RUNTIME_LABEL: Record<RuntimeConnection["status"], string> = {
  connected: "diagnostics.statusConnected",
  connecting: "diagnostics.statusConnecting",
  disconnected: "diagnostics.statusDisconnected",
  unavailable: "diagnostics.statusUnavailable",
};

const CLASSIFICATION_LABEL: Record<RuntimeClassification, string> = {
  managed: "diagnostics.classificationManaged",
  unavailable: "diagnostics.classificationUnavailable",
  "compatible-system": "diagnostics.classificationCompatibleSystem",
  "limited-system": "diagnostics.classificationLimitedSystem",
  rejected: "diagnostics.classificationRejected",
};

const DISCONNECT_CODE_LABEL: Record<RuntimeDisconnectCode, string> = {
  "pipe-closed": "diagnostics.disconnectCodePipeClosed",
  "process-exit": "diagnostics.disconnectCodeProcessExit",
  "lease-lost": "diagnostics.disconnectCodeLeaseLost",
  "host-stop": "diagnostics.disconnectCodeHostStop",
};

const AUTO_RESPAWN_LABEL: Record<RuntimeAutoRespawnStatus, string> = {
  scheduled: "diagnostics.autoRespawnScheduled",
  failed: "diagnostics.autoRespawnFailed",
  exhausted: "diagnostics.autoRespawnExhausted",
};

const SIGNATURE_LABEL: Record<RuntimeInstallState["signature"], string> = {
  verified: "diagnostics.signatureVerified",
  unverified: "diagnostics.signatureUnverified",
  unknown: "diagnostics.signatureUnknown",
};

/**
 * Unavailable codes where `runtime.ensure` cannot recover the session.
 * `resolution-rejected` is absent on purpose: `runtime.ensure` re-resolves,
 * so it re-probes the installed Runtime. A transient first-install probe
 * failure must not pin the workbench until the app is restarted.
 */
const NON_RECONNECT_UNAVAILABLE: ReadonlySet<string> = new Set([
  "no-workspace",
  "workspace-unusable",
  "not-installed",
  "resolution-limited",
  "not-wired",
]);

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "no-workspace",
  "workspace-unusable",
  "not-installed",
  "resolution-rejected",
  "resolution-limited",
  "launch-failed",
  "handshake-timeout",
  "spawn-failed",
  "exited-before-ready",
  "not-wired",
]);

/**
 * Localized copy for the resolver rejections an operator can actually act on.
 *
 * `rejectionReason` is an internal English sentence produced by
 * `packages/studio-host/src/runtime-resolver.ts` and it reaches this model
 * verbatim, so without a mapping it prints untranslated into a localized UI.
 * Keys must match those literals exactly. An unmapped reason still falls back
 * to the raw text — losing evidence is worse than losing the translation.
 */
const RESOLUTION_REJECTED_COPY: Readonly<Record<string, { detail: string; problem: string }>> = {
  "managed runtime command manifest hash drift": {
    detail: "diagnostics.rejectedCommandManifestDriftDetail",
    problem: "diagnostics.rejectedCommandManifestDriftProblem",
  },
  "managed runtime capability hash drift": {
    detail: "diagnostics.rejectedCapabilityDriftDetail",
    problem: "diagnostics.rejectedCapabilityDriftProblem",
  },
  "managed runtime command manifest could not be verified": {
    detail: "diagnostics.rejectedCommandManifestUnverifiedDetail",
    problem: "diagnostics.rejectedCommandManifestUnverifiedProblem",
  },
  "runtime command manifest contains unclassified builtins": {
    detail: "diagnostics.rejectedUnclassifiedBuiltinsDetail",
    problem: "diagnostics.rejectedUnclassifiedBuiltinsProblem",
  },
  "installation manifest claims full parity but the runtime evidence does not support it": {
    detail: "diagnostics.rejectedOverclaimedParityDetail",
    problem: "diagnostics.rejectedOverclaimedParityProblem",
  },
};

const DISCONNECT_CODES: ReadonlySet<string> = new Set([
  "pipe-closed",
  "process-exit",
  "lease-lost",
  "host-stop",
]);

const PROCESS_EXIT_RE = /^Runtime process exited \(code=(-?\d+|null)(?:, signal=([^)]+))?\)$/u;

export function isRuntimeUnavailableCode(value: unknown): value is RuntimeUnavailableCode {
  return typeof value === "string" && UNAVAILABLE_CODES.has(value);
}

export function isRuntimeDisconnectCode(value: unknown): value is RuntimeDisconnectCode {
  return typeof value === "string" && DISCONNECT_CODES.has(value);
}

export function isRuntimeAutoRespawnStatus(value: unknown): value is RuntimeAutoRespawnStatus {
  return value === "scheduled" || value === "failed" || value === "exhausted";
}

export function formatRuntimeStatusLabel(status: RuntimeConnection["status"], t: I18nT = zhT): string {
  return t(RUNTIME_LABEL[status]);
}

export function formatRuntimeClassification(classification: RuntimeClassification, t: I18nT = zhT): string {
  return t(CLASSIFICATION_LABEL[classification]);
}

export function formatRuntimeAutoRespawnCopy(status: RuntimeAutoRespawnStatus, t: I18nT = zhT): string {
  return t(AUTO_RESPAWN_LABEL[status]);
}

export function formatRuntimeDisconnectCode(code: RuntimeDisconnectCode, t: I18nT = zhT): string {
  return t(DISCONNECT_CODE_LABEL[code]);
}

/**
 * Manual reconnect can launch or relaunch a managed process.
 * Workspace / install / policy failures need a different primary action.
 */
export function runtimeCanReconnect(runtime: RuntimeConnection | undefined): boolean {
  if (runtime === undefined) return false;
  if (runtime.status === "disconnected") return true;
  if (runtime.status !== "unavailable") return false;
  const code = runtime.unavailableCode;
  if (code === undefined) return true;
  return !NON_RECONNECT_UNAVAILABLE.has(code);
}

export function runtimeCanRestart(runtime: RuntimeConnection | undefined): boolean {
  return runtime?.status === "connected";
}

export function formatRuntimeUnavailableCopy(
  code: RuntimeUnavailableCode | undefined,
  reason: string | undefined,
  t: I18nT = zhT,
): { readonly title: string; readonly detail: string; readonly problem: string } {
  const extra = usefulHostReason(reason);
  switch (code) {
    case "no-workspace":
      return {
        title: t("diagnostics.unavailableNoWorkspaceTitle"),
        detail: t("diagnostics.unavailableNoWorkspaceDetail"),
        problem: t("diagnostics.unavailableNoWorkspaceProblem"),
      };
    case "workspace-unusable":
      return {
        title: t("diagnostics.unavailableWorkspaceUnusableTitle"),
        detail: extra ?? t("diagnostics.unavailableWorkspaceUnusableDetail"),
        problem: extra
          ? t("diagnostics.workspaceUnavailableDetail", { extra })
          : t("diagnostics.unavailableWorkspaceUnusableProblem"),
      };
    case "not-installed":
      return {
        title: t("diagnostics.unavailableNotInstalledTitle"),
        detail: extra ?? t("diagnostics.unavailableNotInstalledDetail"),
        problem: extra
          ? t("diagnostics.unavailableNotInstalledProblemWithReason", { extra })
          : t("diagnostics.unavailableNotInstalledProblem"),
      };
    case "resolution-rejected": {
      const localized = extra === undefined ? undefined : RESOLUTION_REJECTED_COPY[extra];
      if (localized !== undefined) {
        return {
          title: t("diagnostics.unavailableNotAcceptedTitle"),
          detail: t(localized.detail),
          problem: t(localized.problem),
        };
      }
      return {
        title: t("diagnostics.unavailableNotAcceptedTitle"),
        detail: extra ?? t("diagnostics.unavailableResolutionRejectedDetail"),
        problem: extra
          ? t("diagnostics.unavailableResolutionRejectedProblemWithReason", { extra })
          : t("diagnostics.unavailableResolutionRejectedProblem"),
      };
    }
    case "resolution-limited":
      return {
        title: t("diagnostics.unavailableNotAcceptedTitle"),
        detail: extra ?? t("diagnostics.unavailableResolutionLimitedDetail"),
        problem: extra
          ? t("diagnostics.unavailableResolutionLimitedProblemWithReason", { extra })
          : t("diagnostics.unavailableResolutionLimitedProblem"),
      };
    case "handshake-timeout":
      return {
        title: t("diagnostics.unavailableHandshakeTimeoutTitle"),
        detail: extra ?? t("diagnostics.unavailableHandshakeTimeoutDetail"),
        problem: extra
          ? t("diagnostics.unavailableHandshakeTimeoutProblemWithReason", { extra })
          : t("diagnostics.unavailableHandshakeTimeoutProblem"),
      };
    case "spawn-failed":
      return {
        title: t("diagnostics.unavailableSpawnFailedTitle"),
        detail: extra ?? t("diagnostics.unavailableSpawnFailedDetail"),
        problem: extra
          ? t("diagnostics.unavailableSpawnFailedProblemWithReason", { extra })
          : t("diagnostics.unavailableSpawnFailedProblem"),
      };
    case "exited-before-ready":
      return {
        title: t("diagnostics.unavailableExitedBeforeReadyTitle"),
        detail: extra ?? t("diagnostics.unavailableExitedBeforeReadyDetail"),
        problem: extra
          ? t("diagnostics.unavailableExitedBeforeReadyProblemWithReason", { extra })
          : t("diagnostics.unavailableExitedBeforeReadyProblem"),
      };
    case "launch-failed":
      return {
        title: t("diagnostics.unavailableLaunchFailedTitle"),
        detail: extra ?? t("diagnostics.unavailableLaunchFailedDetail"),
        problem: extra
          ? t("diagnostics.unavailableLaunchFailedProblemWithReason", { extra })
          : t("diagnostics.unavailableLaunchFailedProblem"),
      };
    case "not-wired":
      return {
        title: t("diagnostics.unavailableNotWiredTitle"),
        detail: extra ?? t("diagnostics.unavailableNotWiredDetail"),
        problem: extra
          ? t("diagnostics.unavailableNotWiredProblemWithReason", { extra })
          : t("diagnostics.unavailableNotWiredProblem"),
      };
    default:
      return {
        title: t("diagnostics.unavailableDefaultTitle"),
        detail: extra ?? t("diagnostics.unavailableDefaultDetail"),
        problem: extra ?? t("diagnostics.unavailableDefaultProblem"),
      };
  }
}

export function formatRuntimeDisconnectCopy(
  code: RuntimeDisconnectCode | undefined,
  reason: string | undefined,
  t: I18nT = zhT,
): { readonly title: string; readonly detail: string; readonly problem: string } {
  switch (code) {
    case "process-exit": {
      const exit = parseProcessExitReason(reason, t);
      const detail = exit.summary ?? t("diagnostics.disconnectProcessExitFallbackDetail");
      return {
        title: t("diagnostics.disconnectProcessExitTitle"),
        detail,
        problem: exit.problem,
      };
    }
    case "pipe-closed":
      return {
        title: t("diagnostics.disconnectPipeClosedTitle"),
        detail: cannedOrReason(reason, ["Studio Bridge pipe closed"], t("diagnostics.disconnectPipeClosedDetail")),
        problem: t("diagnostics.disconnectPipeClosedProblem"),
      };
    case "lease-lost":
      return {
        title: t("diagnostics.disconnectLeaseLostTitle"),
        detail: cannedOrReason(reason, ["session writer lease was lost"], t("diagnostics.disconnectLeaseLostDetail")),
        problem: t("diagnostics.disconnectLeaseLostProblem"),
      };
    case "host-stop":
      return {
        title: t("diagnostics.disconnectHostStopTitle"),
        detail: cannedOrReason(reason, ["Host stopped the Runtime"], t("diagnostics.disconnectHostStopDetail")),
        problem: t("diagnostics.disconnectHostStopProblem"),
      };
    default:
      return {
        title: t("diagnostics.disconnectDefaultTitle"),
        detail: usefulHostReason(reason) ?? t("diagnostics.disconnectDefaultDetail"),
        problem: usefulHostReason(reason) ?? t("diagnostics.disconnectDefaultProblem"),
      };
  }
}

export function formatDiagnosticEntryMessage(entry: DiagnosticEntry, t: I18nT = zhT): string {
  const code = entry.detail?.code;
  const autoRespawn = entry.detail?.autoRespawn;
  const auto = isRuntimeAutoRespawnStatus(autoRespawn)
    ? formatRuntimeAutoRespawnCopy(autoRespawn, t)
    : undefined;
  let message: string;
  if (isRuntimeUnavailableCode(code)) {
    const reason = typeof entry.detail?.reason === "string" ? entry.detail.reason : undefined;
    message = formatRuntimeUnavailableCopy(code, reason, t).problem;
  } else if (isRuntimeDisconnectCode(code)) {
    const reason = typeof entry.detail?.reason === "string" ? entry.detail.reason : undefined;
    message = formatRuntimeDisconnectCopy(code, reason, t).problem;
  } else {
    message = entry.message;
  }
  return auto === undefined ? message : `${message} · ${auto}`;
}

export function formatRuntimeConnectionLine(runtime: RuntimeConnection, t: I18nT = zhT): string {
  const status = t(RUNTIME_LABEL[runtime.status]);
  const kind = t(CLASSIFICATION_LABEL[runtime.classification]);
  return `${status} · ${kind}`;
}

export function formatRuntimeConnectionFacts(runtime: RuntimeConnection | undefined, t: I18nT = zhT): ReadonlyArray<DiagnosticsFact> {
  if (runtime === undefined) {
    return [{ label: t("diagnostics.factStatus"), value: t("diagnostics.factUnreadable") }];
  }
  const facts: DiagnosticsFact[] = [
    { label: t("diagnostics.factStatus"), value: t(RUNTIME_LABEL[runtime.status]) },
    { label: t("diagnostics.factType"), value: t(CLASSIFICATION_LABEL[runtime.classification]) },
  ];
  if (runtime.status === "unavailable") {
    const copy = formatRuntimeUnavailableCopy(runtime.unavailableCode, runtime.unavailableReason, t);
    facts.push({ label: t("diagnostics.factReasonCode"), value: runtime.unavailableCode ?? "—" });
    facts.push({ label: t("diagnostics.factDetail"), value: copy.detail });
  }
  if (runtime.status === "disconnected") {
    const copy = formatRuntimeDisconnectCopy(runtime.disconnectCode, runtime.disconnectReason, t);
    facts.push({
      label: t("diagnostics.factReasonCode"),
      value: runtime.disconnectCode === undefined ? "—" : t(DISCONNECT_CODE_LABEL[runtime.disconnectCode]),
    });
    facts.push({ label: t("diagnostics.factDetail"), value: copy.detail });
    if (runtime.disconnectedAt !== undefined) {
      facts.push({ label: t("diagnostics.factDisconnectedAt"), value: formatCheckedAt(runtime.disconnectedAt, t) });
    }
    if (runtime.autoRespawn !== undefined) {
      facts.push({ label: t("diagnostics.factAutoRespawn"), value: t(AUTO_RESPAWN_LABEL[runtime.autoRespawn]) });
    }
  }
  return facts;
}

export function formatCheckedAt(iso: string | undefined, t: I18nT = zhT): string {
  if (iso === undefined) return t("diagnostics.notCheckedYet");
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  return new Date(then).toLocaleString();
}

export function deriveDiagnosticsView(
  input: {
    readonly runtime?: RuntimeConnection;
    readonly environment?: EnvironmentReadModel;
    readonly diagnostics?: DiagnosticReadModel;
    readonly capabilities?: CapabilityManifest;
  },
  t: I18nT = zhT,
): DiagnosticsViewModel {
  const installer = input.environment?.installer;
  const runtime = input.runtime ?? input.environment?.runtime;
  const problems = (input.diagnostics?.entries ?? []).filter((entry) => entry.level === "error" || entry.level === "warning");
  const capCount = input.capabilities?.capabilities.length ?? 0;
  const runtimeVersion = runtime?.runtimeVersion ?? installer?.version;
  const generatedAt = input.diagnostics?.generatedAt;
  const hero = deriveHero(
    {
      problemCount: problems.length,
      ...(runtime === undefined ? {} : { runtime }),
      ...(installer === undefined ? {} : { installer }),
      ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
      ...(generatedAt === undefined ? {} : { generatedAt }),
    },
    t,
  );
  return {
    hero,
    problemCount: problems.length,
    checks: [
      runtimeCheck(runtime, t),
      installCheck(installer, t),
      signatureCheck(installer, t),
      platformCheck(input.environment, t),
      capabilityCheck(capCount, t),
      problemsCheck(problems.length, t),
    ],
  };
}

function deriveHero(
  input: {
    readonly runtime?: RuntimeConnection;
    readonly installer?: RuntimeInstallState;
    readonly problemCount: number;
    readonly runtimeVersion?: string;
    readonly generatedAt?: string;
  },
  t: I18nT,
): DiagnosticsHero {
  const checked = t("diagnostics.heroCheckedAt", { time: formatCheckedAt(input.generatedAt, t) });
  const version = input.runtimeVersion
    ? t("diagnostics.heroCurrentVersion", { version: input.runtimeVersion })
    : t("diagnostics.versionUnknown");
  const signature = input.installer
    ? t("diagnostics.heroSignature", { sig: t(SIGNATURE_LABEL[input.installer.signature]) })
    : t("diagnostics.heroSignatureUnknown");
  const baseDetail = `${version} · ${signature} · ${checked}`;

  if (input.installer?.status === "installing") {
    return {
      kind: "installing",
      title: t("diagnostics.heroInstallingTitle"),
      detail: baseDetail,
      primary: "recheck",
      showReinstall: false,
    };
  }
  if (input.installer?.status === "failed") {
    return {
      kind: "failed",
      title: t("diagnostics.heroInstallFailedTitle"),
      detail: input.installer.message ? `${input.installer.message} · ${checked}` : baseDetail,
      primary: "recheck",
      showReinstall: true,
    };
  }
  if (input.installer?.status === "not-installed") {
    const available = input.installer.availableVersion
      ? t("diagnostics.heroFoundLocalArtifact", { version: input.installer.availableVersion })
      : t("diagnostics.heroNoLocalArtifact");
    return {
      kind: "missing",
      title: t("diagnostics.heroNotInstalledTitle"),
      detail: `${available} ${checked}`,
      primary: "install",
      showReinstall: false,
    };
  }
  if (input.installer?.status === "update-available") {
    const next = input.installer.availableVersion
      ? t("diagnostics.heroUpdateTo", { version: input.installer.availableVersion })
      : t("diagnostics.heroFoundNewerArtifact");
    return {
      kind: "update",
      title: t("diagnostics.heroUpdateTitle"),
      detail: `${version} · ${next} · ${checked}`,
      primary: "update",
      showReinstall: true,
    };
  }
  if (input.runtime?.status === "connecting") {
    return {
      kind: "connecting",
      title: t("diagnostics.heroConnectingTitle"),
      detail: baseDetail,
      primary: "recheck",
      showReinstall: input.installer?.status === "installed",
    };
  }
  if (input.runtime?.status === "unavailable") {
    const copy = formatRuntimeUnavailableCopy(input.runtime.unavailableCode, input.runtime.unavailableReason, t);
    return {
      kind: "down",
      title: copy.title,
      detail: `${copy.detail} · ${baseDetail}`,
      primary: runtimeCanReconnect(input.runtime) ? "reconnect" : "recheck",
      showReinstall: input.installer?.status === "installed",
    };
  }
  if (input.runtime?.status === "disconnected") {
    const copy = formatRuntimeDisconnectCopy(input.runtime.disconnectCode, input.runtime.disconnectReason, t);
    const auto = input.runtime.autoRespawn === undefined ? "" : ` · ${t(AUTO_RESPAWN_LABEL[input.runtime.autoRespawn])}`;
    return {
      kind: "down",
      title: copy.title,
      detail: `${copy.detail}${auto} · ${baseDetail}`,
      primary: "reconnect",
      showReinstall: input.installer?.status === "installed",
    };
  }
  const extra = input.problemCount > 0 ? ` · ${t("diagnostics.heroRecentProblems", { count: input.problemCount })}` : "";
  return {
    kind: "ok",
    title: t("diagnostics.heroOkTitle"),
    detail: `${baseDetail}${extra}`,
    primary: "recheck",
    showReinstall: input.installer?.status === "installed",
  };
}

function runtimeCheck(runtime: RuntimeConnection | undefined, t: I18nT): DiagnosticsCheck {
  if (runtime === undefined) {
    return { id: "runtime", label: t("diagnostics.checkRuntimeLabel"), detail: t("diagnostics.checkRuntimeUnreadable"), tone: "warn" };
  }
  if (runtime.status === "connected") {
    return { id: "runtime", label: t("diagnostics.checkRuntimeLabel"), detail: formatRuntimeConnectionLine(runtime, t), tone: "ok" };
  }
  if (runtime.status === "connecting") {
    return { id: "runtime", label: t("diagnostics.checkRuntimeLabel"), detail: t(RUNTIME_LABEL.connecting), tone: "warn" };
  }
  if (runtime.status === "unavailable") {
    const copy = formatRuntimeUnavailableCopy(runtime.unavailableCode, runtime.unavailableReason, t);
    return { id: "runtime", label: t("diagnostics.checkRuntimeLabel"), detail: copy.problem, tone: "error" };
  }
  if (runtime.status === "disconnected") {
    const copy = formatRuntimeDisconnectCopy(runtime.disconnectCode, runtime.disconnectReason, t);
    const auto = runtime.autoRespawn === undefined ? "" : ` · ${t(AUTO_RESPAWN_LABEL[runtime.autoRespawn])}`;
    return { id: "runtime", label: t("diagnostics.checkRuntimeLabel"), detail: `${copy.problem}${auto}`, tone: "error" };
  }
  return { id: "runtime", label: t("diagnostics.checkRuntimeLabel"), detail: t(RUNTIME_LABEL[runtime.status]), tone: "error" };
}

function installCheck(installer: RuntimeInstallState | undefined, t: I18nT): DiagnosticsCheck {
  if (installer === undefined) {
    return { id: "install", label: t("diagnostics.checkInstallLabel"), detail: t("diagnostics.checkInstallUnreadable"), tone: "warn" };
  }
  if (installer.status === "installed") {
    return {
      id: "install",
      label: t("diagnostics.checkInstallLabel"),
      detail: installer.version ? t("diagnostics.installedVersion", { version: installer.version }) : t("diagnostics.installed"),
      tone: "ok",
    };
  }
  if (installer.status === "update-available") {
    return {
      id: "install",
      label: t("diagnostics.checkInstallLabel"),
      detail: `${installer.version ?? t("diagnostics.installed")} · ${t("diagnostics.updateAvailableTo", {
        version: installer.availableVersion ?? t("diagnostics.newVersion"),
      })}`,
      tone: "warn",
      action: "update",
    };
  }
  if (installer.status === "installing") {
    return { id: "install", label: t("diagnostics.checkInstallLabel"), detail: t("diagnostics.installing"), tone: "warn" };
  }
  if (installer.status === "failed") {
    return {
      id: "install",
      label: t("diagnostics.checkInstallLabel"),
      detail: installer.message ?? t("diagnostics.installFailed"),
      tone: "error",
      action: "install",
    };
  }
  return {
    id: "install",
    label: t("diagnostics.checkInstallLabel"),
    detail: installer.availableVersion
      ? t("diagnostics.notInstalledWithArtifact", { version: installer.availableVersion })
      : t("diagnostics.notInstalled"),
    tone: "error",
    action: "install",
  };
}

function signatureCheck(installer: RuntimeInstallState | undefined, t: I18nT): DiagnosticsCheck {
  if (installer === undefined) {
    return { id: "signature", label: t("diagnostics.checkSignatureLabel"), detail: t("diagnostics.checkSignatureUnreadable"), tone: "warn" };
  }
  if (installer.signature === "verified") {
    return { id: "signature", label: t("diagnostics.checkSignatureLabel"), detail: t(SIGNATURE_LABEL.verified), tone: "ok" };
  }
  if (installer.signature === "unverified") {
    return { id: "signature", label: t("diagnostics.checkSignatureLabel"), detail: t(SIGNATURE_LABEL.unverified), tone: "error" };
  }
  return { id: "signature", label: t("diagnostics.checkSignatureLabel"), detail: t(SIGNATURE_LABEL.unknown), tone: "warn" };
}

function platformCheck(environment: EnvironmentReadModel | undefined, t: I18nT): DiagnosticsCheck {
  if (environment === undefined) {
    return { id: "platform", label: t("diagnostics.checkPlatformLabel"), detail: t("diagnostics.checkPlatformUnreadable"), tone: "warn" };
  }
  return { id: "platform", label: t("diagnostics.checkPlatformLabel"), detail: `${environment.platform} · ${environment.arch}`, tone: "ok" };
}

function capabilityCheck(count: number, t: I18nT): DiagnosticsCheck {
  if (count === 0) {
    return { id: "capability", label: "Capability", detail: t("diagnostics.noCapabilityManifest"), tone: "warn" };
  }
  return { id: "capability", label: "Capability", detail: t("diagnostics.capabilitiesNegotiated", { count }), tone: "ok" };
}

function problemsCheck(count: number, t: I18nT): DiagnosticsCheck {
  if (count === 0) {
    return { id: "problems", label: t("diagnostics.checkProblemsLabel"), detail: t("diagnostics.noProblems"), tone: "ok" };
  }
  return {
    id: "problems",
    label: t("diagnostics.checkProblemsLabel"),
    detail: t("diagnostics.problemCount", { count }),
    tone: count > 0 ? "warn" : "ok",
    action: "problems",
  };
}

function parseProcessExitReason(reason: string | undefined, t: I18nT): { readonly summary?: string; readonly problem: string } {
  const trimmed = reason?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return { problem: t("diagnostics.disconnectProcessExitProblem") };
  }
  const match = PROCESS_EXIT_RE.exec(trimmed);
  if (match === null) {
    return { summary: trimmed, problem: t("diagnostics.disconnectProcessExitProblemWithReason", { reason: trimmed }) };
  }
  const code = match[1];
  const signal = match[2];
  const codePart = code !== undefined && code !== "null" ? t("diagnostics.exitCode", { code }) : undefined;
  const signalPart = signal !== undefined && signal !== "none" ? t("diagnostics.exitSignal", { signal }) : undefined;
  const bits = [codePart, signalPart].filter((bit): bit is string => bit !== undefined);
  if (bits.length === 0) {
    return { problem: t("diagnostics.disconnectProcessExitProblem") };
  }
  const joined = bits.join(t("diagnostics.listSeparator"));
  return {
    summary: t("diagnostics.managedProcessExitedSummary", { bits: joined }),
    problem: t("diagnostics.disconnectProcessExitProblemWithBits", { bits: joined }),
  };
}

function usefulHostReason(reason: string | undefined): string | undefined {
  const extra = reason?.trim();
  return extra && extra.length > 0 ? extra : undefined;
}

function cannedOrReason(reason: string | undefined, canned: readonly string[], fallback: string): string {
  const extra = usefulHostReason(reason);
  if (extra === undefined) return fallback;
  return canned.includes(extra) ? fallback : extra;
}
