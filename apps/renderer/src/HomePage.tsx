import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { ClientBootstrap, ConfigWriteResult, HomeReadModel, SessionHistoryReadModel, StudioClient, TokenUsageReadModel, WorkspaceListReadModel } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "./icons";
import { pagePhaseClass, useDeferredKey } from "./pageTransition";
import { usePreviewMode } from "./preview/PreviewContext";
import { PREVIEW_ACTIVITY, PREVIEW_PROJECTS } from "./preview/fixtures";
import { waitForCommandReceipt } from "./sessionLifecycle";
import { ActionProgressBar } from "./ActionProgressBar";
import { formatRuntimeDisconnectCopy, formatRuntimeUnavailableCopy } from "./diagnosticsModel";
import {
  DISPLAY_NAME_MAX,
  avatarInitial,
  avatarSrcFromBytes,
  loadAvatarImageFile,
  useOperatorProfile,
  type LoadedAvatarImage,
  type ProcessedAvatar,
} from "./settings/operatorProfile";
import { AvatarCropDialog } from "./settings/AvatarCropDialog";
import {
  DAY_MS,
  EMPTY_USAGE,
  USAGE_POLL_MS,
  buildPreviewUsage,
  fmtTokens,
  intensity,
  parseDateKey,
  startOfDay,
} from "./usage/tokenUsage";
import { useAxisCrossfade, useTokenChartMorph, type TokenChartModelPts } from "./usage/useTokenChartMorph";

import { useI18n } from "./i18n";

export type PageRoute = "home" | "workbench" | "history" | "agent-hub" | "capabilities" | "model-config" | "settings" | "diagnostics";

const PAGE_NAV_DEFS: ReadonlyArray<{ id: PageRoute; icon: string; key: string }> = [
  { id: "workbench", icon: "layout", key: "nav.workbench" },
  { id: "home", icon: "home", key: "nav.home" },
  { id: "history", icon: "history", key: "nav.history" },
  { id: "capabilities", icon: "package", key: "nav.capabilities" },
  { id: "model-config", icon: "server", key: "nav.modelConfig" },
  { id: "settings", icon: "settings", key: "nav.settings" },
  { id: "diagnostics", icon: "pulse", key: "nav.diagnostics" },
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
  const { t } = useI18n();
  const navRef = useRef<HTMLElement>(null);
  const winRef = useRef<HTMLSpanElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const heldChildren = useRef(children);
  const { shown, phase } = useDeferredKey(route);
  if (route === shown) heldChildren.current = children;
  const body = route === shown ? children : heldChildren.current;
  const bodyMotionLive = useRef(false);
  if (!Object.is(route, shown)) bodyMotionLive.current = true;
  const bodyPhase = bodyMotionLive.current ? phase : null;

  useLayoutEffect(() => {
    const nav = navRef.current;
    const win = winRef.current;
    const mirror = mirrorRef.current;
    if (!nav || !win || !mirror) return;

    const sync = () => {
      const active = nav.querySelector<HTMLElement>(`[data-nav="${route}"]`);
      if (!active) return;
      win.style.left = `${active.offsetLeft}px`;
      win.style.width = `${active.offsetWidth}px`;
      mirror.style.left = `${-active.offsetLeft}px`;
    };

    sync();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => sync());
      observer.observe(nav);
      for (const linkEl of nav.querySelectorAll("[data-nav]")) {
        observer.observe(linkEl);
      }
      return () => observer.disconnect();
    }
  }, [route, t]);

  const link = (id: (typeof PAGE_NAV_DEFS)[number]["id"], extra?: string) => {
    const item = PAGE_NAV_DEFS.find((entry) => entry.id === id);
    if (!item) return null;
    const label = t(item.key);
    const wired = isAppRoute(item.id);
    return (
      <a
        key={`${extra ?? ""}-${item.id}`}
        href={`#!${item.id}`}
        data-nav={item.id}
        className={route === item.id ? "active" : undefined}
        aria-disabled={wired ? undefined : true}
        data-tip={wired ? undefined : t("common.notImplemented")}
        tabIndex={extra === "mirror" ? -1 : undefined}
        aria-hidden={extra === "mirror" ? true : undefined}
        onClick={(event) => {
          event.preventDefault();
          if (isAppRoute(item.id)) onRoute(item.id);
        }}
      >
        <Icon name={item.icon} extra="sm" />
        {label}
      </a>
    );
  };

  return (
    <div className={className ? `page ${className}` : "page"} id="pageRoot">
      <header className="page-head" id="pageHead">
        <button className="icon-btn" data-tip={t("nav.workbench")} aria-label={t("nav.workbench")} onClick={() => onRoute("workbench")}>
          <Icon name="arrow-l" />
        </button>
        <span className="ph-title">{titleIcon ? <Icon name={titleIcon} extra="sm" /> : null}{title}</span>
        <nav className={`page-nav${PAGE_NAV_DEFS.some((item) => item.id === route) ? "" : " no-bubble"}`} ref={navRef} aria-label={t("home.secondaryNav")}>
          {PAGE_NAV_DEFS.map((item) => link(item.id))}
          <span className="nav-window" ref={winRef} aria-hidden="true">
            <span className="nav-mirror" ref={mirrorRef}>{PAGE_NAV_DEFS.map((item) => link(item.id, "mirror"))}</span>
          </span>
        </nav>
        <span className="spacer" />
        <button className="icon-btn" data-tip={t("shell.theme")} aria-label={t("shell.toggleTheme")} onClick={onToggleTheme}>
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

function greeting(now: Date, t: (key: string) => string): string {
  const hour = now.getHours();
  if (hour < 5) return t("home.greetingLateNight");
  if (hour < 11) return t("home.greetingMorning");
  if (hour < 13) return t("home.greetingNoon");
  if (hour < 18) return t("home.greetingAfternoon");
  return t("home.greetingEvening");
}

function ProfileAvatar({ name, src, className }: { name: string; src: string; className: string }) {
  if (src) return <img className={className} src={src} alt="" draggable={false} />;
  return <span className={className} aria-hidden="true">{avatarInitial(name)}</span>;
}

function ompStatusText(
  runtime: ClientBootstrap["runtime"] | undefined,
  preview: boolean,
  extras: readonly string[],
  t: (key: string) => string,
): string {
  let head = t("runtime.unavailable");
  if (preview || runtime?.status === "connected") {
    head = t("runtime.ready");
  } else if (runtime?.status === "unavailable" && runtime.unavailableCode !== undefined) {
    head = formatRuntimeUnavailableCopy(runtime.unavailableCode, runtime.unavailableReason).title;
  } else if (runtime?.status === "disconnected") {
    head = runtime.disconnectCode !== undefined
      ? formatRuntimeDisconnectCopy(runtime.disconnectCode, runtime.disconnectReason).title
      : t("runtime.disconnected");
  } else if (runtime?.status === "connecting") {
    head = t("runtime.connecting");
  }
  return extras.length > 0 ? `${head} · ${extras.join(" · ")}` : head;
}

function ProfileEditDialog({
  name,
  avatar,
  onClose,
  onSave,
}: {
  name: string;
  avatar: string;
  onClose: () => void;
  onSave: (next: { displayName: string; avatar: ProcessedAvatar | null | undefined }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [draftName, setDraftName] = useState(name);
  const [draftSrc, setDraftSrc] = useState(avatar);
  const [draftAvatar, setDraftAvatar] = useState<ProcessedAvatar | null | undefined>(undefined);
  const [crop, setCrop] = useState<LoadedAvatarImage | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cropRef = useRef<LoadedAvatarImage | undefined>(undefined);
  cropRef.current = crop;

  useEffect(() => {
    return () => cropRef.current?.close();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      if (crop !== undefined) {
        setCrop((prev) => {
          prev?.close();
          return undefined;
        });
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, crop, onClose]);

  const dismissCrop = () => {
    if (busy) return;
    setCrop((prev) => {
      prev?.close();
      return undefined;
    });
  };

  const onPick = (event: ReactChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(undefined);
    void loadAvatarImageFile(file).then(
      (loaded) => {
        setCrop((prev) => {
          prev?.close();
          return loaded;
        });
        setBusy(false);
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : t("home.avatarReadFailed"));
        setBusy(false);
      },
    );
  };

  return (
    <>
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy && crop === undefined) onClose(); }}>
      <section
        className="modal profile-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profileEditTitle"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head profile-edit-head">
          <div>
            <span className="profile-edit-kicker">PROFILE</span>
            <h2 id="profileEditTitle">{t("home.editProfileHeader")}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={t("common.close")} disabled={busy} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body profile-edit-body">
          <div className="profile-edit-avatar">
            <button
              type="button"
              className="profile-edit-avatar-btn"
              disabled={busy}
              aria-label={t("home.changeAvatar")}
              onClick={() => fileRef.current?.click()}
            >
              <ProfileAvatar name={draftName} src={draftSrc} className="profile-edit-avatar-img" />
              <span className="profile-edit-avatar-overlay" aria-hidden="true">
                <Icon name="camera" extra="sm" />
              </span>
            </button>
            <div className="profile-edit-avatar-copy">
              <b>{t("home.avatar")}</b>
              <span>{t("home.avatarUploadHint")}</span>
              {draftSrc ? (
                <button
                  type="button"
                  className="btn outline small"
                  disabled={busy}
                  onClick={() => { setDraftAvatar(null); setDraftSrc(""); setError(undefined); }}
                >
                  {t("home.removeAvatar")}
                </button>
              ) : null}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
              hidden
              onChange={onPick}
            />
          </div>
          <div className="field">
            <label htmlFor="profileDisplayName">{t("home.displayNameField")}</label>
            <input
              id="profileDisplayName"
              className="input"
              autoFocus
              value={draftName}
              maxLength={DISPLAY_NAME_MAX}
              placeholder="Studio"
              onChange={(event) => setDraftName(event.target.value)}
            />
          </div>
          {error ? <p className="profile-edit-error" role="alert"><Icon name="alert" extra="sm" />{error}</p> : null}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !draftName.trim()}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void onSave({ displayName: draftName, avatar: draftAvatar }).then(
                () => undefined,
                (cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : t("home.saveFailed"));
                  setBusy(false);
                },
              );
            }}
          >
            {busy ? t("home.processing") : t("common.save")}
          </button>
        </div>
      </section>
    </div>
    {crop ? (
      <AvatarCropDialog
        image={crop}
        locked={busy}
        notice={error}
        onConfirm={(avatar) => {
          setDraftAvatar(avatar);
          setDraftSrc(avatarSrcFromBytes(avatar));
          setCrop((prev) => {
            prev?.close();
            return undefined;
          });
          setError(undefined);
        }}
        onRetake={() => {
          fileRef.current?.click();
        }}
        onClose={dismissCrop}
      />
    ) : null}
    </>
  );
}

function relativeTime(iso: string, lang: "zh" | "en", t: (key: string) => string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return t("common.justNow");
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d`;
  return new Date(then).toLocaleDateString(lang === "en" ? "en-US" : "zh-CN");
}

type TokenView = "year" | "month" | "week" | "day";
type ChartPoint = {
  readonly x: number;
  readonly byModel: Readonly<Record<string, number>>;
  readonly ts?: number;
  readonly hour?: number;
};

const OTHER_MODEL_ID = "其他";
const TOKEN_STEPS = [
  "var(--accent-softer)",
  "color-mix(in srgb, var(--accent) 24%, var(--accent-softer))",
  "color-mix(in srgb, var(--accent) 45%, var(--surface-2))",
  "color-mix(in srgb, var(--accent) 68%, var(--surface-2))",
  "var(--accent)",
];

function modelTone(models: readonly string[], id: string): string {
  if (id === OTHER_MODEL_ID) return "other";
  const index = models.indexOf(id);
  return `m${Math.max(0, index) % 5}`;
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

const MONTHS_SHORT_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function dayLabel(ts: number, lang: "zh" | "en" = "zh"): string {
  const date = new Date(ts);
  if (lang === "en") {
    return `${MONTHS_SHORT_EN[date.getMonth()]} ${date.getDate()}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

const CHART_Y_RATIOS = [0, 0.25, 0.5, 0.75, 1] as const;
const EMPTY_CHART_MODELS: readonly TokenChartModelPts[] = [];

function waitReceipt<T>(client: StudioClient, requestId: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const unsub = client.subscribe({ scope: "command", requestId: requestId as never }, (event) => {
      if (event.kind !== "command.receipt" || event.receipt.requestId !== requestId) return;
      unsub();
      if (event.receipt.status === "completed") resolve(event.receipt.result as T);
      else if (event.receipt.status === "failed") reject(new Error(event.receipt.error?.message ?? "Command failed"));
      else reject(new Error(`Command incomplete: ${event.receipt.status}`));
    });
  });
}

function TokenUsageCard({ client }: { client?: StudioClient }) {
  const { t, resolvedLanguage } = useI18n();
  const { preview } = usePreviewMode();
  const previewUsage = useMemo(() => buildPreviewUsage(), []);
  const [liveUsage, setLiveUsage] = useState<TokenUsageReadModel | null>(null);
  const [view, setView] = useState<TokenView>("month");
  const [chartWidth, setChartWidth] = useState(0);
  const tokenViews = useMemo(() => [
    { id: "year" as TokenView, label: t("home.rangeYear") },
    { id: "month" as TokenView, label: t("home.rangeMonth") },
    { id: "week" as TokenView, label: t("home.rangeWeek") },
    { id: "day" as TokenView, label: t("home.rangeDay") },
  ], [t]);
  const modelLabel = (id: string) => (id === OTHER_MODEL_ID ? t("home.other") : id);
  const [hover, setHover] = useState<{ index: number; x: number; y: number; source: "chart" | "cell" } | null>(null);
  const [chartTipPos, setChartTipPos] = useState({ left: 0, top: 0 });
  const [cellTip, setCellTip] = useState<{ ts: number } | null>(null);
  const [cellTipPos, setCellTipPos] = useState({ left: 0, top: 0 });
  const [dash, setDash] = useState<{ phase: "idle" | "opening" | "opened" | "error"; message?: string }>({ phase: "idle" });
  const dashTimer = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const chartTipRef = useRef<HTMLDivElement>(null);
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
            unavailableReason: t("home.usageLoadFailed"),
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
  }, [preview, client, resolvedLanguage, t]);

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
        const label = resolvedLanguage === "en" ? (MONTHS_SHORT_EN[month] ?? `${month + 1}`) : `${month + 1}月`;
        nextMonths.push({ column: Math.floor(index / 7) + 1, label });
        prevMonth = month;
      }
    });
    return { cells: nextCells, weeks: nextWeeks, monthLabels: nextMonths };
  }, [resolvedLanguage, yearEnd, yearStart]);
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
      const date = new Date(today);
      const rangeStart = view === "month"
        ? startOfDay(new Date(date.getFullYear(), date.getMonth(), 1).getTime())
        : today - ((date.getDay() + 6) % 7) * DAY_MS;
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
  }, [cells, modelIds, today, tokensByModelDay, tokensByModelHour, view, weeks]);

  const chartMax = Math.max(1, ...series.map((point) => pointMax(point)));
  const vbH = 210;
  const padTop = 10;
  const padBottom = 22;
  const peakPad = 4;
  const plotH = vbH - padTop - padBottom;
  const yOf = (value: number) => padTop + peakPad + (1 - Math.min(1, value / chartMax)) * (plotH - peakPad);
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

  const yOfRatio = (ratio: number) => padTop + (1 - ratio) * plotH;
  const targetModels = useMemo(() => {
    if (chartWidth < 8) return EMPTY_CHART_MODELS;
    const count = Math.max(1, series.length);
    return modelIds.map((id) => ({
      id,
      pts: series.map((point) => [
        (point.x + 0.5) * (chartWidth / count),
        padTop + peakPad + (1 - Math.min(1, (point.byModel[id] ?? 0) / chartMax)) * (plotH - peakPad),
      ] as const),
    }));
  }, [chartMax, chartWidth, modelIds, plotH, series]);
  const { paths: modelPaths, morphing } = useTokenChartMorph(targetModels, {
    view,
    width: chartWidth,
    padTop,
    plotH,
  });
  const yTicks = CHART_Y_RATIOS.map((ratio) => ({ ratio, value: Math.round(chartMax * ratio) }));
  const xLabels = (() => {
    if (view === "year") return monthLabels.map((month) => ({ x: xOf((month.column - 1), Math.max(1, series.length)), lbl: month.label }));
    if (view === "month") {
      return series
        .filter((point, index) => point.ts !== undefined && (index === 0 || index === series.length - 1 || new Date(point.ts).getDate() % 5 === 0))
        .map((point) => ({ x: xOf(point.x, series.length), lbl: `${new Date(point.ts!).getDate()}${resolvedLanguage === "en" ? "" : "日"}` }));
    }
    if (view === "week") {
      const weekdays = resolvedLanguage === "en"
        ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        : ["一", "二", "三", "四", "五", "六", "日"];
      return series.map((point) => {
        const dow = point.ts ? new Date(point.ts).getDay() : 0;
        return { x: xOf(point.x, series.length), lbl: weekdays[dow === 0 ? 6 : dow - 1]! };
      });
    }
    return [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((hour) => ({ x: xOf(hour, series.length), lbl: `${hour}:00` }));
  })();
  const xFade = useAxisCrossfade(xLabels, view);
  const yFade = useAxisCrossfade(yTicks, view);

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
    if (morphing || !series.length || !chartWidth) return;
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
    if (morphing) {
      setHover(null);
      return;
    }
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
  useLayoutEffect(() => {
    if (hover?.source !== "chart" || !hoverPoint || !chartTipRef.current || !cardRef.current || !svgRef.current) return;
    const card = cardRef.current;
    const svgRect = svgRef.current.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const tip = chartTipRef.current;
    const tipWidth = tip.offsetWidth || 168;
    const tipHeight = tip.offsetHeight || 64;
    const cardWidth = card.clientWidth || cardRect.width;
    const cardHeight = card.clientHeight || cardRect.height;
    const edge = 8;
    const gap = 12;
    const fixedTop = 180;
    const pointX = svgRect.left - cardRect.left + hover.x * (svgRect.width / Math.max(chartWidth, 1));
    const roomRight = cardWidth - edge - pointX;
    const roomLeft = pointX - edge;
    const placeRight = roomRight >= tipWidth + gap || roomRight >= roomLeft;
    const desiredLeft = placeRight ? pointX + gap : pointX - gap - tipWidth;
    const left = Math.max(edge, Math.min(cardWidth - tipWidth - edge, desiredLeft));
    const top = Math.max(edge, Math.min(cardHeight - tipHeight - edge, fixedTop));
    if (chartTipPos.left !== left || chartTipPos.top !== top) setChartTipPos({ left, top });
  }, [chartTipPos.left, chartTipPos.top, chartWidth, hover, hoverPoint, modelIds, resolvedLanguage]);
  const chartHighlightDays = hover?.source === "chart" && hoverPoint
    ? new Set(daysFromChartPoint(hoverPoint))
    : null;
  const hoverLabel = hoverPoint
    ? view === "day"
      ? `${hoverPoint.hour ?? hoverPoint.x}:00`
      : view === "year"
        ? t("home.weekNumber", { n: hoverPoint.x + 1 })
        : hoverPoint.ts
          ? dayLabel(hoverPoint.ts, resolvedLanguage)
          : ""
    : "";
  const rangeText = preview
    ? t("common.demo")
    : loading
      ? t("home.syncingUsage")
      : usage.unavailableReason ?? t("home.localUsage");

  const dashLabel =
    dash.phase === "opening" ? t("home.openingStats") : dash.phase === "opened" ? t("home.openedStats") : dash.phase === "error" ? t("home.openStatsFailed") : t("home.openStats");
  const dashTitle = preview
    ? t("common.preview")
    : dash.phase === "error"
      ? t("common.failed")
      : dash.phase === "opening"
        ? t("home.openingStats")
        : dash.phase === "opened"
          ? t("home.openedStats")
          : "Stats";

  return (
    <div className="card tk-card" id="tkCard" ref={cardRef}>
      <div className="tk-head">
        <span className="tk-title"><Icon name="pulse" extra="sm" />{t("home.tokenUsage")}</span>
        <span className="tk-range">{rangeText}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn outline small"
          disabled={preview || !client || dash.phase === "opening"}
          aria-busy={dash.phase === "opening"}
          data-tip={dashTitle}
          onClick={() => {
            if (preview || !client || dash.phase === "opening") return;
            window.clearTimeout(dashTimer.current);
            setDash({ phase: "opening" });
            void (async () => {
              try {
                const handle = await client.command("usage.openDashboard", {});
                const receipt = await waitReceipt<ConfigWriteResult>(client, handle.requestId);
                setDash({ phase: "opened", message: receipt.message ?? "OMP Stats" });
                dashTimer.current = window.setTimeout(() => {
                  setDash((prev) => (prev.phase === "opened" ? { phase: "idle" } : prev));
                }, 2500);
              } catch (error) {
                const message = error instanceof Error ? error.message : t("home.openStatsFailed");
                setDash({ phase: "error", message });
              }
            })();
          }}
        >
          <Icon name="external" extra="sm" />{dashLabel}
        </button>
        <div className="seg tk-views" role="group" aria-label={t("home.tokenUsage")}>
          {tokenViews.map((entry) => (
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
        <div className="tk-kpi"><span className="tk-kpi-v mono">{fmtTokens(yearTotal)}</span><span className="tk-kpi-l"><i className="tk-dot total" />{t("home.yearTotalUsage")}</span></div>
        <div className="tk-kpi"><span className="tk-kpi-v mono">{fmtTokens(avg7)}</span><span className="tk-kpi-l">{t("home.last7DaysAvg")}</span></div>
        <div className="tk-kpi"><span className="tk-kpi-v mono">{fmtTokens(peakTotal)}</span><span className="tk-kpi-l">{t("home.yearPeak")}</span></div>
      </div>
      {modelIds.length > 0 ? (
        <div className="tk-legend">
          {modelIds.map((id) => (
            <span key={id}><i className={`tk-dot ${modelTone(modelIds, id)}`} />{modelLabel(id)}</span>
          ))}
        </div>
      ) : null}
      <svg
        ref={svgRef}
        className="tk-chart"
        viewBox={`0 0 ${Math.max(chartWidth, 1)} ${vbH}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${t("home.tokenUsage")} ${tokenViews.find((entry) => entry.id === view)?.label ?? ""}`}
        onPointerMove={onChartMove}
        onPointerLeave={() => { setHover((prev) => (prev?.source === "chart" ? null : prev)); }}
      >
        {CHART_Y_RATIOS.map((ratio) => {
          const y = yOfRatio(ratio);
          return <line key={`g-${ratio}`} className={`tk-grid${ratio === 0 ? " base" : ""}`} x1={0} y1={y} x2={chartWidth} y2={y} />;
        })}
        {yFade.outgoing?.map((tick) => (
          <text key={`y-out-${tick.ratio}`} className="tk-yt out" x={0} y={yOfRatio(tick.ratio) - 3.5}>{tick.value === 0 ? "0" : fmtTokens(tick.value)}</text>
        ))}
        {yFade.incoming.map((tick) => (
          <text key={`y-in-${tick.ratio}`} className={yFade.live ? "tk-yt in" : "tk-yt"} x={0} y={yOfRatio(tick.ratio) - 3.5}>{tick.value === 0 ? "0" : fmtTokens(tick.value)}</text>
        ))}
        {xFade.outgoing?.map((label, index) => (
          <text key={`x-out-${index}`} className="tk-xt out" x={label.x} y={vbH - 7}>{label.lbl}</text>
        ))}
        {xFade.incoming.map((label, index) => (
          <text key={`x-in-${index}`} className={xFade.live ? "tk-xt in" : "tk-xt"} x={label.x} y={vbH - 7}>{label.lbl}</text>
        ))}
        <defs>
          <clipPath id="tk-plot-clip">
            <rect x={0} y={0} width={Math.max(chartWidth, 1)} height={padTop + plotH + 3} />
          </clipPath>
        </defs>
        <g clipPath="url(#tk-plot-clip)">
          {modelPaths.map((entry) => {
            const tone = modelTone(modelIds, entry.id);
            return (
              <g key={entry.id}>
                {entry.path ? <path className={`tk-line ${tone}`} d={entry.path} /> : null}
                {!morphing && entry.pts.length === 1 ? <circle className={`tk-pt ${tone}`} cx={entry.pts[0]![0]} cy={entry.pts[0]![1]} r={3} /> : null}
              </g>
            );
          })}
        </g>
        {!morphing && hover && hoverPoint ? (
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
      {!morphing && hover?.source === "chart" && hoverPoint ? (
        <div ref={chartTipRef} className="tk-tip show" style={{ left: chartTipPos.left, top: chartTipPos.top }}>
          <b>{hoverLabel}</b>
          {modelIds.map((id) => (
            <span key={id} className="tk-tip-row">
              <i className={`tk-dot ${modelTone(modelIds, id)}`} />
              {modelLabel(id)}
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
          <b>{dayLabel(cellTip.ts, resolvedLanguage)}{cellTip.ts > today ? ` (${t("home.future")})` : ""}</b>
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
                aria-label={future ? `${dayLabel(cell.ts, resolvedLanguage)} (${t("home.future")})` : `${dayLabel(cell.ts, resolvedLanguage)}, ${fmtTokens(total)} tok`}
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
          <span className="tiny muted">{preview ? t("home.colorByDailyUsageDemo") : t("home.colorByDailyUsage")}</span>
          <span className="spacer" />
          <span className="tk-scale" aria-hidden="true">{t("home.less")}
            <i data-s="0" /><i data-s="1" /><i data-s="2" /><i data-s="3" /><i data-s="4" /><i className="tk-scale-max">{t("home.more")}</i>
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
  const { t, resolvedLanguage } = useI18n();
  const waiting = snapshot?.agents.filter((agent) => agent.status === "idle" || agent.status === "parked").length ?? 0;
  const extraBits: string[] = [];
  if (snapshot?.isStreaming) extraBits.push(t("runtime.taskRunning"));
  if (waiting > 0) extraBits.push(t("runtime.agentsIdle", { count: waiting }));

  const { preview } = usePreviewMode();
  const { profile, update, persistAvatar } = useOperatorProfile();
  const [editingProfile, setEditingProfile] = useState(false);
  const activities = (history?.entries ?? []).slice(0, 5);
  const [installing, setInstalling] = useState(false);
  const [installStep, setInstallStep] = useState(1);
  const [installMessage, setInstallMessage] = useState<string | undefined>(undefined);
  const runtimeMissing = !preview && runtime?.status !== "connected";
  const statusText = ompStatusText(runtime, preview, extraBits, t);

  return (
    <div className="page-wide">
      <div className="home-hero">
        <div className="home-identity">
          <span className="home-avatar-slot">
            <ProfileAvatar name={profile.displayName} src={profile.avatarSrc} className="home-avatar" />
          </span>
          <div className="home-identity-copy">
            <h1>{greeting(new Date(), t)}，{profile.displayName}</h1>
            <p className="muted">{statusText}</p>
          </div>
          <button
            type="button"
            className="icon-btn home-id-edit"
            data-tip={t("home.editProfile")}
            aria-label={t("home.editProfile")}
            onClick={() => setEditingProfile(true)}
          >
            <Icon name="pencil" />
          </button>
        </div>
        {installMessage ? <p className="muted small">{installMessage}</p> : null}
        {installing ? (
          <ActionProgressBar label={installStep === 1 ? t("home.installingRuntime") : t("home.refreshingEnv")} step={installStep} steps={2} />
        ) : null}
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
            data-tip={preview ? t("common.preview") : t("common.open")}
          >
            <Icon name="folder-open" extra="sm" />{t("home.openLocalFolder")}
          </button>
          {runtimeMissing && client ? (
            <button
              className="btn outline"
              disabled={installing}
              data-tip={t("home.installRuntime")}
              onClick={() => {
                void (async () => {
                  setInstalling(true);
                  setInstallStep(1);
                  setInstallMessage(undefined);
                  try {
                    const handle = await client.command("runtime.install", {});
                    const receipt = await waitForCommandReceipt(client, handle.requestId);
                    setInstallStep(2);
                    if (receipt.status === "completed") {
                      setInstallMessage(t("home.installRuntimeSuccess"));
                    } else if (receipt.status === "failed") {
                      setInstallMessage(receipt.error.message);
                    } else {
                      setInstallMessage(t("home.installRuntimeIncomplete"));
                    }
                  } catch (error) {
                    setInstallMessage(error instanceof Error ? error.message : t("home.installRuntimeFailed"));
                  } finally {
                    setInstalling(false);
                  }
                })();
              }}
            >
              <Icon name="package" extra="sm" />{installing ? `${t("home.installingRuntime")}…` : t("home.installRuntime")}
            </button>
          ) : null}
          <button
            className="btn outline"
            disabled={preview || !client}
            data-tip={t("home.cloneRepo")}
            onClick={() => {
              // 克隆 URL 依赖 window.prompt 收集，而 Electron 渲染进程不支持 prompt
              // （electron/electron#472），桌面端无处输入；等输入对话框接入后恢复克隆流程。
              setInstallMessage(t("home.clonePending"));
            }}
          ><Icon name="branch" extra="sm" />{t("home.cloneRepo")}</button>
          <button className="btn outline" onClick={() => onRoute("history")}><Icon name="history" extra="sm" />{t("home.resumeRecentChat")}</button>
          <button className="btn outline" disabled data-tip={t("home.tempWorkspace")}><Icon name="flask" extra="sm" />{t("home.tempWorkspace")}</button>
        </div>
      </div>

      <h3 className="home-h">{t("home.recentProjects")}</h3>
      <div className="proj-grid" id="projGrid">
        {preview ? PREVIEW_PROJECTS.map((project) => (
          <button key={project.id} className="proj-card" type="button" onClick={() => onRoute("workbench")}>
            <span className="pc-name"><Icon name="folder-open" /><span className="ellipsis">{project.name}</span></span>
            <span className="pc-path ellipsis">{project.path}</span>
            <span className="pc-flags">
              {project.running ? <span className="chip blue">{t("home.taskRunning")}</span> : <span className="chip gray">{t("home.idle")}</span>}
              {project.dirty > 0 ? <span className="chip amber">{project.dirty} {t("common.uncommitted")}</span> : null}
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
              {workspace.active ? <span className="chip blue">{t("home.currentProject")}</span> : <span className="chip gray">{t("home.idle")}</span>}
            </span>
            <span className="pc-foot">
              <span className="ellipsis">{workspace.active ? t("home.openedAndRecentlyUsed") : t("home.recentlyUsed")}</span>
              <span className="spacer" />
              <span>{relativeTime(workspace.lastOpenedAt, resolvedLanguage, t)}</span>
            </span>
          </button>
        )) : (
          <div className="empty-inline">{t("home.noRecentProjects")}</div>
        )}
      </div>

      <TokenUsageCard {...(client ? { client } : {})} />

      <h3 className="home-h home-h-tight">{t("home.recentActivity")}</h3>
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
            <span className="ellipsis">{t("home.sessionEntry", { title: entry.title ?? t("conversation.untitledSession") })}</span>
            <span className="spacer" />
            <span className="tiny muted">{relativeTime(entry.lastActiveAt, resolvedLanguage, t)}</span>
          </button>
        )        ) : (
          <div className="empty" style={{ padding: 16 }}>{t("home.noRecentActivity")}</div>
        )}
      </div>
      {editingProfile ? (
        <ProfileEditDialog
          name={profile.displayName}
          avatar={profile.avatarSrc}
          onClose={() => setEditingProfile(false)}
          onSave={async (next) => {
            update({ displayName: next.displayName });
            if (next.avatar !== undefined) await persistAvatar(next.avatar);
            setEditingProfile(false);
          }}
        />
      ) : null}
    </div>
  );
}
