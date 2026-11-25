// Feature viewer: one app window whose tabs are the app's pages. The page itself is the real
// renderer in an iframe (public/live, built by tools/build-live.mjs); a screenshot holds its
// place until it is ready, and stays there on screens too small to use it.
import { i } from "../shared/icons";
import { PAGES, shot, type Theme } from "../shared/ui";

const EMBED_SOURCE = "omp-studio-embed";
const LIVE_W = 1280;
const SUB_ROUTE_TITLES: Record<string, string> = {
  statistics: "用量统计",
  workbench: "工作台",
  diagnostics: "诊断中心",
  media: "媒体",
  evaluation: "评测",
};
const root = document.documentElement;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface Viewer {
  setTheme(theme: Theme, notifyFrame: boolean): void;
  /** Ask the live page to change theme; resolves when it has, or shortly after. */
  syncTheme(theme: Theme): Promise<void>;
}

export function mountViewer(viewer: HTMLElement, currentTheme: () => Theme, onFrameTheme: (theme: Theme) => void): Viewer {
  viewer.innerHTML = `<div class="viewer-bar">
<div class="viewer-tabs" role="tablist" aria-label="应用页面"><i class="viewer-mark" aria-hidden="true"></i>${PAGES.map(
    (p, n) => `<button type="button" role="tab" id="vt-${n}" aria-controls="viewer-panel" aria-selected="${n === 0}" tabindex="${n === 0 ? 0 : -1}" title="${p.title}">${i(p.icon)}<span>${p.tab}</span></button>`,
  ).join("")}</div>
<span class="viewer-note">演示数据<span class="live-only">，可以直接点</span></span>
<button type="button" class="viewer-btn" id="viewer-back" hidden>${i("arrowLeft")}<span></span></button>
<button type="button" class="viewer-btn" id="viewer-reset" hidden title="重置当前演示页面">${i("refresh")}<span>重置</span></button>
</div>
<div class="viewer-panel" id="viewer-panel" role="tabpanel" aria-labelledby="vt-0">
<div class="viewer-shots" id="viewer-shots">${PAGES.map((p, n) => `<img data-shot="${p.shot}" src="${shot(p.shot, currentTheme())}" alt="${p.title}页面截图" width="1600" height="1000" ${n ? 'loading="lazy"' : ""} ${n === 0 ? "data-on" : ""}>`).join("")}</div>
</div>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => viewer.querySelector<T>(sel)!;
  const tabsList = $(".viewer-tabs");
  const mark = $(".viewer-mark");
  const tabs = [...viewer.querySelectorAll<HTMLElement>("[role=tab]")];
  const shotsEl = $("#viewer-shots");
  const shots = [...viewer.querySelectorAll<HTMLImageElement>(".viewer-shots img")];
  const backBtn = $("#viewer-back");
  const resetBtn = $("#viewer-reset");
  const panelEl = $("#viewer-panel");
  const section = viewer.closest<HTMLElement>("section")!;
  const textEl = section.querySelector<HTMLElement>("#viewer-text")!;
  const liveQuery = matchMedia("(min-width: 1080px)");

  let activePage = 0;
  let subRoute: string | null = null;
  let frame: HTMLIFrameElement | null = null;
  let ready = false;
  let failed = false;
  let wanted = false;
  let settleTimer = 0;
  let readyTimer = 0;
  let pendingAck: { theme: Theme; timer: number; resolve: () => void } | null = null;

  function resolveAck() {
    const current = pendingAck;
    if (!current) return;
    pendingAck = null;
    clearTimeout(current.timer);
    current.resolve();
  }

  function post(payload: Record<string, unknown>) {
    frame?.contentWindow?.postMessage({ source: EMBED_SOURCE, ...payload }, location.origin === "null" ? "*" : location.origin);
  }

  const liveUrl = (route: string, theme: Theme) =>
    `./live/website-embed.html?preview=1&marks=off&embed=1&theme=${theme}&lang=zh&route=${encodeURIComponent(route)}`;

  function scale() {
    const w = shotsEl.clientWidth;
    if (frame && w > 0) frame.style.transform = `scale(${w / LIVE_W})`;
    moveMark();
  }

  function moveMark() {
    const tab = tabs[activePage]!;
    mark.style.width = `${tab.offsetWidth}px`;
    mark.style.transform = `translate3d(${tab.offsetLeft}px, 0, 0)`;
  }

  // The page is 16:10. Give it the largest box that still leaves the heading, the tabs and the
  // caption on one screen; narrower windows let it be as wide as they are.
  function fit() {
    const cs = getComputedStyle(section);
    const avail = section.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (!matchMedia("(min-width: 768px)").matches) return section.style.removeProperty("--stage-w");
    const head = section.querySelector<HTMLElement>(".sec-head")!;
    const top = parseFloat(getComputedStyle(root).getPropertyValue("--top-h")) || 56;
    const rest = top + parseFloat(cs.paddingTop) + head.offsetHeight + parseFloat(getComputedStyle(head).marginBottom) + $(".viewer-bar").offsetHeight + 24;
    const w = Math.max(Math.min(720, avail), Math.min(avail, (innerHeight - rest) * 1.6, 1480));
    section.style.setProperty("--stage-w", `${Math.round(w)}px`);
  }

  function sync() {
    const active = ready && liveQuery.matches;
    resetBtn.hidden = !active;
    backBtn.hidden = !(active && subRoute !== null);
    if (frame) {
      frame.inert = !active;
      if (active) frame.removeAttribute("tabindex");
      else frame.tabIndex = -1;
    }
    const page = PAGES[activePage]!;
    if (subRoute) backBtn.querySelector("span")!.textContent = `${SUB_ROUTE_TITLES[subRoute] ?? subRoute}，返回${page.tab}`;
    if (textEl.textContent !== page.text) {
      textEl.textContent = page.text;
      if (!reduced()) textEl.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    }
  }

  function clearReady() {
    clearTimeout(settleTimer);
    ready = false;
    if (frame) delete frame.dataset.ready;
    delete shotsEl.dataset.liveSettled;
    sync();
  }

  function abort() {
    clearTimeout(readyTimer);
    failed = true;
    clearReady();
    frame?.remove();
    frame = null;
    resolveAck();
  }

  function awaitReady() {
    clearTimeout(readyTimer);
    readyTimer = window.setTimeout(() => {
      if (!ready) abort();
    }, 15_000);
  }

  function markReady() {
    clearTimeout(readyTimer);
    ready = true;
    if (frame) frame.dataset.ready = "";
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      if (ready) shotsEl.dataset.liveSettled = "";
    }, reduced() ? 0 : 300);
    sync();
  }

  function mountLive() {
    wanted = true;
    if (frame || failed || !liveQuery.matches) return;
    const el = document.createElement("iframe");
    el.className = "viewer-live";
    el.title = "OMP Studio 真实可交互界面（演示数据）";
    el.inert = true;
    el.tabIndex = -1;
    el.src = liveUrl(subRoute ?? PAGES[activePage]!.shot, currentTheme());
    el.addEventListener("load", () => {
      try {
        // A host that answers a missing file with this page would nest the site in itself.
        const doc = el.contentDocument;
        if (doc && (!doc.getElementById("root") || doc.getElementById("viewer"))) abort();
      } catch { /* ignore cross-origin access */ }
    });
    el.addEventListener("error", abort);
    frame = el;
    shotsEl.append(el);
    scale();
    awaitReady();
  }

  function applyPage(n: number, focus = false) {
    activePage = n;
    tabs.forEach((t, k) => {
      t.setAttribute("aria-selected", String(k === n));
      t.tabIndex = k === n ? 0 : -1;
    });
    shots.forEach((s, k) => s.toggleAttribute("data-on", k === n));
    panelEl.setAttribute("aria-labelledby", `vt-${n}`);
    moveMark();
    // Keep the chosen tab in view in the scrolling strip, without moving the page.
    const tab = tabs[n]!;
    tabsList.scrollTo({ left: tab.offsetLeft - (tabsList.clientWidth - tab.offsetWidth) / 2, behavior: reduced() ? "auto" : "smooth" });
    sync();
    if (focus) tab.focus({ preventScroll: true });
  }

  function showPage(n: number, focus = false) {
    subRoute = null;
    applyPage(n, focus);
    if (frame && ready) post({ type: "set-route", route: PAGES[n]!.shot });
    else mountLive();
  }

  tabs.forEach((tab, n) => {
    tab.addEventListener("click", () => showPage(n));
    tab.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      showPage((n + step + PAGES.length) % PAGES.length, true);
    });
  });
  tabsList.addEventListener("pointerenter", mountLive, { once: true });
  tabsList.addEventListener("focusin", mountLive, { once: true });

  backBtn.addEventListener("click", () => {
    subRoute = null;
    sync();
    if (frame && ready) post({ type: "set-route", route: PAGES[activePage]!.shot });
    tabs[activePage]?.focus({ preventScroll: true });
  });

  resetBtn.addEventListener("click", () => {
    if (!frame) return;
    subRoute = null;
    const url = liveUrl(PAGES[activePage]!.shot, currentTheme());
    clearReady();
    resolveAck();
    if (frame.getAttribute("src") === url && frame.contentWindow) frame.contentWindow.location.reload();
    else frame.src = url;
    awaitReady();
  });

  new ResizeObserver(scale).observe(shotsEl);
  liveQuery.addEventListener("change", () => {
    sync();
    if (liveQuery.matches) {
      scale();
      if (wanted) mountLive();
    }
  });
  addEventListener("resize", fit);
  document.fonts.ready.then(() => {
    fit();
    moveMark();
  });

  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    mountLive();
  }, { rootMargin: "700px 0px" });
  io.observe(section);

  addEventListener("message", (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    if (location.origin !== "null" && event.origin !== location.origin) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || data.source !== EMBED_SOURCE) return;

    if (data.type === "ready") {
      markReady();
      const wantRoute = subRoute ?? PAGES[activePage]!.shot;
      if (typeof data.route === "string" && data.route !== wantRoute) post({ type: "set-route", route: wantRoute });
      const wantTheme = currentTheme();
      if (typeof data.theme === "string" && data.theme !== wantTheme) post({ type: "set-theme", theme: wantTheme });
    } else if (data.type === "theme-ack") {
      if (pendingAck && data.theme === pendingAck.theme) resolveAck();
    } else if (data.type === "route-changed" && typeof data.route === "string") {
      const idx = PAGES.findIndex((p) => p.shot === data.route);
      if (idx !== -1) {
        subRoute = null;
        applyPage(idx);
      } else {
        subRoute = data.route;
        sync();
      }
    } else if (data.type === "theme-changed" && (data.theme === "light" || data.theme === "dark") && data.theme !== currentTheme()) {
      onFrameTheme(data.theme);
    }
  });

  applyPage(0);
  fit();

  return {
    setTheme(theme, notifyFrame) {
      for (const img of shots) img.src = shot(img.dataset.shot as never, theme);
      if (notifyFrame && ready) post({ type: "set-theme", theme });
    },
    syncTheme(theme) {
      resolveAck();
      if (!frame || !ready) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = window.setTimeout(resolveAck, 60);
        pendingAck = { theme, timer, resolve };
        post({ type: "set-theme", theme });
      });
    },
  };
}
