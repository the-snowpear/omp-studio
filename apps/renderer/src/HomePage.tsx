import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { ClientBootstrap, ConfigWriteResult, GitOperationResult, HomeReadModel, SessionHistoryReadModel, StudioClient, TokenUsageReadModel, WorkspaceListReadModel } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "./icons";
import { pagePhaseClass, useDeferredKey } from "./pageTransition";
import { usePreviewMode } from "./preview/PreviewContext";
import { PREVIEW_ACTIVITY, PREVIEW_PROJECTS } from "./preview/fixtures";
import { waitForCommandReceipt } from "./sessionLifecycle";

export type PageRoute = "home" | "workbench" | "history" | "agent-hub" | "capabilities" | "model-config" | "settings" | "diagnostics";

const PAGE_NAV: ReadonlyArray<{ id: PageRoute; icon: string; label: string }> = [
  { id: "workbench", icon: "layout", label: "工作台" },
  { id: "home", icon: "home", label: "首页" },
  { id: "history", icon: "history", label: "会话历史" },
  { id: "capabilities", icon: "package", label: "能力中心" },
  { id: "model-config", icon: "server", label: "模型配置" },
  { id: "settings", icon: "settings", label: "设置" },
  { id: "diagnostics", icon: "pulse", label: "诊断中心" },
];

function isAppRoute(id: string): id is Exclude<PageRoute, "agent-hub"> {
  return id === "home" || id === "workbench" || id === "history" || id === "capabilities" || id === "model-config" || id === "settings" || id === "diagnostics";
}

export function SecondaryPage({
  route,
  title,
  titleIcon,
  theme,
  className,
  onRoute,
  onToggleTheme,
  children,
}: {
  route: PageRoute;
  title: string;
  titleIcon?: string;
  theme: "light" | "dark";
  className?: string;
  onRoute: (route: PageRoute) => void;
  onToggleTheme: () => void;
  children: ReactNode;
}) {
  const navRef = useRef<HTMLElement>(null);
  const winRef = useRef<HTMLSpanElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const skipFirstBody = useRef(true);
  const heldChildren = useRef(children);
  const { shown, phase } = useDeferredKey(route);
  if (route === shown) heldChildren.current = children;
  const body = route === shown ? children : heldChildren.current;
  const bodyPhase = skipFirstBody.current ? null : phase;

  useLayoutEffect(() => {
    skipFirstBody.current = false;
  }, []);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const win = winRef.current;
    const mirror = mirrorRef.current;
    if (!nav || !win || !mirror) return;
    const active = nav.querySelector<HTMLElement>(`[data-nav="${route}"]`);
    if (!active) return;
    win.style.left = `${active.offsetLeft}px`;
    win.style.width = `${active.offsetWidth}px`;
    mirror.style.left = `${-active.offsetLeft}px`;
  }, [route]);

  const link = (id: (typeof PAGE_NAV)[number]["id"], extra?: string) => {
    const item = PAGE_NAV.find((entry) => entry.id === id);
    if (!item) return null;
    const wired = isAppRoute(item.id);
    return (
      <a
        key={`${extra ?? ""}-${item.id}`}
        href={`#!${item.id}`}
        data-nav={item.id}
        className={route === item.id ? "active" : undefined}
        aria-disabled={wired ? undefined : true}
        title={wired ? undefined : "尚未接入"}
        tabIndex={extra === "mirror" ? -1 : undefined}
        aria-hidden={extra === "mirror" ? true : undefined}
        onClick={(event) => {
          event.preventDefault();
          if (isAppRoute(item.id)) onRoute(item.id);
        }}
      >
        <Icon name={item.icon} extra="sm" />
        {item.label}
      </a>
    );
  };

  return (
    <div className={className ? `page ${className}` : "page"} id="pageRoot">
      <header className="page-head" id="pageHead">
        <button className="icon-btn" data-tip="返回工作台" aria-label="返回工作台" onClick={() => onRoute("workbench")}>
          <Icon name="arrow-l" />
        </button>
        <span className="ph-title">{titleIcon ? <Icon name={titleIcon} extra="sm" /> : null}{title}</span>
        <nav className={`page-nav${PAGE_NAV.some((item) => item.id === route) ? "" : " no-bubble"}`} ref={navRef} aria-label="二级页导航">
          {PAGE_NAV.map((item) => link(item.id))}
          <span className="nav-window" ref={winRef} aria-hidden="true">
            <span className="nav-mirror" ref={mirrorRef}>{PAGE_NAV.map((item) => link(item.id, "mirror"))}</span>
          </span>
        </nav>
        <span className="spacer" />
        <button className="icon-btn" data-tip="切换 Light / Dark" aria-label="切换主题" onClick={onToggleTheme}>
          <Icon name={theme === "dark" ? "moon" : "light"} />
        </button>
      </header>
      <div
        className={bodyPhase ? `page-body ${pagePhaseClass(bodyPhase)}` : "page-body"}
        id="pageBody"
        tabIndex={-1}
        data-route={shown}
      >
        {body}
      </div>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "夜深了";
  if (hour < 11) return "上午好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d`;
  return new Date(then).toLocaleDateString();
}

function startOfDay(ts: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

type TokenDay = { readonly date: number; readonly claude: number; readonly codex: number; readonly total: number };
type TokenView = "year" | "month" | "week" | "day";
type ChartPoint = {
  readonly x: number;
  readonly byModel: Readonly<Record<string, number>>;
  readonly ts?: number;
  readonly hour?: number;
};

const DAY_MS = 86400000;
const USAGE_POLL_MS = 30_000;
const OTHER_MODEL_ID = "其他";
const TOKEN_VIEWS: ReadonlyArray<{ id: TokenView; label: string }> = [
  { id: "year", label: "年" },
  { id: "month", label: "月" },
  { id: "week", label: "周" },
  { id: "day", label: "日" },
];
const TOKEN_STEPS = [
  "var(--accent-softer)",
  "color-mix(in srgb, var(--accent) 24%, var(--accent-softer))",
  "color-mix(in srgb, var(--accent) 45%, var(--surface-2))",
  "color-mix(in srgb, var(--accent) 68%, var(--surface-2))",
  "var(--accent)",
];

const EMPTY_USAGE: TokenUsageReadModel = {
  generatedAt: "",
  days: [],
  models: [],
  byModel: [],
  hours: [],
};

function localDateKey(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseDateKey(date: string): number {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  if (!year || !month || !day) return Number.NaN;
  return new Date(year, month - 1, day).getTime();
}

function modelTone(models: readonly string[], id: string): string {
  if (id === OTHER_MODEL_ID) return "other";
  const index = models.indexOf(id);
  return `m${Math.max(0, index) % 5}`;
}

/** Preview-only series, ported from ui_reference/ver1 mock-data.js. */
function buildMockTokenUsage(now = Date.now()): TokenDay[] {
  const seedBy = (i: number, salt: number) => {
    const value = Math.sin((i + 1) * 37.719 + salt * 97.31) * 46638.9426;
    return value - Math.floor(value);
  };
  const days: TokenDay[] = [];
  const total = 600;
  for (let i = total - 1; i >= 0; i--) {
    const date = now - i * DAY_MS;
    const dow = new Date(date).getDay();
    const weekend = dow === 0 || dow === 6;
    const friday = dow === 5;
    let trend = 0;
    if (i >= 590) trend = 0;
    else if (i >= 560) trend = ((590 - i) / 30) * 0.45;
    else if (i >= 270) trend = 0.45 + ((560 - i) / 290) * 0.55;
    else trend = 1 + Math.sin((total - 1 - i) / 30) * 0.05;
    if (trend === 0 || seedBy(i, 7) > 0.985) {
      days.push({ date, claude: 0, codex: 0, total: 0 });
      continue;
    }
    const base = weekend ? 9000 : friday ? 30000 : 26000;
    const amount = Math.round(base * trend * (0.78 + seedBy(i, 1) * 0.44));
    const claude = Math.round(amount * (0.55 + seedBy(i, 2) * 0.1));
    days.push({ date, claude, codex: amount - claude, total: amount });
  }
  return days;
}

function buildPreviewUsage(now = Date.now()): TokenUsageReadModel {
  const mock = buildMockTokenUsage(now);
  const days = mock.map((day) => ({ date: localDateKey(day.date), totalTokens: day.total }));
  const byModel = mock.flatMap((day) => {
    const date = localDateKey(day.date);
    const rows: TokenUsageReadModel["byModel"][number][] = [];
    if (day.claude > 0) rows.push({ date, model: "claude", tokens: day.claude });
    if (day.codex > 0) rows.push({ date, model: "codex", tokens: day.codex });
    return rows;
  });
  const weekend = new Date(now).getDay() === 0 || new Date(now).getDay() === 6;
  const hours: TokenUsageReadModel["hours"][number][] = [];
  for (let hour = 0; hour < 24; hour++) {
    let value = 200 + ((hour * 17) % 350);
    if (hour >= 9 && hour <= 12) value = 1800 + ((hour * 31) % 1100);
    else if (hour >= 14 && hour <= 18) value = 2200 + ((hour * 41) % 1400);
    else if (hour >= 1 && hour <= 5) value = 0;
    else if (hour === 13 || hour === 19) value = 800;
    const total = weekend ? Math.round(value * 0.45) : value;
    if (total <= 0) continue;
    const claude = Math.round(total * 0.58);
    hours.push({ hour, model: "claude", tokens: claude });
    hours.push({ hour, model: "codex", tokens: total - claude });
  }
  return {
    generatedAt: new Date(now).toISOString(),
    days,
    models: [{ id: "claude" }, { id: "codex" }],
    byModel,
    hours,
  };
}

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function intensity(value: number, cap: number): number {
  if (value <= 0 || cap <= 0) return 0;
  return Math.min(1, Math.pow(value / cap, 0.5));
}

function tokenFill(total: number, cap: number): string {
  if (total <= 0) return "var(--accent-softer)";
  return TOKEN_STEPS[Math.min(4, Math.ceil(intensity(total, cap) * 5) - 1)] ?? TOKEN_STEPS[0]!;
}

function pointMax(point: ChartPoint): number {
  let max = 0;
  for (const value of Object.values(point.byModel)) max = Math.max(max, value);
  return max;
}

function dayLabel(ts: number): string {
  const date = new Date(ts);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function smoothPath(pts: Array<readonly [number, number]>): string {
  if (pts.length < 2) return "";
  const xs = pts.map((point) => point[0]);
  const ys = pts.map((point) => point[1]);
  const count = pts.length;
  const dxs = Array.from({ length: count - 1 }, (_, index) => xs[index + 1]! - xs[index]!);
  const slopes = dxs.map((dx, index) => (Math.abs(dx) < 1e-6 ? 0 : (ys[index + 1]! - ys[index]!) / dx));
  const tangents = new Array<number>(count);
  tangents[0] = slopes[0]!;
  tangents[count - 1] = slopes[count - 2]!;
  for (let index = 1; index < count - 1; index++) {
    tangents[index] = slopes[index - 1]! * slopes[index]! <= 0 ? 0 : (slopes[index - 1]! + slopes[index]!) / 2;
  }
  // Fritsch–Carlson: keep each cubic inside its two endpoints so a steep
  // neighbor cannot pull a near-zero span below the axis.
  const scale = new Array<number>(count).fill(1);
  for (let index = 0; index < count - 1; index++) {
    const slope = slopes[index]!;
    if (Math.abs(slope) < 1e-8) {
      scale[index] = 0;
      scale[index + 1] = 0;
      continue;
    }
    const alpha = tangents[index]! / slope;
    const beta = tangents[index + 1]! / slope;
    const sum = alpha * alpha + beta * beta;
    if (sum > 9) {
      const tau = 3 / Math.sqrt(sum);
      scale[index] = Math.min(scale[index]!, tau);
      scale[index + 1] = Math.min(scale[index + 1]!, tau);
    }
  }
  for (let index = 0; index < count; index++) tangents[index]! *= scale[index]!;
  let path = `M${xs[0]!.toFixed(1)} ${ys[0]!.toFixed(1)}`;
  for (let index = 0; index < count - 1; index++) {
    const dx = dxs[index]!;
    if (Math.abs(dx) < 1e-6) {
      path += `L${xs[index + 1]!.toFixed(1)} ${ys[index + 1]!.toFixed(1)}`;
      continue;
    }
    const y0 = ys[index]!;
    const y1 = ys[index + 1]!;
    const lo = Math.min(y0, y1);
    const hi = Math.max(y0, y1);
    const c1y = Math.min(hi, Math.max(lo, y0 + tangents[index]! * dx / 3));
    const c2y = Math.min(hi, Math.max(lo, y1 - tangents[index + 1]! * dx / 3));
    path += `C${(xs[index]! + dx / 3).toFixed(1)} ${c1y.toFixed(1)} ${(xs[index + 1]! - dx / 3).toFixed(1)} ${c2y.toFixed(1)} ${xs[index + 1]!.toFixed(1)} ${y1.toFixed(1)}`;
  }
  return path;
}

function waitReceipt<T>(client: StudioClient, requestId: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const unsub = client.subscribe({ scope: "command", requestId: requestId as never }, (event) => {
      if (event.kind !== "command.receipt" || event.receipt.requestId !== requestId) return;
      unsub();
      if (event.receipt.status === "completed") resolve(event.receipt.result as T);
      else if (event.receipt.status === "failed") reject(new Error(event.receipt.error?.message ?? "命令失败"));
      else reject(new Error(`命令未完成：${event.receipt.status}`));
    });
  });
}

function TokenUsageCard({ client }: { client?: StudioClient }) {
  const { preview } = usePreviewMode();
  const previewUsage = useMemo(() => buildPreviewUsage(), []);
  const [liveUsage, setLiveUsage] = useState<TokenUsageReadModel | null>(null);
  const [view, setView] = useState<TokenView>("month");
  const [chartWidth, setChartWidth] = useState(0);
  const [hover, setHover] = useState<{ index: number; x: number; y: number; source: "chart" | "cell" } | null>(null);
  const [cellTip, setCellTip] = useState<{ ts: number } | null>(null);
  const [cellTipPos, setCellTipPos] = useState({ left: 0, top: 0 });
  const [dash, setDash] = useState<{ phase: "idle" | "opening" | "opened" | "error"; message?: string }>({ phase: "idle" });
  const dashTimer = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const calRef = useRef<HTMLDivElement>(null);
  const cellTipRef = useRef<HTMLDivElement>(null);
  const today = startOfDay(Date.now());
  const todayDate = new Date(today);
  const yearStart = new Date(todayDate.getFullYear(), 0, 1).getTime();
  const yearEnd = new Date(todayDate.getFullYear(), 11, 31).getTime();

  useEffect(() => {
    if (preview || !client) {
      setLiveUsage(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await client.query("usage.get", {});
        if (!cancelled) setLiveUsage(next);
      } catch {
        if (!cancelled) {
          setLiveUsage({
            ...EMPTY_USAGE,
            generatedAt: new Date().toISOString(),
            unavailableReason: "用量读取失败。",
          });
        }
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, USAGE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [preview, client]);

  useEffect(() => () => window.clearTimeout(dashTimer.current), []);

  const usage = preview ? previewUsage : (liveUsage ?? EMPTY_USAGE);
  const loading = !preview && liveUsage === null;
  const modelIds = useMemo(() => usage.models.map((entry) => entry.id), [usage]);
  const totalsByDay = useMemo(() => {
    const map = new Map<number, number>();
    for (const day of usage.days) {
      const ts = parseDateKey(day.date);
      if (!Number.isFinite(ts)) continue;
      map.set(ts, day.totalTokens);
    }
    return map;
  }, [usage]);
  const tokensByModelDay = useMemo(() => {
    const map = new Map<string, Map<number, number>>();
    for (const row of usage.byModel) {
      const ts = parseDateKey(row.date);
      if (!Number.isFinite(ts)) continue;
      let inner = map.get(row.model);
      if (!inner) {
        inner = new Map();
        map.set(row.model, inner);
      }
      inner.set(ts, (inner.get(ts) ?? 0) + row.tokens);
    }
    return map;
  }, [usage]);
  const tokensByModelHour = useMemo(() => {
    const map = new Map<string, Map<number, number>>();
    for (const row of usage.hours) {
      let inner = map.get(row.model);
      if (!inner) {
        inner = new Map();
        map.set(row.model, inner);
      }
      inner.set(row.hour, (inner.get(row.hour) ?? 0) + row.tokens);
    }
    return map;
  }, [usage]);

  const calendar = useMemo(() => {
    const padFront = (new Date(yearStart).getDay() + 6) % 7;
    const nextCells: Array<null | { ts: number }> = [];
    for (let i = 0; i < padFront; i++) nextCells.push(null);
    for (let ts = yearStart; ts <= yearEnd; ts += DAY_MS) nextCells.push({ ts });
    while (nextCells.length % 7 !== 0) nextCells.push(null);
    const nextWeeks = nextCells.length / 7;
    const nextMonths: Array<{ column: number; label: string }> = [];
    let prevMonth = -1;
    nextCells.forEach((cell, index) => {
      if (!cell) return;
      const month = new Date(cell.ts).getMonth();
      if (month !== prevMonth) {
        nextMonths.push({ column: Math.floor(index / 7) + 1, label: `${month + 1}月` });
        prevMonth = month;
      }
    });
    return { cells: nextCells, weeks: nextWeeks, monthLabels: nextMonths };
  }, [yearEnd, yearStart]);
  const { cells, weeks, monthLabels } = calendar;

  const yearTotals: number[] = [];
  for (let ts = yearStart; ts <= today && ts <= yearEnd; ts += DAY_MS) {
    yearTotals.push(totalsByDay.get(ts) ?? 0);
  }
  const yearTotal = yearTotals.reduce((sum, value) => sum + value, 0);
  const last7 = yearTotals.slice(-7);
  const avg7 = last7.length ? Math.round(last7.reduce((sum, value) => sum + value, 0) / last7.length) : 0;
  const peakTotal = yearTotals.reduce((best, value) => Math.max(best, value), 0);
  const heatCap = Math.max(peakTotal, 1);

  const series = useMemo((): ChartPoint[] => {
    const zero = (): Record<string, number> => {
      const rec: Record<string, number> = {};
      for (const id of modelIds) rec[id] = 0;
      return rec;
    };
    if (view === "year") {
      const points: ChartPoint[] = [];
      for (let week = 0; week < weeks; week++) {
        const sums = zero();
        let count = 0;
        let lastTs = Number.NEGATIVE_INFINITY;
        for (let dow = 0; dow < 7; dow++) {
          const cell = cells[week * 7 + dow];
          if (!cell || cell.ts > today) continue;
          if (cell.ts > lastTs) lastTs = cell.ts;
          count += 1;
          for (const id of modelIds) {
            sums[id] = (sums[id] ?? 0) + (tokensByModelDay.get(id)?.get(cell.ts) ?? 0);
          }
        }
        if (lastTs === Number.NEGATIVE_INFINITY) break;
        const byModel = zero();
        for (const id of modelIds) byModel[id] = count ? (sums[id] ?? 0) / count : 0;
        points.push({ x: week, byModel, ts: lastTs });
      }
      return points;
    }
    if (view === "month" || view === "week") {
      const rangeStart = view === "month"
        ? startOfDay(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1).getTime())
        : today - ((todayDate.getDay() + 6) % 7) * DAY_MS;
      const points: ChartPoint[] = [];
      let index = 0;
      for (let ts = rangeStart; ts <= today; ts += DAY_MS) {
        const byModel = zero();
        for (const id of modelIds) byModel[id] = tokensByModelDay.get(id)?.get(ts) ?? 0;
        points.push({ x: index, byModel, ts });
        index += 1;
      }
      return points;
    }
    return Array.from({ length: 24 }, (_, hour) => {
      const byModel = zero();
      for (const id of modelIds) byModel[id] = tokensByModelHour.get(id)?.get(hour) ?? 0;
      return { x: hour, byModel, hour };
    });
  }, [cells, modelIds, today, todayDate, tokensByModelDay, tokensByModelHour, view, weeks]);

  const chartMax = Math.max(1, ...series.map((point) => pointMax(point)));
  const vbH = 210;
  const padTop = 10;
  const padBottom = 22;
  const yOf = (value: number) => padTop + (1 - Math.min(1, value / chartMax)) * (vbH - padTop - padBottom);
  const xOf = (index: number, count: number) => (index + 0.5) * (chartWidth / Math.max(1, count));

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const sync = () => {
      const width = Math.max(0, Math.round(svg.getBoundingClientRect().width));
      setChartWidth((prev) => (Math.abs(prev - width) < 1 ? prev : width));
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [loading, preview, usage.generatedAt]);

  const modelPaths = chartWidth >= 8
    ? modelIds.map((id) => {
      const pts = series.map((point) => [xOf(point.x, series.length), yOf(point.byModel[id] ?? 0)] as const);
      return { id, pts, path: pts.length >= 2 ? smoothPath(pts) : "" };
    })
    : [];
  const ticks = [...new Set([0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(chartMax * ratio)))];
  const xLabels = (() => {
    if (view === "year") return monthLabels.map((month) => ({ x: xOf((month.column - 1), Math.max(1, series.length)), lbl: month.label }));
    if (view === "month") {
      return series
        .filter((point, index) => point.ts !== undefined && (index === 0 || index === series.length - 1 || new Date(point.ts).getDate() % 5 === 0))
        .map((point) => ({ x: xOf(point.x, series.length), lbl: `${new Date(point.ts!).getDate()}日` }));
    }
    if (view === "week") {
      return series.map((point) => {
        const dow = point.ts ? new Date(point.ts).getDay() : 0;
        return { x: xOf(point.x, series.length), lbl: ["一", "二", "三", "四", "五", "六", "日"][dow === 0 ? 6 : dow - 1]! };
      });
    }
    return [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((hour) => ({ x: xOf(hour, series.length), lbl: `${hour}:00` }));
  })();

  const seriesIndexForDay = (ts: number) => {
    if (view === "day") return ts === today ? Math.max(0, series.length - 1) : -1;
    if (view === "year") {
      const cellIndex = cells.findIndex((cell) => cell?.ts === ts);
      if (cellIndex < 0) return -1;
      const week = Math.floor(cellIndex / 7);
      return series.findIndex((point) => point.x === week);
    }
    return series.findIndex((point) => point.ts === ts);
  };

  const daysFromChartPoint = (point: ChartPoint): number[] => {
    if (view === "day") return [today];
    if (view === "year") {
      const days: number[] = [];
      for (let dow = 0; dow < 7; dow++) {
        const cell = cells[point.x * 7 + dow];
        if (cell) days.push(cell.ts);
      }
      return days;
    }
    return point.ts !== undefined ? [point.ts] : [];
  };

  const onChartMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!series.length || !chartWidth) return;
    setCellTip(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const vx = (event.clientX - rect.left) * (chartWidth / rect.width);
    let best = 0;
    let distance = Number.POSITIVE_INFINITY;
    series.forEach((point, index) => {
      const next = Math.abs(xOf(point.x, series.length) - vx);
      if (next < distance) {
        distance = next;
        best = index;
      }
    });
    const point = series[best];
    if (!point) return;
    setHover({ index: best, x: xOf(point.x, series.length), y: yOf(pointMax(point)), source: "chart" });
  };

  const onCellEnter = (ts: number) => {
    setCellTip({ ts });
    const index = seriesIndexForDay(ts);
    const point = index >= 0 ? series[index] : undefined;
    if (!point) {
      setHover(null);
      return;
    }
    setHover({ index, x: xOf(point.x, series.length), y: yOf(pointMax(point)), source: "cell" });
  };

  const onCalLeave = () => {
    setCellTip(null);
    setHover((prev) => (prev?.source === "cell" ? null : prev));
  };

  useLayoutEffect(() => {
    if (!cellTip || !cellTipRef.current || !cardRef.current || !calRef.current) return;
    const cell = calRef.current.querySelector<HTMLElement>(`.tk-cell[data-ts="${cellTip.ts}"]`);
    if (!cell) return;
    const cr = cell.getBoundingClientRect();
    const cardRect = cardRef.current.getBoundingClientRect();
    const tip = cellTipRef.current;
    tip.style.display = "block";
    const tw = tip.offsetWidth || 110;
    const th = tip.offsetHeight || 30;
    const left = Math.max(2, Math.min(cardRef.current.clientWidth - tw - 2, cr.left - cardRect.left + cr.width / 2 - tw / 2));
    const relTop = cr.top - cardRect.top;
    const top = relTop - th - 6 >= 0 ? relTop - th - 6 : relTop + cr.height + 6;
    if (cellTipPos.left !== left || cellTipPos.top !== top) setCellTipPos({ left, top });
  }, [cellTip, cellTipPos.left, cellTipPos.top]);

  const hoverPoint = hover ? series[hover.index] : undefined;
  const chartHighlightDays = hover?.source === "chart" && hoverPoint
    ? new Set(daysFromChartPoint(hoverPoint))
    : null;
  const hoverLabel = hoverPoint
    ? view === "day"
      ? `${hoverPoint.hour ?? hoverPoint.x}:00`
      : view === "year"
        ? `第 ${hoverPoint.x + 1} 周`
        : hoverPoint.ts
          ? dayLabel(hoverPoint.ts)
          : ""
    : "";
  const rangeText = preview
    ? "演示数据"
    : loading
      ? "正在同步用量…"
      : usage.unavailableReason ?? "本机用量";

  const dashLabel =
    dash.phase === "opening" ? "正在打开…" : dash.phase === "opened" ? "已打开" : dash.phase === "error" ? "打开失败" : "OMP Stats";
  const dashTitle = preview
    ? "预览模式不打开原生 Stats"
    : dash.phase === "error"
      ? (dash.message ?? "打开 OMP Stats 失败")
      : dash.phase === "opening"
        ? "正在打开 OMP Stats…"
        : dash.phase === "opened"
          ? (dash.message ?? "已打开 OMP Stats")
          : "在默认浏览器打开 OMP Stats";

  return (
    <div className="card tk-card" id="tkCard" ref={cardRef}>
      <div className="tk-head">
        <span className="tk-title"><Icon name="pulse" extra="sm" />Token 使用</span>
        <span className="tk-range">{rangeText}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn outline small"
          disabled={preview || !client || dash.phase === "opening"}
          aria-busy={dash.phase === "opening"}
          title={dashTitle}
          onClick={() => {
            if (preview || !client || dash.phase === "opening") return;
            window.clearTimeout(dashTimer.current);
            setDash({ phase: "opening" });
            void (async () => {
              try {
                const handle = await client.command("usage.openDashboard", {});
                const receipt = await waitReceipt<ConfigWriteResult>(client, handle.requestId);
                setDash({ phase: "opened", message: receipt.message ?? "已打开 OMP Stats" });
                dashTimer.current = window.setTimeout(() => {
                  setDash((prev) => (prev.phase === "opened" ? { phase: "idle" } : prev));
                }, 2500);
              } catch (error) {
                const message = error instanceof Error ? error.message : "打开 OMP Stats 失败";
                setDash({ phase: "error", message });
              }
            })();
          }}
        >
          <Icon name="external" extra="sm" />{dashLabel}
        </button>
        <div className="seg tk-views" role="group" aria-label="Token 视图切换">
          {TOKEN_VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              data-view={entry.id}
              className={view === entry.id ? "active" : undefined}
              aria-pressed={view === entry.id}
              onClick={() => { setView(entry.id); setHover(null); setCellTip(null); }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <div className="tk-kpis">
        <div className="tk-kpi"><span className="tk-kpi-v mono">{fmtTokens(yearTotal)}</span><span className="tk-kpi-l"><i className="tk-dot total" />年内总用量</span></div>
        <div className="tk-kpi"><span className="tk-kpi-v mono">{fmtTokens(avg7)}</span><span className="tk-kpi-l">近 7 天日均</span></div>
        <div className="tk-kpi"><span className="tk-kpi-v mono">{fmtTokens(peakTotal)}</span><span className="tk-kpi-l">年内峰值</span></div>
      </div>
      {modelIds.length > 0 ? (
        <div className="tk-legend">
          {modelIds.map((id) => (
            <span key={id}><i className={`tk-dot ${modelTone(modelIds, id)}`} />{id}</span>
          ))}
        </div>
      ) : null}
      <svg
        ref={svgRef}
        className="tk-chart"
        viewBox={`0 0 ${Math.max(chartWidth, 1)} ${vbH}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`常用模型 ${TOKEN_VIEWS.find((entry) => entry.id === view)?.label ?? ""} 视图 token 用量折线图`}
        onPointerMove={onChartMove}
        onPointerLeave={() => { setHover((prev) => (prev?.source === "chart" ? null : prev)); }}
      >
        {ticks.map((tick, index) => {
          const y = yOf(tick);
          return (
            <g key={`y-${index}`}>
              <line className={`tk-grid${tick === 0 ? " base" : ""}`} x1={0} y1={y} x2={chartWidth} y2={y} />
              <text className="tk-yt" x={0} y={y - 3.5}>{tick === 0 ? "0" : fmtTokens(tick)}</text>
            </g>
          );
        })}
        {xLabels.map((label, index) => (
          <text key={`x-${index}`} className="tk-xt" x={label.x} y={vbH - 7}>{label.lbl}</text>
        ))}
        {modelPaths.map((entry) => {
          const tone = modelTone(modelIds, entry.id);
          return (
            <g key={entry.id}>
              {entry.path ? <path className={`tk-line ${tone}`} d={entry.path} /> : null}
              {entry.pts.length === 1 ? <circle className={`tk-pt ${tone}`} cx={entry.pts[0]![0]} cy={entry.pts[0]![1]} r={3} /> : null}
            </g>
          );
        })}
        {hover && hoverPoint ? (
          <>
            <line className="tk-cursor" x1={hover.x} x2={hover.x} y1={padTop} y2={vbH - padBottom} />
            {modelIds.map((id) => (
              <circle
                key={id}
                className={`tk-hl ${modelTone(modelIds, id)}`}
                cx={hover.x}
                cy={yOf(hoverPoint.byModel[id] ?? 0)}
                r={3.6}
              />
            ))}
          </>
        ) : null}
        <rect className="tk-hit" x={0} y={0} width={Math.max(chartWidth, 1)} height={vbH} />
      </svg>
      {hover?.source === "chart" && hoverPoint ? (
        <div className="tk-tip show" style={{ left: Math.max(8, Math.min((cardRef.current?.clientWidth ?? 320) - 168, (hover?.x ?? 0) - 60)), top: 180 }}>
          <b>{hoverLabel}</b>
          {modelIds.map((id) => (
            <span key={id} className="tk-tip-row">
              <i className={`tk-dot ${modelTone(modelIds, id)}`} />
              {id}
              <b className="mono">{fmtTokens(hoverPoint.byModel[id] ?? 0)} tok</b>
            </span>
          ))}
        </div>
      ) : null}
      {cellTip ? (
        <div
          ref={cellTipRef}
          className="tk-cell-tip show"
          role="status"
          aria-hidden="false"
          style={{ display: "block", left: cellTipPos.left, top: cellTipPos.top }}
        >
          <b>{dayLabel(cellTip.ts)}{cellTip.ts > today ? "（未来）" : ""}</b>
          <span className="mono">{fmtTokens(totalsByDay.get(cellTip.ts) ?? 0)} tok</span>
        </div>
      ) : null}
      <div className="tk-cal-wrap">
        <div
          className="tk-cal"
          ref={calRef}
          style={{ ["--weeks" as string]: weeks }}
          onMouseLeave={onCalLeave}
        >
          {cells.map((cell, index) => {
            if (!cell) return <span key={`pad-${index}`} className="tk-cell tk-empty" />;
            const future = cell.ts > today;
            const isToday = cell.ts === today;
            const total = totalsByDay.get(cell.ts) ?? 0;
            const kind = future ? "tk-future" : total > 0 ? "" : "tk-zero";
            const hi = cellTip?.ts === cell.ts || (chartHighlightDays?.has(cell.ts) ?? false);
            return (
              <span
                key={cell.ts}
                className={`tk-cell${kind ? ` ${kind}` : ""}${isToday ? " tk-today" : ""}${hi ? " tk-hi" : ""}`}
                data-ts={cell.ts}
                tabIndex={0}
                role="img"
                aria-label={future ? `${dayLabel(cell.ts)}（未来）` : `${dayLabel(cell.ts)}，${fmtTokens(total)} tok`}
                style={future ? undefined : { background: tokenFill(total, heatCap) }}
                onMouseEnter={() => onCellEnter(cell.ts)}
                onFocus={() => onCellEnter(cell.ts)}
              />
            );
          })}
        </div>
        <div className="tk-cal-months" style={{ ["--weeks" as string]: weeks }}>
          {monthLabels.map((month) => (
            <span key={month.label} style={{ gridColumn: month.column }}>{month.label}</span>
          ))}
        </div>
        <div className="tk-cal-foot">
          <span className="tiny muted">{preview ? "颜色按每日总用量分级 · 演示数据" : "颜色按每日总用量分级"}</span>
          <span className="spacer" />
          <span className="tk-scale" aria-hidden="true">少
            <i data-s="0" /><i data-s="1" /><i data-s="2" /><i data-s="3" /><i data-s="4" /><i className="tk-scale-max">多</i>
          </span>
        </div>
      </div>
    </div>
  );
}

export function HomePage({
  runtime,
  snapshot,
  home,
  history,
  workspaces,
  client,
  onPickFolder,
  onOpenWorkspace,
  onRoute,
}: {
  runtime?: ClientBootstrap["runtime"];
  snapshot?: OperatorStateSnapshot;
  home?: HomeReadModel;
  history?: SessionHistoryReadModel;
  workspaces?: WorkspaceListReadModel;
  client?: StudioClient;
  onPickFolder?: () => void;
  onOpenWorkspace?: (workspaceId: string) => void;
  onRoute: (route: PageRoute) => void;
}) {
  const waiting = snapshot?.agents.filter((agent) => agent.status === "idle" || agent.status === "parked").length ?? 0;
  const statusBits: string[] = [];
  if (snapshot?.isStreaming) statusBits.push("任务正在运行");
  if (waiting > 0) statusBits.push(`${waiting} 个 Agent 空闲`);
  if (runtime?.status === "connected") statusBits.push(`Runtime ${runtime.classification ?? "connected"}`);
  else statusBits.push(runtime?.status ? `Runtime ${runtime.status}` : "Runtime 不可用");

  const { preview } = usePreviewMode();
  const activities = (history?.entries ?? []).slice(0, 5);
  const [installing, setInstalling] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [installMessage, setInstallMessage] = useState<string | undefined>(undefined);
  const runtimeMissing = !preview && runtime?.status !== "connected";

  return (
    <div className="page-wide">
      <div className="home-hero">
        <h1>{greeting()}，Studio</h1>
        <p className="muted">{preview ? "预览模式 · 演示数据" : statusBits.join(" · ")}</p>
        {installMessage ? <p className="muted small">{installMessage}</p> : null}
        <div className="home-quick">
          <button
            className="btn primary"
            onClick={() => {
              if (preview) {
                onRoute("workbench");
                return;
              }
              onPickFolder?.();
            }}
            title={preview ? "预览模式演示" : "打开本地文件夹（系统选择器）"}
          >
            <Icon name="folder-open" extra="sm" />打开本地文件夹
          </button>
          {runtimeMissing && client ? (
            <button
              className="btn outline"
              disabled={installing}
              title="从本地签名制品安装托管 Runtime"
              onClick={() => {
                void (async () => {
                  setInstalling(true);
                  setInstallMessage(undefined);
                  try {
                    const handle = await client.command("runtime.install", {});
                    const receipt = await waitForCommandReceipt(client, handle.requestId);
                    if (receipt.status === "completed") {
                      setInstallMessage("托管 Runtime 已安装。打开项目后即可启动。");
                    } else if (receipt.status === "failed") {
                      setInstallMessage(receipt.error.message);
                    } else {
                      setInstallMessage("安装未完成");
                    }
                  } catch (error) {
                    setInstallMessage(error instanceof Error ? error.message : "安装失败");
                  } finally {
                    setInstalling(false);
                  }
                })();
              }}
            >
              <Icon name="package" extra="sm" />{installing ? "正在安装…" : "安装 Runtime"}
            </button>
          ) : null}
          <button
            className="btn outline"
            disabled={preview || !client || cloning}
            title={preview ? "预览模式不执行 Git 操作" : "使用系统 Git 克隆，并通过系统选择器选择父目录"}
            onClick={() => {
              const url = window.prompt("Git 仓库 URL")?.trim();
              if (!url || !client) return;
              const directoryName = window.prompt("目录名（可留空使用仓库名）")?.trim();
              void (async () => {
                setCloning(true);
                setInstallMessage(undefined);
                try {
                  const handle = await client.command("git.execute", { operation: { kind: "clone", url, ...(directoryName ? { directoryName } : {}) } });
                  const receipt = await waitForCommandReceipt(client, handle.requestId);
                  if (receipt.status === "completed") {
                    const result = receipt.result as GitOperationResult;
                    setInstallMessage(result.message);
                    if (result.createdWorkspaceId !== undefined) {
                      onOpenWorkspace?.(result.createdWorkspaceId);
                      onRoute("workbench");
                    }
                  } else if (receipt.status === "failed") {
                    setInstallMessage(receipt.error.message);
                  } else {
                    setInstallMessage(receipt.reason);
                  }
                } catch (error) {
                  setInstallMessage(error instanceof Error ? error.message : "克隆失败");
                } finally {
                  setCloning(false);
                }
              })();
            }}
          ><Icon name="branch" extra="sm" />{cloning ? "正在克隆…" : "克隆 Git 仓库"}</button>
          <button className="btn outline" onClick={() => onRoute("history")}><Icon name="history" extra="sm" />恢复最近对话</button>
          <button className="btn outline" disabled title="临时工作区不在公共 contract 中"><Icon name="flask" extra="sm" />创建临时工作区</button>
        </div>
      </div>

      <h3 className="home-h">最近项目</h3>
      <div className="proj-grid" id="projGrid">
        {preview ? PREVIEW_PROJECTS.map((project) => (
          <button key={project.id} className="proj-card" type="button" onClick={() => onRoute("workbench")}>
            <span className="pc-name"><Icon name="folder-open" /><span className="ellipsis">{project.name}</span></span>
            <span className="pc-path ellipsis">{project.path}</span>
            <span className="pc-flags">
              {project.running ? <span className="chip blue">任务运行中</span> : <span className="chip gray">空闲</span>}
              {project.dirty > 0 ? <span className="chip amber">{project.dirty} dirty</span> : null}
            </span>
            <span className="pc-foot">
              <span className="ellipsis">{project.branch} · {project.threads[0]?.title ?? ""}</span>
              <span className="spacer" />
              <span>{project.threads[0]?.time ?? ""}</span>
            </span>
          </button>
        )) : workspaces && workspaces.workspaces.length ? workspaces.workspaces.map((workspace) => (
          <button
            key={workspace.workspaceId}
            className="proj-card"
            type="button"
            onClick={() => {
              onOpenWorkspace?.(workspace.workspaceId);
              onRoute("workbench");
            }}
          >
            <span className="pc-name"><Icon name="folder-open" /><span className="ellipsis">{workspace.name}</span></span>
            {/* Never a path: the Host registry is the only path holder. */}
            <span className="pc-path ellipsis">—</span>
            <span className="pc-flags">
              {workspace.active ? <span className="chip blue">当前项目</span> : <span className="chip gray">空闲</span>}
            </span>
            <span className="pc-foot">
              <span className="ellipsis">{workspace.active ? "已打开 · 最近使用" : "最近使用"}</span>
              <span className="spacer" />
              <span>{relativeTime(workspace.lastOpenedAt)}</span>
            </span>
          </button>
        )) : (
          <div className="empty-inline">暂无最近项目</div>
        )}
      </div>

      <TokenUsageCard {...(client ? { client } : {})} />

      <h3 className="home-h home-h-tight">最近活动</h3>
      <div className="card" style={{ padding: 6 }} id="activityList">
        {preview ? PREVIEW_ACTIVITY.map((entry) => (
          <button key={entry.text} className="activity-row" type="button" onClick={() => onRoute("workbench")}>
            <span className={`a-ic ${entry.color}`} aria-hidden="true"><Icon name={entry.icon} extra="sm" /></span>
            <span className="ellipsis">{entry.text}</span>
            <span className="spacer" />
            <span className="tiny muted">{entry.time}</span>
          </button>
        )) : activities.length ? activities.map((entry) => (
          <button key={entry.historyId} className="activity-row" type="button" onClick={() => onRoute("workbench")}>
            <span className="a-ic purple" aria-hidden="true"><Icon name="message" extra="sm" /></span>
            <span className="ellipsis">会话 · {entry.title}</span>
            <span className="spacer" />
            <span className="tiny muted">{relativeTime(entry.lastActiveAt)}</span>
          </button>
        )) : (
          <div className="empty" style={{ padding: 16 }}>暂无最近活动</div>
        )}
      </div>
    </div>
  );
}
