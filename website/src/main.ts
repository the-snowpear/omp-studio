import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../shared/base.css";
import "../shared/ui.css";
import "./style.css";
import "./pitch.css";
import "./desk.css";
import "./sections.css";
import "./more.css";

import { i, icon, piMark } from "../shared/icons";
import {
  MAC_QUARANTINE_COMMAND, RELEASES_URL, REPO_URL, SOURCE_COMMANDS, WORKBENCH_VERSION,
  detectPlatform, formatSize, loadRelease, predatesWorkbench, type Asset,
} from "../shared/release";
import { EXTRAS, PAGES, shot, type Theme } from "../shared/ui";
import iconUrl from "../shared/media/icon-256.webp";
import { mountPitch, type Quest } from "./pitch";
import { mountRules } from "./rules";
import { Workbench, type WmEvent } from "./wm";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const root = document.documentElement;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const currentTheme = (): Theme => (root.dataset.theme === "dark" ? "dark" : "light");

if (!(window.self !== window.top && new URLSearchParams(location.search).get("embed") === "1")) {
  boot();
}

function boot() {
// ---------------- static marks ----------------
$$("[data-pi]").forEach((el) => (el.innerHTML = piMark(22)));
$("#gh").innerHTML = icon.github;
$<HTMLImageElement>("#dl-icon").src = iconUrl;

// ---------------- toast ----------------
const toastEl = $("#toast");
let toastTimer = 0;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.dataset.on = "";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.removeAttribute("data-on"), 2200);
}

// ---------------- the side panel and the workbench ----------------
const QUEST_OF: Partial<Record<WmEvent, Quest>> = { snap: "snap", layout: "layout", open: "open", pin: "pin" };
const canvas = $("#canvas");
const hint = $("#desk-hint");
const pitch = mountPitch($("#pitch"), (kind) => bench.open(kind));
const bench = new Workbench(canvas, $("#pip"), $("#dock"), $("#wm-preview"), (event) => {
  hint.removeAttribute("data-on");
  const quest = QUEST_OF[event];
  if (quest) pitch.complete(quest);
});
const compact = canvas.clientWidth < 620;
bench.open("chat", true, 250);
if (!compact) bench.open("plan", true, 370);
bench.open("browser", true, compact ? 370 : 490);
bench.open("chat", true);

// Point at the title bar until the visitor has moved something.
setTimeout(() => {
  const bar = bench.barRect("chat");
  if (!bar) return;
  const o = canvas.getBoundingClientRect();
  const above = bar.top - o.top > 40;
  hint.toggleAttribute("data-below", !above);
  hint.style.transform = `translate3d(${bar.left - o.left + bar.width * 0.42}px, ${above ? bar.top - o.top - 34 : bar.bottom - o.top + 10}px, 0)`;
  hint.dataset.on = "";
}, 1500);
canvas.addEventListener("pointerdown", () => hint.removeAttribute("data-on"), { once: true });

// ---------------- feature viewer (live embed + poster fallback) ----------------
const EMBED_SOURCE = "omp-studio-embed";
const LIVE_W = 1280;
const SUB_ROUTE_TITLES: Record<string, string> = {
  statistics: "用量统计",
  workbench: "工作台",
  diagnostics: "诊断中心",
  media: "媒体",
  evaluation: "评测",
};

const viewer = $("#viewer");
viewer.innerHTML = `<div class="viewer-side">
<p class="viewer-kicker">应用页面<span id="viewer-count">1 / ${PAGES.length}</span></p>
<div class="viewer-tabs" role="tablist" aria-label="应用页面">${PAGES.map(
  (p, n) => `<button type="button" role="tab" id="vt-${n}" aria-controls="viewer-panel" aria-selected="${n === 0}" tabindex="${n === 0 ? 0 : -1}">${i(p.icon)}<span>${p.title}</span></button>`,
).join("")}</div>
<p class="viewer-text" id="viewer-text"></p>
</div>
<div class="viewer-panel" id="viewer-panel" role="tabpanel" aria-labelledby="vt-0">
<div class="viewer-bar"><i></i><i></i><i></i><button type="button" class="viewer-bar-btn" id="viewer-back" hidden>${i("arrowLeft")}<span>返回</span></button><span class="viewer-title" id="viewer-title"></span><span class="viewer-bar-grow"></span><span class="viewer-badge" id="viewer-badge" hidden>真实交互 · 演示数据</span><button type="button" class="viewer-bar-btn" id="viewer-reset" hidden aria-label="重置当前演示页面">${i("refresh")}<span>重置</span></button></div>
<div class="viewer-shots" id="viewer-shots">${PAGES.map((p, n) => `<img data-shot="${p.shot}" src="${shot(p.shot, currentTheme())}" alt="${p.title}页面截图" width="1440" height="900" ${n ? 'loading="lazy"' : ""} ${n === 0 ? "data-on" : ""}>`).join("")}</div></div>`;

const tabsList = $(".viewer-tabs");
const tabs = $$(".viewer-tabs [role=tab]");
const shotsEl = $("#viewer-shots");
const shots = $$(".viewer-shots img");
const backBtn = $<HTMLButtonElement>("#viewer-back");
const titleEl = $("#viewer-title");
const badgeEl = $("#viewer-badge");
const resetBtn = $<HTMLButtonElement>("#viewer-reset");
const textEl = $("#viewer-text");
const countEl = $("#viewer-count");
const panelEl = $("#viewer-panel");
const featuresEl = $("#features");
const featuresHead = $(".features .sec-head");
const viewerBar = $(".viewer-bar");
const viewerSide = $(".viewer-side");
const deskQuery = matchMedia("(min-width: 768px)");
const liveQuery = matchMedia("(min-width: 1200px)");

let activePage = 0;
let subRoute: string | null = null;
let liveFrame: HTMLIFrameElement | null = null;
let liveReady = false;
let liveFailed = false;
let wantsLive = false;
let settleTimer = 0;
let readyTimer = 0;
let pendingThemeAck: { theme: Theme; timer: number; resolve: () => void } | null = null;

function resolveThemeAck() {
  if (!pendingThemeAck) return;
  const current = pendingThemeAck;
  pendingThemeAck = null;
  clearTimeout(current.timer);
  current.resolve();
}

function postToFrame(payload: Record<string, unknown>) {
  const targetOrigin = location.origin === "null" ? "*" : location.origin;
  liveFrame?.contentWindow?.postMessage({ source: EMBED_SOURCE, ...payload }, targetOrigin);
}

function liveUrl(route: string, theme: Theme) {
  return `./live/website-embed.html?preview=1&marks=off&embed=1&theme=${theme}&lang=zh&route=${encodeURIComponent(route)}`;
}

function scaleLive() {
  if (!liveFrame) return;
  const w = shotsEl.clientWidth;
  if (w > 0) liveFrame.style.transform = `scale(${w / LIVE_W})`;
}

// The page mock is 16:10, so its width follows its height and vice versa. Give it the
// largest box that still leaves the whole section — header, window bar and caption — on
// one screen, then let the stacked layout take over when the window is too narrow.
const TOP_GAP = 12;
const MAX_SHOTS_W = 1400;
function fitViewer() {
  if (!deskQuery.matches) {
    featuresEl.style.removeProperty("--shots-w");
    featuresEl.style.removeProperty("--stage-w");
    return;
  }
  const cs = getComputedStyle(featuresEl);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const topBar = (parseFloat(getComputedStyle(root).getPropertyValue("--top-h")) || 52) + TOP_GAP;
  const headH = featuresHead.offsetHeight + (parseFloat(getComputedStyle(featuresHead).marginBottom) || 0);
  const reserved = topBar + (parseFloat(cs.paddingTop) || 0) + headH + viewerBar.offsetHeight + (parseFloat(cs.paddingBottom) || 0) + 2;
  const side = viewerSide.offsetWidth;
  const gap = parseFloat(getComputedStyle(viewer).columnGap) || 0;
  const availW = featuresEl.clientWidth - padX - side - gap;
  const availH = innerHeight - reserved;
  const w = Math.max(420, Math.min(availW, availH * (1440 / 900), MAX_SHOTS_W));
  featuresEl.style.setProperty("--shots-w", `${Math.round(w)}px`);
  featuresEl.style.setProperty("--stage-w", `${Math.round(w + side + gap)}px`);
}

function syncLiveChrome() {
  const liveActive = liveReady && liveQuery.matches;
  badgeEl.hidden = !liveActive;
  resetBtn.hidden = !liveActive;
  backBtn.hidden = !(liveActive && subRoute !== null);
  if (liveFrame) {
    liveFrame.inert = !liveActive;
    if (liveActive) liveFrame.removeAttribute("tabindex");
    else liveFrame.tabIndex = -1;
  }
  const page = PAGES[activePage]!;
  titleEl.textContent = liveActive && subRoute ? `${page.title} / ${SUB_ROUTE_TITLES[subRoute] ?? subRoute}` : page.title;
  textEl.textContent = page.text;
  countEl.textContent = `${activePage + 1} / ${PAGES.length}`;
}

function clearLiveReady() {
  clearTimeout(settleTimer);
  liveReady = false;
  if (liveFrame) {
    delete liveFrame.dataset.ready;
    liveFrame.inert = true;
    liveFrame.tabIndex = -1;
  }
  delete shotsEl.dataset.liveReady;
  delete shotsEl.dataset.liveSettled;
  syncLiveChrome();
}

function abortLive() {
  clearTimeout(readyTimer);
  liveFailed = true;
  clearLiveReady();
  liveFrame?.remove();
  liveFrame = null;
  resolveThemeAck();
}

function markLiveReady() {
  clearTimeout(readyTimer);
  liveReady = true;
  if (liveFrame) liveFrame.dataset.ready = "";
  shotsEl.dataset.liveReady = "";
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    if (liveReady) shotsEl.dataset.liveSettled = "";
  }, reduced() ? 0 : 300);
  syncLiveChrome();
}

function mountLive() {
  wantsLive = true;
  if (liveFrame || liveFailed || !liveQuery.matches) return;
  const frame = document.createElement("iframe");
  frame.className = "viewer-live";
  frame.title = "OMP Studio 真实可交互界面（演示数据）";
  frame.inert = true;
  frame.tabIndex = -1;
  frame.src = liveUrl(subRoute ?? PAGES[activePage]!.shot, currentTheme());
  frame.addEventListener("load", () => {
    try {
      const doc = frame.contentDocument;
      if (doc && (!doc.getElementById("root") || doc.getElementById("viewer"))) abortLive();
    } catch { /* ignore cross-origin access */ }
  });
  frame.addEventListener("error", abortLive);
  liveFrame = frame;
  shotsEl.append(frame);
  scaleLive();
  clearTimeout(readyTimer);
  readyTimer = window.setTimeout(() => {
    if (!liveReady) abortLive();
  }, 15_000);
}

function applyPageUi(n: number, focus = false) {
  activePage = n;
  tabs.forEach((t, k) => {
    t.setAttribute("aria-selected", String(k === n));
    t.tabIndex = k === n ? 0 : -1;
  });
  shots.forEach((s, k) => s.toggleAttribute("data-on", k === n));
  panelEl.setAttribute("aria-labelledby", `vt-${n}`);
  syncLiveChrome();
  if (focus) tabs[n]!.focus();
}

function showPage(n: number, focus = false) {
  subRoute = null;
  applyPageUi(n, focus);
  const page = PAGES[n]!;
  if (liveFrame && liveReady) {
    postToFrame({ type: "set-route", route: page.shot });
  } else {
    mountLive();
  }
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
tabsList.addEventListener("pointerenter", () => mountLive(), { once: true });
tabsList.addEventListener("focusin", () => mountLive(), { once: true });

backBtn.addEventListener("click", () => {
  subRoute = null;
  syncLiveChrome();
  if (liveFrame && liveReady) postToFrame({ type: "set-route", route: PAGES[activePage]!.shot });
  tabs[activePage]?.focus({ preventScroll: true });
});

resetBtn.addEventListener("click", () => {
  if (!liveFrame) return;
  subRoute = null;
  const url = liveUrl(PAGES[activePage]!.shot, currentTheme());
  clearLiveReady();
  resolveThemeAck();
  if (liveFrame.getAttribute("src") === url && liveFrame.contentWindow) {
    liveFrame.contentWindow.location.reload();
  } else {
    liveFrame.src = url;
  }
  clearTimeout(readyTimer);
  readyTimer = window.setTimeout(() => {
    if (!liveReady) abortLive();
  }, 15_000);
});

new ResizeObserver(scaleLive).observe(shotsEl);
liveQuery.addEventListener("change", () => {
  if (liveQuery.matches) {
    scaleLive();
    syncLiveChrome();
    if (wantsLive && !liveFrame && !liveFailed) mountLive();
  } else {
    syncLiveChrome();
  }
});
deskQuery.addEventListener("change", fitViewer);
addEventListener("resize", fitViewer);
document.fonts.ready.then(fitViewer);

if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      mountLive();
    },
    { rootMargin: "700px 0px" },
  );
  io.observe(featuresEl);
}

addEventListener("message", (event) => {
  if (!liveFrame || event.source !== liveFrame.contentWindow) return;
  if (location.origin !== "null" && event.origin !== location.origin) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || data.source !== EMBED_SOURCE) return;

  if (data.type === "ready") {
    markLiveReady();
    const wantRoute = subRoute ?? PAGES[activePage]!.shot;
    if (typeof data.route === "string" && data.route !== wantRoute) {
      postToFrame({ type: "set-route", route: wantRoute });
    }
    const wantTheme = currentTheme();
    if (typeof data.theme === "string" && data.theme !== wantTheme) {
      postToFrame({ type: "set-theme", theme: wantTheme });
    }
    return;
  }

  if (data.type === "theme-ack") {
    if (pendingThemeAck && data.theme === pendingThemeAck.theme) resolveThemeAck();
    return;
  }

  if (data.type === "route-changed" && typeof data.route === "string") {
    const idx = PAGES.findIndex((p) => p.shot === data.route);
    if (idx !== -1) {
      subRoute = null;
      applyPageUi(idx, false);
    } else {
      subRoute = data.route;
      syncLiveChrome();
    }
    return;
  }

  if (data.type === "theme-changed" && (data.theme === "light" || data.theme === "dark")) {
    if (data.theme !== currentTheme()) {
      try {
        localStorage.setItem("omp-site-theme", data.theme);
      } catch { /* private mode */ }
      paintTheme(data.theme, false);
    }
  }
});

applyPageUi(0);
fitViewer();

// ---------------- theme ----------------
const themeBtn = $("#theme");
const rules = mountRules($("#rules"));

function syncFrameTheme(theme: Theme): Promise<void> {
  resolveThemeAck();
  if (!liveFrame || !liveReady) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      if (pendingThemeAck?.timer === timer) pendingThemeAck = null;
      resolve();
    }, 60);
    pendingThemeAck = {
      theme,
      timer,
      resolve: () => {
        clearTimeout(timer);
        if (pendingThemeAck?.timer === timer) pendingThemeAck = null;
        resolve();
      },
    };
    postToFrame({ type: "set-theme", theme });
  });
}

function paintTheme(theme: Theme, notifyFrame = true) {
  root.dataset.theme = theme;
  $$(".omp").forEach((el) => (el.dataset.theme = theme));
  rules.setTheme(theme);
  themeBtn.innerHTML = theme === "dark" ? icon.sun : icon.moon;
  themeBtn.setAttribute("aria-pressed", String(theme === "dark"));
  themeBtn.setAttribute("aria-label", theme === "dark" ? "切换浅色主题" : "切换深色主题");
  $<HTMLMetaElement>('meta[name="theme-color"]').content = theme === "dark" ? "#0d0c14" : "#f6f5fb";
  $$<HTMLImageElement>("[data-shot]").forEach((img) => (img.src = shot(img.dataset.shot as never, theme)));
  if (notifyFrame && liveFrame && liveReady) postToFrame({ type: "set-theme", theme });
}
paintTheme(currentTheme(), false);

themeBtn.addEventListener("click", () => {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("omp-site-theme", next);
  } catch { /* private mode: the choice lasts for this visit */ }
  const b = themeBtn.getBoundingClientRect();
  const x = b.left + b.width / 2;
  const y = b.top + b.height / 2;
  if (!document.startViewTransition || reduced()) {
    paintTheme(next);
    return pitch.complete("theme", { x, y });
  }
  // The new theme opens from the button, like light spreading from a switch.
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  root.dataset.themeSwap = "";
  const transition = document.startViewTransition(async () => {
    paintTheme(next, false);
    await syncFrameTheme(next);
  });
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 620, easing: "cubic-bezier(0.3, 0, 0.1, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {});
  // The tick waits for the new theme to finish opening, so its spark is not cut off by the spreading edge.
  transition.finished.finally(() => {
    delete root.dataset.themeSwap;
    pitch.complete("theme", { x, y });
  });
});

$("#extras").innerHTML = EXTRAS.map((x) => `<li>${i(x.icon)}<b>${x.title}</b><span>${x.text}</span></li>`).join("");

// ---------------- copyable commands ----------------
function codeBlock(el: HTMLElement, lines: string[]) {
  el.innerHTML = `<pre>${lines.map((l) => `<span>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`).join("\n")}</pre><button type="button" aria-label="复制命令">${i("copy")}</button>`;
  el.querySelector("button")!.addEventListener("click", async (e) => {
    const button = e.currentTarget as HTMLElement;
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      button.innerHTML = i("check");
      toast("已复制");
      setTimeout(() => (button.innerHTML = i("copy")), 1600);
    } catch {
      toast("复制失败，请手动选择文本");
    }
  });
}
codeBlock($("#src-cmd"), SOURCE_COMMANDS);
codeBlock($("#mac-cmd"), [MAC_QUARANTINE_COMMAND]);

// ---------------- download ----------------
const osIcon = (asset: Asset) => (asset.platform === "mac-arm64" ? icon.apple : asset.platform.startsWith("linux-") ? i("terminal") : icon.windows);

Promise.all([loadRelease(), detectPlatform()]).then(([release, platform]) => {
  const mine = release.assets.find((a) => a.platform === platform);
  const old = predatesWorkbench(release);

  $("#dl-ver").textContent = `最新版本 ${release.version}，发布于 ${release.date}`;
  $("#dl-list").innerHTML = release.assets
    .map((a) => `<li${a === mine ? " data-mine" : ""}><a href="${a.url}"><span class="i">${osIcon(a)}</span><b>${a.label}</b><span>${a.requires}</span><em>${formatSize(a.bytes)}</em>${i("download")}</a></li>`)
    .join("");

  const label = mine ? `下载 ${mine.label} 版` : "查看全部安装包";
  $$<HTMLAnchorElement>("[data-dl-primary]").forEach((a) => {
    const top = a.classList.contains("top-dl");
    if (mine && !top) a.href = mine.url;
    else if (!mine && a.id === "dl-main") a.href = release.page;
    const text = a.querySelector("[data-dl-label]");
    if (text) text.textContent = top ? "下载" : label;
    const mark = a.querySelector("[data-dl-icon]");
    if (mark) mark.innerHTML = mine ? osIcon(mine) : icon.download;
  });

  // Under the hero button: one line saying what this download is. The other installers are a link away.
  const fact = (text: string, cls = "") => Object.assign(document.createElement("span"), { textContent: text, className: cls });
  $("#cta-meta").replaceChildren(
    fact(`v${release.version}`),
    ...(mine ? [fact(formatSize(mine.bytes), "wide"), fact(mine.requires)] : [fact([...new Set(release.assets.map((a) => a.label.split(" · ")[0]))].join(" / "))]),
  );
  $("#dl-req").textContent = mine ? `${mine.requires}，${formatSize(mine.bytes)}` : "本机系统没有对应的安装包，可以从源码运行。";

  if (old) {
    const pending = $("#dl-pending");
    pending.hidden = false;
    pending.innerHTML = `本页介绍的窗口化工作台属于 ${WORKBENCH_VERSION}，它的安装包还没有发布，现在下载到的是 ${release.version}。想先用上新工作台，可以按右侧的命令从源码运行 <a href="${REPO_URL}/tree/${WORKBENCH_VERSION}">${WORKBENCH_VERSION} 分支</a>，或者在 <a href="${RELEASES_URL}">Releases</a> 等待新版本。`;
  }
});
}
