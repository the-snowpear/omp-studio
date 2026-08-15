/**
 * Homepage token-usage adapter.
 *
 * Syncs via the official `omp stats --summary` CLI (throttled), then reads
 * aggregates from ~/.omp/stats.db. Paths, session files and folders never
 * leave this module. Opening the native dashboard spawns a hidden
 * `omp stats` (not used as the `usage.get` sync mechanism). On Windows the
 * child is not detached — Node's `detached: true` would create a console.
 */

import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import type { ConfigWriteResult, TokenUsageReadModel } from "@omp-studio/client-contract";

import { getStatsDbPath } from "./omp-discovery/paths.js";
import { sanitizeDisplayText } from "./read-models.js";
import type { HostUsageService } from "./services.js";

const execFileAsync = promisify(execFile);

const OTHER_MODEL_ID = "其他";
const TOP_MODEL_COUNT = 5;
const MODEL_ID_MAX = 64;
const SYNC_THROTTLE_MS = 30_000;
const SYNC_TIMEOUT_MS = 60_000;
const YEAR_LOOKBACK_DAYS = 400;

const DASHBOARD_URL = "http://127.0.0.1:3847/";
const DASHBOARD_PROBE_MS = 800;

const OPEN_OK: ConfigWriteResult = {
  applied: true,
  runtimeEffect: "immediate",
  message: "正在打开 OMP Stats 仪表盘。",
};

const OPENED_OK: ConfigWriteResult = {
  applied: true,
  runtimeEffect: "immediate",
  message: "已在浏览器打开 OMP Stats 仪表盘。",
};

export interface OmpUsageAdapterOptions {
  readonly home?: string;
  readonly statsDbPath?: string;
  readonly locateOmp?: () => Promise<string | undefined>;
  readonly exec?: (exe: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
  readonly spawnDashboard?: (exe: string) => void;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly probeDashboard?: () => Promise<boolean>;
  readonly now?: () => number;
  readonly syncThrottleMs?: number;
}

interface ModelDayRow {
  readonly date: string;
  readonly model: string;
  readonly tokens: number;
}

interface HourRow {
  readonly hour: number;
  readonly model: string;
  readonly tokens: number;
}

function emptyModel(generatedAt: string, reason?: string): TokenUsageReadModel {
  return {
    generatedAt,
    days: [],
    models: [],
    byModel: [],
    hours: [],
    ...(reason === undefined ? {} : { unavailableReason: reason }),
  };
}

function isoNow(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function localDate(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(ts: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function labelModel(raw: string): string {
  return sanitizeDisplayText(raw, MODEL_ID_MAX) ?? "unknown";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultLocateOmp(): Promise<string | undefined> {
  const exeName = process.platform === "win32" ? "omp.exe" : "omp";
  const extraDirs = [join(homedir(), ".omp", "bin"), join(homedir(), ".local", "bin")];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extraDirs];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, exeName);
    if (await fileExists(candidate)) return candidate;
  }
  const whereBin =
    process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe") : "which";
  try {
    const { stdout } = await execFileAsync(whereBin, [exeName], { timeout: 8_000, windowsHide: true });
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (first && (await fileExists(first))) return first;
  } catch {
    /* PATH walk already failed */
  }
  return undefined;
}

function defaultSpawnDashboard(exe: string): void {
  const child = spawn(exe, ["stats"], {
    stdio: "ignore",
    windowsHide: true,
    // On Windows, `detached: true` allocates a new console window.
    ...(process.platform === "win32" ? {} : { detached: true }),
  });
  child.unref();
}

async function defaultProbeDashboard(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DASHBOARD_PROBE_MS);
    const response = await fetch("http://127.0.0.1:3847/api/stats/models", {
      method: "GET",
      signal: ac.signal,
    });
    clearTimeout(timer);
    return response.ok && response.headers.get("x-omp-stats-dashboard") !== null;
  } catch {
    return false;
  }
}

function collapseModels(rows: ReadonlyArray<ModelDayRow>, yearStartDate: string): {
  models: string[];
  byModel: ModelDayRow[];
} {
  const yearTotals = new Map<string, number>();
  for (const row of rows) {
    if (row.date < yearStartDate) continue;
    yearTotals.set(row.model, (yearTotals.get(row.model) ?? 0) + row.tokens);
  }
  const ranked = [...yearTotals.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const kept = new Set(ranked.slice(0, TOP_MODEL_COUNT).map(([id]) => id));
  const models = ranked.slice(0, TOP_MODEL_COUNT).map(([id]) => id);
  if (ranked.length > TOP_MODEL_COUNT) models.push(OTHER_MODEL_ID);

  const merged = new Map<string, number>();
  for (const row of rows) {
    const model = kept.has(row.model) ? row.model : OTHER_MODEL_ID;
    const key = `${row.date}\0${model}`;
    merged.set(key, (merged.get(key) ?? 0) + row.tokens);
  }
  const byModel: ModelDayRow[] = [];
  for (const [key, tokens] of merged) {
    const split = key.indexOf("\0");
    byModel.push({ date: key.slice(0, split), model: key.slice(split + 1), tokens });
  }
  byModel.sort((left, right) => left.date.localeCompare(right.date) || left.model.localeCompare(right.model));
  return { models, byModel };
}

function collapseHours(rows: ReadonlyArray<HourRow>, kept: ReadonlySet<string>, includeOther: boolean): HourRow[] {
  const merged = new Map<string, number>();
  for (const row of rows) {
    const model = kept.has(row.model) ? row.model : includeOther ? OTHER_MODEL_ID : row.model;
    if (!kept.has(row.model) && !includeOther) continue;
    const key = `${row.hour}\0${model}`;
    merged.set(key, (merged.get(key) ?? 0) + row.tokens);
  }
  const hours: HourRow[] = [];
  for (const [key, tokens] of merged) {
    const split = key.indexOf("\0");
    hours.push({ hour: Number(key.slice(0, split)), model: key.slice(split + 1), tokens });
  }
  hours.sort((left, right) => left.hour - right.hour || left.model.localeCompare(right.model));
  return hours;
}

async function readUsageDb(dbPath: string, nowMs: number): Promise<TokenUsageReadModel | undefined> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync | undefined;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return undefined;
  }
  if (DatabaseSync === undefined) return undefined;
  if (!(await fileExists(dbPath))) return undefined;

  let db: InstanceType<typeof import("node:sqlite").DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(`file:${dbPath.replaceAll("\\", "/")}?mode=ro`, { readOnly: true });
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
    if (table === undefined) return undefined;

    const cutoff = nowMs - YEAR_LOOKBACK_DAYS * 86_400_000;
    const todayStart = startOfLocalDay(nowMs);
    const yearStartDate = `${new Date(nowMs).getFullYear()}-01-01`;

    const dayRows = db
      .prepare(
        `SELECT timestamp AS timestamp, model AS model, total_tokens AS tokens
         FROM messages
         WHERE timestamp >= ?`,
      )
      .all(cutoff) as Array<{ timestamp: number; model: string; tokens: number }>;

    const byDateTotal = new Map<string, number>();
    const modelDays: ModelDayRow[] = [];
    const hourRows: HourRow[] = [];
    const dayModelAcc = new Map<string, number>();

    for (const row of dayRows) {
      const ts = typeof row.timestamp === "number" ? row.timestamp : Number(row.timestamp);
      const tokens = typeof row.tokens === "number" ? row.tokens : Number(row.tokens);
      if (!Number.isFinite(ts) || !Number.isFinite(tokens) || tokens <= 0) continue;
      const model = labelModel(typeof row.model === "string" ? row.model : "");
      const date = localDate(ts);
      byDateTotal.set(date, (byDateTotal.get(date) ?? 0) + tokens);
      const key = `${date}\0${model}`;
      dayModelAcc.set(key, (dayModelAcc.get(key) ?? 0) + tokens);
      if (ts >= todayStart && ts < todayStart + 86_400_000) {
        hourRows.push({ hour: new Date(ts).getHours(), model, tokens });
      }
    }

    for (const [key, tokens] of dayModelAcc) {
      const split = key.indexOf("\0");
      modelDays.push({ date: key.slice(0, split), model: key.slice(split + 1), tokens });
    }

    const collapsed = collapseModels(modelDays, yearStartDate);
    const kept = new Set(collapsed.models.filter((id) => id !== OTHER_MODEL_ID));
    const hours = collapseHours(hourRows, kept, collapsed.models.includes(OTHER_MODEL_ID));

    const days = [...byDateTotal.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([date, totalTokens]) => ({ date, totalTokens }));

    return {
      generatedAt: isoNow(nowMs),
      days,
      models: collapsed.models.map((id) => ({ id })),
      byModel: collapsed.byModel,
      hours,
    };
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

export function createOmpUsageService(options: OmpUsageAdapterOptions = {}): HostUsageService {
  const home = options.home ?? homedir();
  const statsDbPath = options.statsDbPath ?? getStatsDbPath(home);
  const locateOmp = options.locateOmp ?? defaultLocateOmp;
  const exec =
    options.exec ??
    (async (exe: string, args: string[]) => {
      const result = await execFileAsync(exe, args, { timeout: SYNC_TIMEOUT_MS, windowsHide: true });
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), code: 0 };
    });
  const spawnDashboard = options.spawnDashboard ?? defaultSpawnDashboard;
  const openUrl = options.openUrl;
  const probeDashboard = options.probeDashboard ?? defaultProbeDashboard;
  const now = options.now ?? Date.now;
  const throttleMs = options.syncThrottleMs ?? SYNC_THROTTLE_MS;

  let lastSyncAt = 0;
  let inflight: Promise<void> | undefined;

  async function syncOnce(): Promise<{ readonly ompPath?: string; readonly syncError?: string }> {
    const exe = await locateOmp();
    if (exe === undefined) {
      return { syncError: "未找到 omp。安装 OMP 或将其加入 PATH 后即可同步用量。" };
    }
    const started = now();
    if (inflight) {
      await inflight;
      return { ompPath: exe };
    }
    if (lastSyncAt > 0 && started - lastSyncAt < throttleMs) {
      return { ompPath: exe };
    }
    inflight = (async () => {
      try {
        await exec(exe, ["stats", "--summary"]);
      } catch {
        /* keep going; an existing stats.db may still be readable */
      } finally {
        lastSyncAt = now();
        inflight = undefined;
      }
    })();
    await inflight;
    return { ompPath: exe };
  }

  return {
    async get(): Promise<TokenUsageReadModel> {
      const generatedAt = isoNow(now());
      const sync = await syncOnce();
      const model = await readUsageDb(statsDbPath, now());
      if (model !== undefined) {
        if (sync.syncError !== undefined && model.days.length === 0) {
          return { ...model, unavailableReason: sync.syncError };
        }
        return model;
      }
      if (sync.syncError !== undefined) {
        return emptyModel(generatedAt, sync.syncError);
      }
      if (await fileExists(statsDbPath)) {
        return emptyModel(generatedAt, "无法读取用量库。");
      }
      return emptyModel(generatedAt, "尚未同步到用量数据。可点击「打开 OMP Stats」生成统计库。");
    },

    async openDashboard(): Promise<ConfigWriteResult> {
      const exe = await locateOmp();
      if (exe === undefined) {
        throw { code: "UNAVAILABLE", message: "未找到 omp。安装 OMP 或将其加入 PATH 后再打开 Stats。" };
      }
      try {
        const live = await probeDashboard();
        if (live && openUrl !== undefined) {
          await openUrl(DASHBOARD_URL);
          return OPENED_OK;
        }
        spawnDashboard(exe);
      } catch (error) {
        const message = error instanceof Error ? error.message : "打开 OMP Stats 失败";
        throw { code: "UNAVAILABLE", message };
      }
      return OPEN_OK;
    },
  };
}
