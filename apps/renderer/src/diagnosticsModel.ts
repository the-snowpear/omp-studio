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

type CapabilityManifest = ClientBootstrap["capabilityManifest"];

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

const RUNTIME_LABEL: Record<RuntimeConnection["status"], string> = {
  connected: "已连接",
  connecting: "正在连接",
  disconnected: "连接已断开",
  unavailable: "不可用",
};

const CLASSIFICATION_LABEL: Record<RuntimeClassification, string> = {
  managed: "托管",
  unavailable: "不可用",
  "compatible-system": "系统兼容",
  "limited-system": "系统受限",
  rejected: "已拒绝",
};

const DISCONNECT_CODE_LABEL: Record<RuntimeDisconnectCode, string> = {
  "pipe-closed": "管道关闭",
  "process-exit": "进程退出",
  "lease-lost": "租约丢失",
  "host-stop": "Host 停止",
};

const AUTO_RESPAWN_LABEL: Record<RuntimeAutoRespawnStatus, string> = {
  scheduled: "已安排自动重连",
  failed: "自动重连失败",
  exhausted: "自动重连已用尽",
};

/** Unavailable codes where `runtime.ensure` cannot recover the session. */
const NON_RECONNECT_UNAVAILABLE: ReadonlySet<string> = new Set([
  "no-workspace",
  "workspace-unusable",
  "not-installed",
  "resolution-rejected",
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

export function formatRuntimeStatusLabel(status: RuntimeConnection["status"]): string {
  return RUNTIME_LABEL[status];
}

export function formatRuntimeClassification(classification: RuntimeClassification): string {
  return CLASSIFICATION_LABEL[classification];
}

export function formatRuntimeAutoRespawnCopy(status: RuntimeAutoRespawnStatus): string {
  return AUTO_RESPAWN_LABEL[status];
}

export function formatRuntimeDisconnectCode(code: RuntimeDisconnectCode): string {
  return DISCONNECT_CODE_LABEL[code];
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
): { readonly title: string; readonly detail: string; readonly problem: string } {
  const extra = usefulHostReason(reason);
  switch (code) {
    case "no-workspace":
      return {
        title: "未选择工作区",
        detail: "选择项目后才会启动 Runtime。",
        problem: "未选择工作区，Runtime 不会启动",
      };
    case "workspace-unusable":
      return {
        title: "工作区不可用",
        detail: extra ?? "工作区目录不存在、不是目录，或为符号链接。",
        problem: extra ? `工作区不可用：${extra}` : "工作区不可用，Runtime 不会启动",
      };
    case "not-installed":
      return {
        title: "尚未安装托管 Runtime",
        detail: extra ?? "未发现已安装的托管 Runtime。",
        problem: extra ? `尚未安装托管 Runtime：${extra}` : "尚未安装托管 Runtime",
      };
    case "resolution-rejected":
      return {
        title: "Runtime 未被接受",
        detail: extra ?? "探测未通过，Runtime 未启动。",
        problem: extra ? `Runtime 未被接受：${extra}` : "Runtime 未被接受",
      };
    case "resolution-limited":
      return {
        title: "Runtime 未被接受",
        detail: extra ?? "能力不足，Runtime 未启动。",
        problem: extra ? `Runtime 能力不足：${extra}` : "Runtime 能力不足，未启动",
      };
    case "handshake-timeout":
      return {
        title: "Runtime 握手超时",
        detail: extra ?? "Studio Bridge 握手超时。",
        problem: extra ? `Runtime 握手超时：${extra}` : "Runtime 握手超时",
      };
    case "spawn-failed":
      return {
        title: "Runtime 无法启动",
        detail: extra ?? "托管进程未能启动。",
        problem: extra ? `Runtime 无法启动：${extra}` : "Runtime 无法启动",
      };
    case "exited-before-ready":
      return {
        title: "Runtime 启动后退出",
        detail: extra ?? "进程在握手完成前退出。",
        problem: extra ? `Runtime 启动后退出：${extra}` : "Runtime 在就绪前退出",
      };
    case "launch-failed":
      return {
        title: "Runtime 启动失败",
        detail: extra ?? "进程启动或握手失败。",
        problem: extra ? `Runtime 启动失败：${extra}` : "Runtime 启动失败",
      };
    case "not-wired":
      return {
        title: "Runtime 未接入",
        detail: extra ?? "当前 Host 未接入 Runtime 会话端口。",
        problem: extra ? `Runtime 未接入：${extra}` : "Runtime 未接入会话端口",
      };
    default:
      return {
        title: "Runtime 不可用",
        detail: extra ?? "不可用",
        problem: extra ?? "Runtime 不可用",
      };
  }
}

export function formatRuntimeDisconnectCopy(
  code: RuntimeDisconnectCode | undefined,
  reason: string | undefined,
): { readonly title: string; readonly detail: string; readonly problem: string } {
  switch (code) {
    case "process-exit": {
      const exit = parseProcessExitReason(reason);
      const detail = exit.summary ?? "托管进程在连接后退出。";
      return {
        title: "Runtime 进程已退出",
        detail,
        problem: exit.problem,
      };
    }
    case "pipe-closed":
      return {
        title: "Runtime 连接已断开",
        detail: cannedOrReason(reason, ["Studio Bridge pipe closed"], "Studio Bridge 管道已关闭。"),
        problem: "Runtime 连接已断开",
      };
    case "lease-lost":
      return {
        title: "Runtime 会话租约丢失",
        detail: cannedOrReason(reason, ["session writer lease was lost"], "会话写租约失效，进程已停止。"),
        problem: "Runtime 会话租约丢失",
      };
    case "host-stop":
      return {
        title: "Runtime 已停止",
        detail: cannedOrReason(reason, ["Host stopped the Runtime"], "Host 主动停止了 Runtime。"),
        problem: "Runtime 已停止",
      };
    default:
      return {
        title: "Runtime 连接已断开",
        detail: usefulHostReason(reason) ?? "连接已断开。",
        problem: usefulHostReason(reason) ?? "Runtime 连接已断开",
      };
  }
}

export function formatDiagnosticEntryMessage(entry: DiagnosticEntry): string {
  const code = entry.detail?.code;
  const autoRespawn = entry.detail?.autoRespawn;
  const auto = isRuntimeAutoRespawnStatus(autoRespawn)
    ? formatRuntimeAutoRespawnCopy(autoRespawn)
    : undefined;
  let message: string;
  if (isRuntimeUnavailableCode(code)) {
    const reason = typeof entry.detail?.reason === "string" ? entry.detail.reason : undefined;
    message = formatRuntimeUnavailableCopy(code, reason).problem;
  } else if (isRuntimeDisconnectCode(code)) {
    const reason = typeof entry.detail?.reason === "string" ? entry.detail.reason : undefined;
    message = formatRuntimeDisconnectCopy(code, reason).problem;
  } else {
    message = entry.message;
  }
  return auto === undefined ? message : `${message} · ${auto}`;
}

export function formatRuntimeConnectionLine(runtime: RuntimeConnection): string {
  const status = RUNTIME_LABEL[runtime.status];
  const kind = CLASSIFICATION_LABEL[runtime.classification];
  return `${status} · ${kind}`;
}

export function formatRuntimeConnectionFacts(runtime: RuntimeConnection | undefined): ReadonlyArray<DiagnosticsFact> {
  if (runtime === undefined) {
    return [{ label: "状态", value: "无法读取连接" }];
  }
  const facts: DiagnosticsFact[] = [
    { label: "状态", value: RUNTIME_LABEL[runtime.status] },
    { label: "类型", value: CLASSIFICATION_LABEL[runtime.classification] },
  ];
  if (runtime.status === "unavailable") {
    const copy = formatRuntimeUnavailableCopy(runtime.unavailableCode, runtime.unavailableReason);
    facts.push({ label: "原因码", value: runtime.unavailableCode ?? "—" });
    facts.push({ label: "说明", value: copy.detail });
  }
  if (runtime.status === "disconnected") {
    const copy = formatRuntimeDisconnectCopy(runtime.disconnectCode, runtime.disconnectReason);
    facts.push({
      label: "原因码",
      value: runtime.disconnectCode === undefined ? "—" : DISCONNECT_CODE_LABEL[runtime.disconnectCode],
    });
    facts.push({ label: "说明", value: copy.detail });
    if (runtime.disconnectedAt !== undefined) {
      facts.push({ label: "断开时间", value: formatCheckedAt(runtime.disconnectedAt) });
    }
    if (runtime.autoRespawn !== undefined) {
      facts.push({ label: "自动重连", value: AUTO_RESPAWN_LABEL[runtime.autoRespawn] });
    }
  }
  return facts;
}

const SIGNATURE_LABEL: Record<RuntimeInstallState["signature"], string> = {
  verified: "已验证",
  unverified: "未验证",
  unknown: "未知",
};

export function formatCheckedAt(iso: string | undefined): string {
  if (iso === undefined) return "尚未检测";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  return new Date(then).toLocaleString();
}

export function deriveDiagnosticsView(input: {
  readonly runtime?: RuntimeConnection;
  readonly environment?: EnvironmentReadModel;
  readonly diagnostics?: DiagnosticReadModel;
  readonly capabilities?: CapabilityManifest;
}): DiagnosticsViewModel {
  const installer = input.environment?.installer;
  const runtime = input.runtime ?? input.environment?.runtime;
  const problems = (input.diagnostics?.entries ?? []).filter((entry) => entry.level === "error" || entry.level === "warning");
  const capCount = input.capabilities?.capabilities.length ?? 0;
  const runtimeVersion = runtime?.runtimeVersion ?? installer?.version;
  const generatedAt = input.diagnostics?.generatedAt;
  const hero = deriveHero({
    problemCount: problems.length,
    ...(runtime === undefined ? {} : { runtime }),
    ...(installer === undefined ? {} : { installer }),
    ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
  });
  return {
    hero,
    problemCount: problems.length,
    checks: [
      runtimeCheck(runtime),
      installCheck(installer),
      signatureCheck(installer),
      platformCheck(input.environment),
      capabilityCheck(capCount),
      problemsCheck(problems.length),
    ],
  };
}

function deriveHero(input: {
  readonly runtime?: RuntimeConnection;
  readonly installer?: RuntimeInstallState;
  readonly problemCount: number;
  readonly runtimeVersion?: string;
  readonly generatedAt?: string;
}): DiagnosticsHero {
  const checked = `上次检测 ${formatCheckedAt(input.generatedAt)}`;
  const version = input.runtimeVersion ? `当前 ${input.runtimeVersion}` : "版本未知";
  const signature = input.installer ? `签名${SIGNATURE_LABEL[input.installer.signature]}` : "签名未知";
  const baseDetail = `${version} · ${signature} · ${checked}`;

  if (input.installer?.status === "installing") {
    return {
      kind: "installing",
      title: "正在安装 Runtime",
      detail: baseDetail,
      primary: "recheck",
      showReinstall: false,
    };
  }
  if (input.installer?.status === "failed") {
    return {
      kind: "failed",
      title: "Runtime 安装失败",
      detail: input.installer.message ? `${input.installer.message} · ${checked}` : baseDetail,
      primary: "recheck",
      showReinstall: true,
    };
  }
  if (input.installer?.status === "not-installed") {
    const available = input.installer.availableVersion ? `发现本地制品 ${input.installer.availableVersion}。` : "未发现本地签名制品。";
    return {
      kind: "missing",
      title: "尚未安装托管 Runtime",
      detail: `${available} ${checked}`,
      primary: "install",
      showReinstall: false,
    };
  }
  if (input.installer?.status === "update-available") {
    const next = input.installer.availableVersion ? `可更新到 ${input.installer.availableVersion}` : "发现更新的本地制品";
    return {
      kind: "update",
      title: "有可用 Runtime 更新",
      detail: `${version} · ${next} · ${checked}`,
      primary: "update",
      showReinstall: true,
    };
  }
  if (input.runtime?.status === "connecting") {
    return {
      kind: "connecting",
      title: "正在连接 Runtime",
      detail: baseDetail,
      primary: "recheck",
      showReinstall: input.installer?.status === "installed",
    };
  }
  if (input.runtime?.status === "unavailable") {
    const copy = formatRuntimeUnavailableCopy(input.runtime.unavailableCode, input.runtime.unavailableReason);
    return {
      kind: "down",
      title: copy.title,
      detail: `${copy.detail} · ${baseDetail}`,
      primary: runtimeCanReconnect(input.runtime) ? "reconnect" : "recheck",
      showReinstall: input.installer?.status === "installed",
    };
  }
  if (input.runtime?.status === "disconnected") {
    const copy = formatRuntimeDisconnectCopy(input.runtime.disconnectCode, input.runtime.disconnectReason);
    const auto = input.runtime.autoRespawn === undefined ? "" : ` · ${AUTO_RESPAWN_LABEL[input.runtime.autoRespawn]}`;
    return {
      kind: "down",
      title: copy.title,
      detail: `${copy.detail}${auto} · ${baseDetail}`,
      primary: "reconnect",
      showReinstall: input.installer?.status === "installed",
    };
  }
  const extra = input.problemCount > 0 ? ` · ${input.problemCount} 条最近问题` : "";
  return {
    kind: "ok",
    title: "Runtime 正常",
    detail: `${baseDetail}${extra}`,
    primary: "recheck",
    showReinstall: input.installer?.status === "installed",
  };
}

function runtimeCheck(runtime: RuntimeConnection | undefined): DiagnosticsCheck {
  if (runtime === undefined) {
    return { id: "runtime", label: "Runtime 连接", detail: "无法读取连接状态", tone: "warn" };
  }
  if (runtime.status === "connected") {
    return { id: "runtime", label: "Runtime 连接", detail: formatRuntimeConnectionLine(runtime), tone: "ok" };
  }
  if (runtime.status === "connecting") {
    return { id: "runtime", label: "Runtime 连接", detail: RUNTIME_LABEL.connecting, tone: "warn" };
  }
  if (runtime.status === "unavailable") {
    const copy = formatRuntimeUnavailableCopy(runtime.unavailableCode, runtime.unavailableReason);
    return { id: "runtime", label: "Runtime 连接", detail: copy.problem, tone: "error" };
  }
  if (runtime.status === "disconnected") {
    const copy = formatRuntimeDisconnectCopy(runtime.disconnectCode, runtime.disconnectReason);
    const auto = runtime.autoRespawn === undefined ? "" : ` · ${AUTO_RESPAWN_LABEL[runtime.autoRespawn]}`;
    return { id: "runtime", label: "Runtime 连接", detail: `${copy.problem}${auto}`, tone: "error" };
  }
  return { id: "runtime", label: "Runtime 连接", detail: RUNTIME_LABEL[runtime.status], tone: "error" };
}

function installCheck(installer: RuntimeInstallState | undefined): DiagnosticsCheck {
  if (installer === undefined) {
    return { id: "install", label: "托管安装", detail: "无法读取安装状态", tone: "warn" };
  }
  if (installer.status === "installed") {
    return { id: "install", label: "托管安装", detail: installer.version ? `已安装 ${installer.version}` : "已安装", tone: "ok" };
  }
  if (installer.status === "update-available") {
    return {
      id: "install",
      label: "托管安装",
      detail: `${installer.version ?? "已安装"} · 可更新到 ${installer.availableVersion ?? "新版本"}`,
      tone: "warn",
      action: "update",
    };
  }
  if (installer.status === "installing") {
    return { id: "install", label: "托管安装", detail: "正在安装", tone: "warn" };
  }
  if (installer.status === "failed") {
    return { id: "install", label: "托管安装", detail: installer.message ?? "安装失败", tone: "error", action: "install" };
  }
  return {
    id: "install",
    label: "托管安装",
    detail: installer.availableVersion ? `未安装 · 本地制品 ${installer.availableVersion}` : "未安装",
    tone: "error",
    action: "install",
  };
}

function signatureCheck(installer: RuntimeInstallState | undefined): DiagnosticsCheck {
  if (installer === undefined) {
    return { id: "signature", label: "签名", detail: "无法读取签名", tone: "warn" };
  }
  if (installer.signature === "verified") {
    return { id: "signature", label: "签名", detail: SIGNATURE_LABEL.verified, tone: "ok" };
  }
  if (installer.signature === "unverified") {
    return { id: "signature", label: "签名", detail: SIGNATURE_LABEL.unverified, tone: "error" };
  }
  return { id: "signature", label: "签名", detail: SIGNATURE_LABEL.unknown, tone: "warn" };
}

function platformCheck(environment: EnvironmentReadModel | undefined): DiagnosticsCheck {
  if (environment === undefined) {
    return { id: "platform", label: "平台", detail: "无法读取平台", tone: "warn" };
  }
  return { id: "platform", label: "平台", detail: `${environment.platform} · ${environment.arch}`, tone: "ok" };
}

function capabilityCheck(count: number): DiagnosticsCheck {
  if (count === 0) {
    return { id: "capability", label: "Capability", detail: "无 capability 清单", tone: "warn" };
  }
  return { id: "capability", label: "Capability", detail: `${count} 项已协商`, tone: "ok" };
}

function problemsCheck(count: number): DiagnosticsCheck {
  if (count === 0) {
    return { id: "problems", label: "最近问题", detail: "无错误或警告", tone: "ok" };
  }
  return { id: "problems", label: "最近问题", detail: `${count} 条错误或警告`, tone: count > 0 ? "warn" : "ok", action: "problems" };
}

function parseProcessExitReason(reason: string | undefined): { readonly summary?: string; readonly problem: string } {
  const trimmed = reason?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return { problem: "Runtime 进程已退出" };
  }
  const match = PROCESS_EXIT_RE.exec(trimmed);
  if (match === null) {
    return { summary: trimmed, problem: `Runtime 进程已退出：${trimmed}` };
  }
  const code = match[1];
  const signal = match[2];
  const codePart = code !== undefined && code !== "null" ? `退出码 ${code}` : undefined;
  const signalPart = signal !== undefined && signal !== "none" ? `信号 ${signal}` : undefined;
  const bits = [codePart, signalPart].filter((bit): bit is string => bit !== undefined);
  if (bits.length === 0) {
    return { problem: "Runtime 进程已退出" };
  }
  return {
    summary: `托管进程在连接后退出（${bits.join("，")}）。`,
    problem: `Runtime 进程已退出（${bits.join("，")}）`,
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
