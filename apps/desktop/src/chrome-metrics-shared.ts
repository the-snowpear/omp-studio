/**
 * Desktop-chrome 进程内存指标 IPC 契约。
 *
 * Shared by Main and the sandboxed preload（无 Electron Main API）。
 * 这不是 Host / Studio Bridge 面：Renderer 只请求一次采样，Main 把
 * `app.getAppMetrics()` 投影成「进程类型 + 工作集」，**永不回传 pid 与可执行路径**
 * （沿用「路径/PID 永不到 Renderer」的既有约束）。
 *
 * 存在的理由：这个应用曾经在长对话里涨到 3GB 都没人拦，因为全仓一处内存埋点都没有，
 * 排查时连「是渲染进程、主进程还是 runtime 子进程」都答不出来。
 */

export const CHROME_METRICS_CHANNELS = {
  sample: "omp-studio:desktop:chrome-metrics-sample",
} as const;

/** `app.getAppMetrics()` 里 `type` 的取值，外加一个兜底。 */
export const PROCESS_KINDS = [
  "Browser",
  "Tab",
  "Utility",
  "Zygote",
  "Sandbox helper",
  "GPU",
  "Pepper Plugin",
  "Pepper Plugin Broker",
  "Unknown",
] as const;

export type ProcessKind = (typeof PROCESS_KINDS)[number];

export interface ProcessMemoryRow {
  /** 进程类型；同类型可能有多个（多个渲染进程 / 多个 utility）。 */
  readonly kind: ProcessKind;
  /** 同类型内的序号，从 1 开始。用来在 UI 上区分而不暴露 pid。 */
  readonly ordinal: number;
  /** 当前工作集（KB，Electron 的单位）。 */
  readonly workingSetKb: number;
  /** 峰值工作集（KB）；Electron 在部分平台不提供，缺失时省略。 */
  readonly peakWorkingSetKb?: number;
}

export interface ProcessMemorySample {
  readonly capturedAt: string;
  readonly rows: readonly ProcessMemoryRow[];
  /** 所有进程工作集之和（KB）——「整个应用吃了多少」的那个数。 */
  readonly totalWorkingSetKb: number;
}

const KINDS: ReadonlySet<string> = new Set(PROCESS_KINDS);

export function isProcessKind(value: unknown): value is ProcessKind {
  return typeof value === "string" && KINDS.has(value);
}

/** 采样请求没有入参；任何非空载荷都拒绝，和其余 chrome 面一致。 */
export function parseChromeMetricsPayload(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).length === 0;
}

/**
 * 把 Electron 的 `AppMetrics[]` 投影成可以交给 Renderer 的行。
 *
 * 只取 `type` 与 `memory`：`pid`、`name`、`serviceName`、`integrityLevel` 都不外传。
 * 按工作集降序，方便一眼看出是谁在涨。
 */
export function projectProcessMemory(
  metrics: ReadonlyArray<{
    readonly type?: unknown;
    readonly memory?: { readonly workingSetSize?: unknown; readonly peakWorkingSetSize?: unknown };
  }>,
  capturedAt: string,
): ProcessMemorySample {
  const counts = new Map<ProcessKind, number>();
  const rows: ProcessMemoryRow[] = [];
  let totalWorkingSetKb = 0;
  for (const entry of metrics) {
    const kind = isProcessKind(entry.type) ? entry.type : "Unknown";
    const workingSetKb = typeof entry.memory?.workingSetSize === "number" && entry.memory.workingSetSize >= 0
      ? Math.round(entry.memory.workingSetSize)
      : 0;
    const peak = entry.memory?.peakWorkingSetSize;
    const ordinal = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, ordinal);
    totalWorkingSetKb += workingSetKb;
    rows.push({
      kind,
      ordinal,
      workingSetKb,
      ...(typeof peak === "number" && peak > 0 ? { peakWorkingSetKb: Math.round(peak) } : {}),
    });
  }
  rows.sort((left, right) => right.workingSetKb - left.workingSetKb);
  return { capturedAt, rows, totalWorkingSetKb };
}
