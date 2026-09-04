/**
 * 进程内存采样面板（Diagnostics 页）。
 *
 * 存在的理由：这个应用曾经在长对话里涨到 3GB 都没人拦，因为全仓一处内存埋点都没有 ——
 * 排查时连「涨的是渲染进程、主进程还是 runtime 子进程」都答不出来。这里把
 * `app.getAppMetrics()` 的工作集列出来，先解决归因问题。
 *
 * 数据来自 desktop chrome 面（不是 Host / Studio Bridge），只有 Electron 环境有；
 * Web 预览下 `sampleProcessMemory` 缺失，面板整体不渲染。
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface ProcessMemoryRow {
  readonly kind: string;
  readonly ordinal: number;
  readonly workingSetKb: number;
  readonly peakWorkingSetKb?: number;
}

export interface ProcessMemorySample {
  readonly capturedAt: string;
  readonly totalWorkingSetKb: number;
  readonly rows: readonly ProcessMemoryRow[];
}

/** 自动刷新间隔。够慢到不干扰主线程，够快到能看出趋势。 */
const SAMPLE_INTERVAL_MS = 5_000;

export function formatWorkingSet(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(2)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

/**
 * 进程类型到人话的映射。Electron 的 `Browser` 就是主进程，`Tab` 是渲染进程；
 * runtime 是我们自己 spawn 的 Node 子进程，不在 `getAppMetrics()` 里 —— 面板上
 * 要说清楚这一点，否则会以为 runtime 不占内存。
 */
export function processLabel(kind: string, ordinal: number, total: number): string {
  const base = kind === "Browser" ? "主进程" : kind === "Tab" ? "渲染进程" : kind === "GPU" ? "GPU" : kind;
  return total > 1 ? `${base} #${ordinal}` : base;
}

export function useProcessMemory(enabled: boolean): {
  readonly sample: ProcessMemorySample | null;
  readonly unsupported: boolean;
  refresh(): void;
} {
  const [sample, setSample] = useState<ProcessMemorySample | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const alive = useRef(true);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    // `app.getAppMetrics()` may be slow under memory pressure. Never let the
    // fixed interval enqueue overlapping Main-process samples indefinitely.
    if (inFlight.current) return;
    const chrome = globalThis.ompStudioChrome;
    if (chrome?.sampleProcessMemory === undefined) {
      setUnsupported(true);
      return;
    }
    inFlight.current = true;
    void chrome
      .sampleProcessMemory()
      .then((next) => {
        if (!alive.current) return;
        if (next === null) setUnsupported(true);
        else setSample(next);
      })
      .catch(() => {
        if (alive.current) setUnsupported(true);
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = window.setInterval(refresh, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  return { sample, unsupported, refresh };
}

export function ProcessMemoryPanel({ enabled }: { enabled: boolean }) {
  const { sample, unsupported } = useProcessMemory(enabled);
  if (unsupported || sample === null) return null;
  const counts = new Map<string, number>();
  for (const row of sample.rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  return (
    <section className="diag-card" aria-labelledby="diagMemoryTitle">
      <div className="diag-card-head">
        <b id="diagMemoryTitle">进程内存</b>
        <span className="muted small">{formatWorkingSet(sample.totalWorkingSetKb)} 合计</span>
      </div>
      <div className="diag-mem-rows">
        {sample.rows.map((row) => (
          <div key={`${row.kind}-${row.ordinal}`} className="diag-mem-row">
            <span className="diag-mem-label">{processLabel(row.kind, row.ordinal, counts.get(row.kind) ?? 1)}</span>
            <span className="diag-mem-value">{formatWorkingSet(row.workingSetKb)}</span>
            {row.peakWorkingSetKb === undefined ? null : (
              <span className="diag-mem-peak muted small">峰值 {formatWorkingSet(row.peakWorkingSetKb)}</span>
            )}
          </div>
        ))}
      </div>
      <p className="muted small">
        每 5 秒刷新。Runtime Worker 是独立 Node 子进程，不在这张表里 —— 长对话下三方都要看。
      </p>
    </section>
  );
}
