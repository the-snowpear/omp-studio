import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Icon, type IconName } from "./icons";
import { INSTANT_MS, MOTION_MS, MOTION_SLACK_MS, transitionMs } from "./motion";
import { useI18n } from "./i18n";
import { avatarInitial } from "./settings/operatorProfile";
import { usePreviewMode } from "./preview/PreviewContext";

/** Top-level destinations owned by the collapsible rail. The page-head tab row
 *  stays in place as the primary in-page switcher; this rail is an additional
 *  entry point and the two active states animate on the same clock. */
export type NavRailRoute =
  | "workbench"
  | "home"
  | "history"
  | "capabilities"
  | "model-config"
  | "settings";

const NAV_RAIL_ITEMS: ReadonlyArray<{ route: NavRailRoute; icon: IconName; labelKey: string }> = [
  /* `workbench` (three panes), not `layout`: the latter is the "toggle the left
     region" glyph in the titlebar and the View menu, and two identical marks in
     one window read as the same command. */
  { route: "workbench", icon: "workbench", labelKey: "nav.workbench" },
  { route: "home", icon: "home", labelKey: "nav.home" },
  { route: "history", icon: "history", labelKey: "nav.history" },
  { route: "capabilities", icon: "package", labelKey: "nav.capabilities" },
  { route: "model-config", icon: "server", labelKey: "nav.modelConfig" },
  { route: "settings", icon: "settings", labelKey: "nav.settings" },
];

/** How close the pointer must come to the border line before the handle shows.
 *  The band is symmetric on purpose: coming from the sidebar (the side you hover
 *  when you want the rail gone or back) has to work as well as coming down the
 *  rail itself. */
const HANDLE_REACH_X = 14;
const HANDLE_REACH_Y = 12;
export function AppNavRail({
  activeRoute,
  collapsed,
  profile,
  update,
  demo = false,
  onToggleCollapsed,
  onNavigate,
  onOpenUpdate,
  menuOpen = false,
  onToggleMenu,
  onLayoutShift,
  avatarRef,
}: {
  readonly activeRoute: string;
  /* Collapsed state lives in the shell: the avatar falls back to the sidebar
     footer while the rail is away, so one owner has to decide both. */
  readonly collapsed: boolean;
  readonly profile: { readonly displayName: string; readonly avatarSrc: string };
  /** null = no update detected; the update entry stays unmounted. */
  readonly update: { readonly version?: string } | null;
  readonly demo?: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onNavigate: (route: NavRailRoute) => void;
  readonly onOpenUpdate: () => void;
  readonly menuOpen?: boolean;
  /** Anchor is passed back because the environment menu is anchored to whichever
   *  avatar (rail or sidebar footer) the user actually clicked. */
  readonly onToggleMenu?: (anchor: HTMLButtonElement) => void;
  /** Called once per frame while the rail slides, so fixed-position shells that
   *  measure their slots can follow the width change. */
  readonly onLayoutShift?: () => void;
  /** The avatar circle itself (not the button): the shell measures it to hand the
   *  identity block over to the sidebar footer without a blink. */
  readonly avatarRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const { marks } = usePreviewMode();
  const [handleNear, setHandleNear] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  /* Cached border line. Reading it per pointermove would force layout on every
     mouse move; it only moves on resize and during the slide (see below). */
  const lineRef = useRef({ x: 0, top: 0, bottom: 0 });
  const firstMotion = useRef(true);
  const activeIndex = NAV_RAIL_ITEMS.findIndex((item) => item.route === activeRoute);
  const updateLabel = update === null
    ? ""
    : `${t("appUpdate.foundNewVersion")}${update.version === undefined ? "" : ` v${update.version}`}${demo && marks ? ` ${t("appUpdate.demoUpdate")}` : ""}`;
  const avatarLabel = `${profile.displayName} · ${t("nav.profileMenu")}`;

  const measureLine = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const box = rail.getBoundingClientRect();
    lineRef.current = { x: box.right, top: box.top, bottom: box.bottom };
  }, []);

  const toggle = () => {
    setHandleNear(false);
    onToggleCollapsed();
  };

  /* One loop for the whole slide: the border line moves, and dock panels are
     fixed-position bodies measured from their slot — a width change that leaves
     the slot's own size alone (exactly this case) is invisible to their
     ResizeObserver, so the shell has to be re-measured while the rail moves. */
  useEffect(() => {
    measureLine();
    if (firstMotion.current) {
      firstMotion.current = false;
      return;
    }
    const rail = railRef.current;
    const duration = rail === null ? MOTION_MS.slow : transitionMs(rail);
    /* Reduced-motion tiers collapse the duration to ~0: nothing to follow, just
       re-measure once so the panels land on the new layout. */
    if (duration < INSTANT_MS) {
      onLayoutShift?.();
      return;
    }
    const total = duration + MOTION_SLACK_MS * 2;
    const start = performance.now();
    let frame = requestAnimationFrame(function step() {
      measureLine();
      onLayoutShift?.();
      if (performance.now() - start < total) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [collapsed, measureLine, onLayoutShift]);

  useEffect(() => {
    const observer = new ResizeObserver(measureLine);
    observer.observe(railRef.current!);
    window.addEventListener("resize", measureLine);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureLine);
    };
  }, [measureLine]);

  /* The handle is revealed by pointer proximity rather than by an overlay band:
     a transparent strip would swallow clicks from the sidebar (or, worse, from a
     destination button in a short window), and proximity also works from the
     sidebar side of the line. One requestAnimationFrame coalesces bursts. */
  useEffect(() => {
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const line = lineRef.current;
        const near = Math.abs(event.clientX - line.x) <= HANDLE_REACH_X
          && event.clientY >= line.top - HANDLE_REACH_Y
          && event.clientY <= line.bottom + HANDLE_REACH_Y;
        setHandleNear(near && !(event.target instanceof Element && event.target.closest(".app-rail-btn") !== null));
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  const handleLabel = collapsed ? t("nav.expandRail") : t("nav.collapseRail");

  return (
    <div ref={railRef} className={`app-rail${collapsed ? " is-collapsed" : ""}`}>
      {/* The column is clipped, not unmounted: the width transition has to keep
          painting it while it leaves, and the destination column keeps its own
          56px so the icons slide out from under the edge instead of reflowing. */}
      <div className="app-rail-clip" aria-hidden={collapsed || undefined} inert={collapsed}>
        <nav className="app-rail-nav" aria-label={t("nav.rail")}>
          <div className="app-rail-top">
            <span
              className={`app-rail-window${activeIndex < 0 ? " is-hidden" : ""}`}
              style={{ "--rail-active-index": Math.max(activeIndex, 0) } as CSSProperties}
              aria-hidden="true"
            />
            {NAV_RAIL_ITEMS.map((item) => {
              const label = t(item.labelKey);
              const active = activeRoute === item.route;
              return (
                <button
                  key={item.route}
                  type="button"
                  className={`app-rail-btn${active ? " active" : ""}`}
                  data-route={item.route}
                  data-tip={label}
                  aria-label={label}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onNavigate(item.route)}
                >
                  <Icon name={item.icon} extra="lg" />
                </button>
              );
            })}
          </div>
          <div className="app-rail-bottom">
            {update === null ? null : (
              <button
                type="button"
                className="app-rail-btn app-rail-update"
                data-tip={updateLabel}
                aria-label={updateLabel}
                onClick={onOpenUpdate}
              >
                <Icon name="update" extra="lg" />
                <span className="app-rail-notice" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="app-rail-avatar"
              data-tip={avatarLabel}
              aria-label={avatarLabel}
              aria-haspopup={onToggleMenu === undefined ? undefined : "menu"}
              aria-expanded={onToggleMenu === undefined ? undefined : menuOpen}
              onClick={(event) => {
                if (onToggleMenu === undefined) {
                  onNavigate("home");
                  return;
                }
                onToggleMenu(event.currentTarget);
              }}
            >
              {profile.avatarSrc
                ? <img ref={(node) => { if (avatarRef) avatarRef.current = node; }} src={profile.avatarSrc} alt="" draggable={false} />
                : <span ref={(node) => { if (avatarRef) avatarRef.current = node; }} aria-hidden="true">{avatarInitial(profile.displayName)}</span>}
            </button>
          </div>
        </nav>
      </div>
      {/* Rides the rail's border line: half over the rail, half over the content
          when open, flush against the screen edge when collapsed. */}
      <button
        type="button"
        className={`app-rail-handle${handleNear ? " is-near" : ""}`}
        data-tip={handleLabel}
        aria-label={handleLabel}
        onClick={toggle}
      >
        <Icon name="chevron-l" extra="sm" />
      </button>
    </div>
  );
}
