import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { ClientBootstrap, HomeReadModel, SessionHistoryReadModel, WorkspaceListReadModel } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "./icons";
import { pagePhaseClass, useDeferredKey } from "./pageTransition";
import { usePreviewMode } from "./preview/PreviewContext";
import { PREVIEW_ACTIVITY, PREVIEW_PROJECTS } from "./preview/fixtures";

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
      <div className={bodyPhase ? `page-body ${pagePhaseClass(bodyPhase)}` : "page-body"} id="pageBody" tabIndex={-1}>
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
type ChartPoint = { readonly x: number; readonly v: number; readonly d?: TokenDay };

const DAY_MS = 86400000;
const TOKEN_CAP = 60000;
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

function fmtTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function intensity(value: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.pow(value / TOKEN_CAP, 0.5));
}

function tokenFill(total: number): string {
  if (total <= 0) return "var(--accent-softer)";
  return TOKEN_STEPS[Math.min(4, Math.ceil(intensity(total) * 5) - 1)] ?? TOKEN_STEPS[0]!;
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
  const slopes = Array.from({ length: count - 1 }, (_, index) => (ys[index + 1]! - ys[index]!) / (xs[index + 1]! - xs[index]!));
  const tangents = new Array<number>(count);
  tangents[0] = slopes[0]!;
  tangents[count - 1] = slopes[count - 2]!;
  for (let index = 1; index < count - 1; index++) {
    tangents[index] = slopes[index - 1]! * slopes[index]! <= 0 ? 0 : (slopes[index - 1]! + slopes[index]!) / 2;
  }
  let path = `M${xs[0]!.toFixed(1)} ${ys[0]!.toFixed(1)}`;
  for (let index = 0; index < count - 1; index++) {
    const dx = xs[index + 1]! - xs[index]!;
    path += `C${(xs[index]! + dx / 3).toFixed(1)} ${(ys[index]! + tangents[index]! * dx / 3).toFixed(1)} ${(xs[index + 1]! - dx / 3).toFixed(1)} ${(ys[index + 1]! - tangents[index + 1]! * dx / 3).toFixed(1)} ${xs[index + 1]!.toFixed(1)} ${ys[index + 1]!.toFixed(1)}`;
  }
  return path;
}

function TokenUsageCard() {
  const { preview } = usePreviewMode();
  const days = useMemo(() => buildMockTokenUsage(), []);
  const [view, setView] = useState<TokenView>("month");
  const [chartWidth, setChartWidth] = useState(0);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const [cellTip, setCellTip] = useState<{ ts: number } | null>(null);
  const [cellTipPos, setCellTipPos] = useState({ left: 0, top: 0 });
  const cardRef = useRef<HTMLDivElement>(null);
  const calRef = useRef<HTMLDivElement>(null);
  const cellTipRef = useRef<HTMLDivElement>(null);
  const today = startOfDay(Date.now());
  const todayDate = new Date(today);
  const yearStart = new Date(todayDate.getFullYear(), 0, 1).getTime();
  const yearEnd = new Date(todayDate.getFullYear(), 11, 31).getTime();
  const byDay = useMemo(() => {
    const map = new Map<number, TokenDay>();
    for (const day of days) map.set(startOfDay(day.date), day);
    return map;
  }, [days]);

  const padFront = (new Date(yearStart).getDay() + 6) % 7;
  const cells: Array<null | { ts: number }> = [];
  for (let i = 0; i < padFront; i++) cells.push(null);
  for (let ts = yearStart; ts <= yearEnd; ts += DAY_MS) cells.push({ ts });
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = cells.length / 7;
  const monthLabels: Array<{ column: number; label: string }> = [];
  let prevMonth = -1;
  cells.forEach((cell, index) => {
    if (!cell) return;
    const month = new Date(cell.ts).getMonth();
    if (month !== prevMonth) {
      monthLabels.push({ column: Math.floor(index / 7) + 1, label: `${month + 1}月` });
      prevMonth = month;
    }
  });

  const yearDays = useMemo(() => {
    const list: Array<{ ts: number; d: TokenDay | undefined }> = [];
    for (let ts = yearStart; ts <= yearEnd; ts += DAY_MS) list.push({ ts, d: byDay.get(ts) });
    return list;
  }, [byDay, yearEnd, yearStart]);
  const filled = yearDays.filter((entry): entry is { ts: number; d: TokenDay } => entry.d !== undefined).map((entry) => entry.d);
  const yearTotal = filled.reduce((sum, day) => sum + day.total, 0);
  const last7 = filled.filter((day) => startOfDay(day.date) >= today - 6 * DAY_MS && startOfDay(day.date) <= today);
  const avg7 = last7.length ? Math.round(last7.reduce((sum, day) => sum + day.total, 0) / last7.length) : 0;
  const peak = filled.reduce((best, day) => (day.total > best.total ? day : best), filled[0] ?? { date: today, claude: 0, codex: 0, total: 0 });

  const series = useMemo((): ChartPoint[] => {
    if (view === "year") {
      const points: ChartPoint[] = [];
      for (let week = 0; week < weeks; week++) {
        let max = 0;
        let sum = 0;
        let count = 0;
        let lastTs = Number.NEGATIVE_INFINITY;
        for (let dow = 0; dow < 7; dow++) {
          const cell = cells[week * 7 + dow];
          if (cell && cell.ts > lastTs) lastTs = cell.ts;
          const day = cell ? byDay.get(cell.ts) : undefined;
          if (day) {
            max = Math.max(max, day.total);
            sum += day.total;
            count += 1;
          }
        }
        if (lastTs > today) break;
        points.push({ x: week, v: count ? sum / count : 0 });
      }
      return points;
    }
    if (view === "month") {
      const monthStart = startOfDay(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1).getTime());
      return filled
        .filter((day) => startOfDay(day.date) >= monthStart && startOfDay(day.date) <= today)
        .map((day, index) => ({ x: index, v: day.total, d: day }));
    }
    if (view === "week") {
      const weekStart = today - ((todayDate.getDay() + 6) % 7) * DAY_MS;
      return filled
        .filter((day) => startOfDay(day.date) >= weekStart && startOfDay(day.date) <= today)
        .map((day, index) => ({ x: index, v: day.total, d: day }));
    }
    const weekend = todayDate.getDay() === 0 || todayDate.getDay() === 6;
    return Array.from({ length: 24 }, (_, hour) => {
      let value = 200 + ((hour * 17) % 350);
      if (hour >= 9 && hour <= 12) value = 1800 + ((hour * 31) % 1100);
      else if (hour >= 14 && hour <= 18) value = 2200 + ((hour * 41) % 1400);
      else if (hour >= 1 && hour <= 5) value = 0;
      else if (hour === 13 || hour === 19) value = 800;
      return { x: hour, v: weekend ? Math.round(value * 0.45) : value };
    });
  }, [byDay, cells, filled, today, todayDate, view, weeks]);

  const chartMax = Math.max(TOKEN_CAP, ...filled.map((day) => day.total));
  const vbH = 210;
  const padTop = 10;
  const padBottom = 22;
  const yOf = (value: number) => padTop + (1 - Math.min(1, value / chartMax)) * (vbH - padTop - padBottom);
  const xOf = (index: number, count: number) => (index + 0.5) * (chartWidth / Math.max(1, count));

  useEffect(() => {
    const card = cardRef.current;
    if (!card || typeof ResizeObserver === "undefined") return;
    const sync = () => setChartWidth(Math.max(0, card.clientWidth - 28));
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  const plotted = series.map((point) => [xOf(point.x, series.length), yOf(point.v)] as const);
  const line = plotted.length >= 2 ? smoothPath(plotted) : "";
  const area = line && plotted.length >= 2
    ? `${line}L${plotted[plotted.length - 1]![0].toFixed(1)} ${(vbH - padBottom).toFixed(1)}L${plotted[0]![0].toFixed(1)} ${(vbH - padBottom).toFixed(1)}Z`
    : "";
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(chartMax * ratio));
  const xLabels = (() => {
    if (view === "year") return monthLabels.map((month) => ({ x: xOf((month.column - 1), Math.max(1, series.length)), lbl: month.label }));
    if (view === "month") {
      return series
        .filter((point, index) => point.d && (index === 0 || index === series.length - 1 || new Date(point.d.date).getDate() % 5 === 0))
        .map((point) => ({ x: xOf(point.x, series.length), lbl: `${new Date(point.d!.date).getDate()}日` }));
    }
    if (view === "week") {
      return series.map((point) => {
        const dow = point.d ? new Date(point.d.date).getDay() : 0;
        return { x: xOf(point.x, series.length), lbl: ["一", "二", "三", "四", "五", "六", "日"][dow === 0 ? 6 : dow - 1]! };
      });
    }
    return [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((hour) => ({ x: xOf(hour, series.length), lbl: `${hour}:00` }));
  })();

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
    setHover({ index: best, x: xOf(point.x, series.length), y: yOf(point.v) });
  };

  const seriesIndexForDay = (ts: number) => {
    if (view === "year") return -1;
    const day = byDay.get(ts);
    if (!day) return -1;
    return series.findIndex((point) => point.d !== undefined && startOfDay(point.d.date) === ts);
  };

  const onCellEnter = (ts: number) => {
    const index = seriesIndexForDay(ts);
    if (index >= 0) {
      const point = series[index];
      if (!point) return;
      setCellTip(null);
      setHover({ index, x: xOf(point.x, series.length), y: yOf(point.v) });
      return;
    }
    setHover(null);
    setCellTip({ ts });
  };

  const onCalLeave = () => {
    setCellTip(null);
    setHover(null);
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
  const hoverLabel = hoverPoint
    ? view === "day"
      ? `${hoverPoint.x}:00`
      : view === "year"
        ? `第 ${hoverPoint.x + 1} 周`
        : hoverPoint.d
          ? dayLabel(hoverPoint.d.date)
          : ""
    : "";

  if (!preview) {
    return (
      <div className="card" style={{ padding: 16, margin: "16px 0" }}>
        <p className="muted small">Token 用量热图仅在预览模式显示。公共 contract 不暴露用量序列。</p>
      </div>
    );
  }

  return (
    <div className="card tk-card" id="tkCard" ref={cardRef}>
      <div className="tk-head">
        <span className="tk-title"><Icon name="pulse" extra="sm" />Token 使用</span>
        <span className="tk-range">演示数据</span>
        <span className="spacer" />
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
        <div className="tk-kpi"><span className="tk-kpi-v mono">{fmtTokens(peak.total)}</span><span className="tk-kpi-l">年内峰值</span></div>
      </div>
      <svg
        className="tk-chart"
        viewBox={`0 0 ${Math.max(chartWidth, 1)} ${vbH}`}
        role="img"
        aria-label={`常用模型 ${TOKEN_VIEWS.find((entry) => entry.id === view)?.label ?? ""} 视图 token 用量折线图`}
        onPointerMove={onChartMove}
        onPointerLeave={() => { setHover(null); setCellTip(null); }}
      >
        {ticks.map((tick) => {
          const y = yOf(tick);
          return (
            <g key={tick}>
              <line className={`tk-grid${tick === 0 ? " base" : ""}`} x1={0} y1={y} x2={chartWidth} y2={y} />
              <text className="tk-yt" x={0} y={y - 3.5}>{tick === 0 ? "0" : fmtTokens(tick)}</text>
            </g>
          );
        })}
        {xLabels.map((label) => (
          <text key={`${label.lbl}-${label.x}`} className="tk-xt" x={label.x} y={vbH - 7}>{label.lbl}</text>
        ))}
        {area ? <path className="tk-area total" d={area} /> : null}
        {line ? <path className="tk-line total" d={line} /> : null}
        {plotted.length === 1 ? <circle className="tk-pt total" cx={plotted[0]![0]} cy={plotted[0]![1]} r={3} /> : null}
        {hover ? (
          <>
            <line className="tk-cursor" x1={hover.x} x2={hover.x} y1={padTop} y2={vbH - padBottom} />
            <circle className="tk-hl" cx={hover.x} cy={hover.y} r={3.6} />
          </>
        ) : null}
        <rect className="tk-hit" x={0} y={0} width={Math.max(chartWidth, 1)} height={vbH} />
      </svg>
      {hoverPoint ? (
        <div className="tk-tip show" style={{ left: Math.max(8, Math.min((cardRef.current?.clientWidth ?? 320) - 158, (hover?.x ?? 0) - 60)), top: 180 }}>
          <b>{hoverLabel}</b>
          <span className="tk-tip-row"><i className="tk-dot total" />{view === "year" ? "周用量" : view === "day" ? "小时用量" : "日用量"}<b className="mono">{fmtTokens(hoverPoint.v)} tok</b></span>
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
          <span className="mono">{fmtTokens(byDay.get(cellTip.ts)?.total ?? 0)} tok</span>
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
            const day = byDay.get(cell.ts);
            const total = day?.total ?? 0;
            const kind = future ? "tk-future" : total > 0 ? "" : "tk-zero";
            const hi = cellTip?.ts === cell.ts || (hoverPoint?.d !== undefined && startOfDay(hoverPoint.d.date) === cell.ts);
            return (
              <span
                key={cell.ts}
                className={`tk-cell${kind ? ` ${kind}` : ""}${isToday ? " tk-today" : ""}${hi ? " tk-hi" : ""}`}
                data-ts={cell.ts}
                tabIndex={0}
                role="img"
                aria-label={future ? `${dayLabel(cell.ts)}（未来）` : `${dayLabel(cell.ts)}，${fmtTokens(total)} tok`}
                style={future ? undefined : { background: tokenFill(total) }}
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
          <span className="tiny muted">颜色按每日总用量分级 · 演示数据</span>
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
  onPickFolder,
  onOpenWorkspace,
  onRoute,
}: {
  runtime?: ClientBootstrap["runtime"];
  snapshot?: OperatorStateSnapshot;
  home?: HomeReadModel;
  history?: SessionHistoryReadModel;
  workspaces?: WorkspaceListReadModel;
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

  return (
    <div className="page-wide">
      <div className="home-hero">
        <h1>{greeting()}，Studio</h1>
        <p className="muted">{preview ? "预览模式 · 演示数据" : statusBits.join(" · ")}</p>
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
          <button className="btn outline" disabled title="克隆仓库不在公共 contract 中"><Icon name="branch" extra="sm" />克隆 Git 仓库</button>
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

      <TokenUsageCard />

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
