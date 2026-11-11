import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { pageDir, pagePhaseClass, useDeferredKey } from "./pageTransition";
import { useI18n } from "./i18n";

export type PageRoute = "home" | "workbench" | "history" | "agent-hub" | "capabilities" | "model-config" | "settings" | "diagnostics" | "media" | "evaluation" | "statistics";

/** The persistent AppNavRail is an additional entry point; the page header keeps
 *  the original full tab row so both surfaces stay in sync. */
const PAGE_NAV_DEFS: ReadonlyArray<{ id: PageRoute; icon: IconName; key: string }> = [
  { id: "workbench", icon: "workbench", key: "nav.workbench" },
  { id: "home", icon: "home", key: "nav.home" },
  { id: "history", icon: "history", key: "nav.history" },
  { id: "capabilities", icon: "package", key: "nav.capabilities" },
  { id: "model-config", icon: "server", key: "nav.modelConfig" },
  { id: "evaluation", icon: "pulse", key: "nav.evaluation" },
  { id: "media", icon: "image", key: "media.title" },
  { id: "settings", icon: "settings", key: "nav.settings" },
  { id: "diagnostics", icon: "pulse", key: "nav.diagnostics" },
];

/** Where a page sits in the navigation order (the header row and the rail list
 *  the same pages in the same order). Pages are siblings, so a later one
 *  arrives from the right and an earlier one from the left: the content
 *  travels the way the active indicator does (see "Space" in styles/motion.css). */
function pageOrder(route: PageRoute): number {
  // Statistics opens from the home page's token card and returns to it.
  if (route === "statistics") return pageOrder("home") + 0.5;
  const at = PAGE_NAV_DEFS.findIndex((item) => item.id === route);
  return at < 0 ? PAGE_NAV_DEFS.length : at;
}

function isAppRoute(id: string): id is Exclude<PageRoute, "agent-hub"> {
  return id === "home" || id === "workbench" || id === "history" || id === "capabilities" || id === "model-config" || id === "settings" || id === "diagnostics" || id === "media" || id === "evaluation" || id === "statistics";
}

export function SecondaryPage({
  route,
  title,
  titleIcon,
  theme,
  className,
  onRoute,
  onToggleTheme,
  backRoute = "workbench",
  children,
}: {
  route: PageRoute;
  title: string;
  titleIcon?: IconName;
  theme: "light" | "dark";
  className?: string;
  onRoute: (route: PageRoute) => void;
  onToggleTheme: () => void;
  /** 页头返回按钮的目标页。多数二级页回工作台；统计页由首页 Token 卡进入，回首页。 */
  backRoute?: PageRoute;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const navRef = useRef<HTMLElement>(null);
  const winRef = useRef<HTMLSpanElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const heldChildren = useRef(children);
  const { shown, phase, dir } = useDeferredKey(route, pageOrder);
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
      // Keep the active entry reachable when the header is too narrow for all
      // links: scroll only as far as needed, never re-center the row.
      const left = active.offsetLeft;
      const right = left + active.offsetWidth;
      const inset = 8;
      if (left < nav.scrollLeft + inset) nav.scrollLeft = Math.max(0, left - inset);
      else if (right > nav.scrollLeft + nav.clientWidth - inset) nav.scrollLeft = right - nav.clientWidth + inset;
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

  /* 返回按钮的提示跟随真实目标页，避免「回首页」却挂着「工作台」。 */
  const backLabel = t(PAGE_NAV_DEFS.find((entry) => entry.id === backRoute)?.key ?? "nav.workbench");

  return (
    <div className={className ? `page ${className}` : "page"} id="pageRoot">
      <header className="page-head" id="pageHead">
        <button className="icon-btn" data-tip={backLabel} aria-label={backLabel} onClick={() => onRoute(backRoute)}>
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
        data-page-axis="x"
        data-page-dir={pageDir(dir)}
        id="pageBody"
        tabIndex={-1}
        data-route={shown}
      >
        {body}
      </div>
    </div>
  );
}
