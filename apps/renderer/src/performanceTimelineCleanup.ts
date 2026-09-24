/**
 * 开发态 Performance timeline 清理（性能计划 W11）。
 *
 * 开发会话里 React 与手工打点会持续累积 performance 的 marks/measures，这里每 10 秒
 * 清理一次，限制开发会话长期保留的诊断记录。仅 `import.meta.env.DEV` 启用；
 * `VITE_OMP_PRESERVE_PERFORMANCE_TIMELINE=1` 或性能 harness（`window.ompPerf`）在场时
 * 固定不启动，避免清掉测量现场。生产构建不得启动清理器。
 */

export const PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS = 10_000;

/** 清理器读取的环境开关；默认绑定真实构建环境，测试整体注入。 */
export interface PerformanceTimelineCleanupEnv {
  /** 仅开发构建为 true（`import.meta.env.DEV`）。 */
  readonly dev: boolean;
  /** `VITE_OMP_PRESERVE_PERFORMANCE_TIMELINE=1`：录制期间保留 marks/measures。 */
  readonly preserveTimeline: boolean;
}

/**
 * User Timing 出口。方法声明为可选：jsdom 等环境的 `performance` 没有
 * clearMarks/clearMeasures，缺方法时清理器不启动。
 */
export interface PerformanceTimelineApi {
  clearMarks?(): void;
  clearMeasures?(): void;
}

export interface PerformanceTimelineCleanupOptions {
  readonly env?: PerformanceTimelineCleanupEnv;
  /** 性能 harness 探活；默认读 harness 入口设置的全局标记 `window.ompPerf`。 */
  readonly isPerfHarnessActive?: () => boolean;
  readonly performanceApi?: PerformanceTimelineApi;
}

function readEnv(): PerformanceTimelineCleanupEnv {
  return {
    dev: import.meta.env.DEV,
    preserveTimeline: import.meta.env.VITE_OMP_PRESERVE_PERFORMANCE_TIMELINE === "1",
  };
}

function defaultIsPerfHarnessActive(): boolean {
  return typeof window !== "undefined" && window.ompPerf !== undefined;
}

function defaultPerformanceApi(): PerformanceTimelineApi | undefined {
  return typeof performance === "undefined" ? undefined : performance;
}

const noopDispose = (): void => undefined;

let activeDispose: (() => void) | null = null;

/**
 * 启动开发态清理，返回停止函数（入口把它接进 `import.meta.hot.dispose`）。
 * 幂等：已启动时重复调用返回同一个停止函数，不叠加第二个计时器；
 * 停止之后可以重新初始化。
 */
export function initPerformanceTimelineCleanup(
  options: PerformanceTimelineCleanupOptions = {},
): () => void {
  if (activeDispose !== null) return activeDispose;
  const env = options.env ?? readEnv();
  const isHarnessActive = options.isPerfHarnessActive ?? defaultIsPerfHarnessActive;
  const api = options.performanceApi ?? defaultPerformanceApi();
  if (!env.dev || env.preserveTimeline || isHarnessActive()) return noopDispose;
  if (api === undefined || typeof api.clearMarks !== "function" || typeof api.clearMeasures !== "function") {
    return noopDispose;
  }
  const timer = setInterval(() => {
    // harness 入口在模块末尾才挂 window.ompPerf，可能晚于清理器启动；每个 tick 复查，
    // 宁可少清一次也不能清掉测量现场。
    if (isHarnessActive()) return;
    api.clearMarks?.();
    api.clearMeasures?.();
  }, PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    activeDispose = null;
    clearInterval(timer);
  };
  activeDispose = dispose;
  return dispose;
}

export function __resetPerformanceTimelineCleanupForTests(): void {
  activeDispose?.();
  activeDispose = null;
}
