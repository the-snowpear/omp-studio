import "./style.css";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import {
  CHANGELOG_URL,
  INSTALL_NOTES,
  REPO_URL,
  SNAPSHOT,
  detectPlatform,
  formatSize,
  loadRelease,
  type Platform,
  type Release,
} from "../shared/release";
import { createTour, type TourHost } from "./tour";

gsap.registerPlugin(ScrollTrigger);

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const html = document.documentElement;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const isLive = html.dataset.embed === "live";
const isStage = html.dataset.layout === "stage";

/** The app's --ease-nav. Decelerates with a long tail and never overshoots. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const f = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
  return (x: number) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 18; i++) {
      const t = (lo + hi) / 2;
      if (f(x1, x2, t) < x) lo = t;
      else hi = t;
    }
    return f(y1, y2, (lo + hi) / 2);
  };
}
const easeNav = bezier(0.32, 0.72, 0, 1);

/* ---------- Smooth scroll ---------- */
let lenis: Lenis | null = null;
if (!reduced) {
  lenis = new Lenis({ lerp: 0.12, wheelMultiplier: 1 });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis?.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}
const scrollToY = (y: number, onComplete?: () => void) => {
  if (lenis) lenis.scrollTo(y, { duration: 1.3, easing: easeNav, onComplete });
  else {
    window.scrollTo(0, y);
    onComplete?.();
  }
};

/* ---------- Window and embed ---------- */
const win = $("#win");
const winBody = $("#winBody");
const screen = $("#winScreen");
const poster = $<HTMLImageElement>("#winPoster");
const ring = $("#winRing");
const shield = $<HTMLButtonElement>("#winShield");
const railNote = $("#railNote");
const defaultNote = railNote.innerHTML;
let frame: HTMLIFrameElement | null = null;
let settled = !isStage;

const stillOf = (route: string) => `../media/still/${route}-${html.dataset.theme}.webp`;
const appDoc = (): Document | null => {
  try {
    const d = frame?.contentDocument;
    return d?.documentElement?.dataset.qaReady === "true" ? d : null;
  } catch {
    return null;
  }
};

function syncAppTheme(): void {
  const d = appDoc();
  const want = html.dataset.theme ?? "light";
  if (!d || d.documentElement.dataset.theme === want) return;
  d.querySelector<HTMLButtonElement>("button[aria-label*='主题']")?.click();
  // Pages without the toolbar button still honour the attribute.
  if (d.documentElement.dataset.theme !== want) d.documentElement.dataset.theme = want;
}

function mountEmbed(): void {
  if (!isLive || frame) return;
  frame = document.createElement("iframe");
  frame.title = "OMP Studio 真实界面（演示数据）";
  frame.tabIndex = -1;
  frame.inert = true;
  frame.src = `../live/preview-app-harness.html?preview=1&marks=off&theme=${html.dataset.theme}&lang=zh`;
  screen.prepend(frame);
  const started = performance.now();
  const wait = () => {
    if (appDoc()) {
      syncAppTheme();
      // Two frames so the first paint of the app sits under the poster before it fades.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        win.classList.add("is-ready");
        tour.onReady();
      }));
      const d = appDoc();
      d?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") deactivate(); });
      return;
    }
    if (performance.now() - started < 30_000) setTimeout(wait, 120);
  };
  wait();
}

/* ---------- Taking over the window ---------- */
let leaveTimer = 0;
function activate(): void {
  if (!frame || !appDoc()) return;
  tour.stopByUser();
  tour.release();
  win.classList.add("is-active");
  frame.inert = false;
  frame.tabIndex = 0;
  frame.focus();
  gsap.to(ring, { opacity: 0, duration: 0.25 });
  railNote.textContent = "现在是你在操作。按 Esc 或把指针移出窗口就回到页面。";
}
function deactivate(): void {
  if (!win.classList.contains("is-active") || !frame) return;
  win.classList.remove("is-active");
  frame.inert = true;
  frame.tabIndex = -1;
  railNote.innerHTML = defaultNote;
  shield.focus({ preventScroll: true });
}
shield.addEventListener("click", () => {
  if (isStage && !settled) scrollToY(settleY(), activate);
  else activate();
});
win.addEventListener("pointerleave", () => {
  clearTimeout(leaveTimer);
  if (win.classList.contains("is-active") && !win.classList.contains("is-resizing")) leaveTimer = window.setTimeout(deactivate, 500);
});
win.addEventListener("pointerenter", () => clearTimeout(leaveTimer));
addEventListener("keydown", (e) => { if (e.key === "Escape") deactivate(); });

/* ---------- Tour ---------- */
const host: TourHost = {
  doc: appDoc,
  ring,
  ease: easeNav,
  isLive,
  isFlow: !isStage,
  reduced,
  showStill: (route) => {
    if (!isLive) swapPoster(stillOf(route));
  },
};
const tour = createTour(host, $("#chapters"), $("#tourToggle"));

function swapPoster(src: string): void {
  if (poster.getAttribute("src") === src) return;
  const next = new Image();
  next.src = src;
  next.decode().catch(() => undefined).finally(() => {
    poster.style.opacity = "0";
    setTimeout(() => {
      poster.src = src;
      poster.style.opacity = "1";
    }, reduced ? 0 : 220);
  });
}

/* ---------- Resize grip: the app reflows for real ---------- */
const sizeOut = $<HTMLOutputElement>("#winSize");
function bindResize(): void {
  if (!isLive) return;
  const MIN_W = 620;
  const MIN_H = 420;
  for (const grip of $$("[data-resize]", win)) {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const mode = grip.dataset.resize ?? "";
      const start = { x: e.clientX, y: e.clientY, w: win.offsetWidth, h: win.offsetHeight };
      const stageBox = win.parentElement?.getBoundingClientRect();
      const left = win.getBoundingClientRect().left - (stageBox?.left ?? 0);
      const top = win.offsetTop;
      const pad = parseFloat(getComputedStyle(win).right) || 24;
      const maxW = (stageBox?.width ?? innerWidth) - left - (isStage ? pad : 0);
      const maxH = isStage ? (stageBox?.height ?? innerHeight) - top - 96 : innerHeight * 0.9;
      grip.setPointerCapture(e.pointerId);
      win.classList.add("is-resizing");
      tour.stopByUser();
      const move = (ev: PointerEvent) => {
        const w = mode.includes("r") ? Math.min(maxW, Math.max(MIN_W, start.w + ev.clientX - start.x)) : start.w;
        const h = mode.includes("b") ? Math.min(maxH, Math.max(MIN_H, start.h + ev.clientY - start.y)) : start.h;
        win.style.right = "auto";
        win.style.bottom = "auto";
        win.style.width = `${w}px`;
        win.style.height = `${h}px`;
        sizeOut.textContent = `${Math.round(w - 16)} × ${Math.round(h - 16)}`;
      };
      const up = () => {
        win.classList.remove("is-resizing");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        ScrollTrigger.refresh();
      };
      sizeOut.textContent = `${Math.round(start.w - 16)} × ${Math.round(start.h - 16)}`;
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
    // Double click returns the window to its resting size.
    grip.addEventListener("dblclick", () => {
      for (const p of ["right", "bottom", "width", "height"] as const) win.style[p] = "";
    });
  }
}

/* ---------- Scroll stage: tilted to flat, copy out, rail in ---------- */
const track = $("#top");
const SETTLE = 0.52;
const settleY = () => track.offsetTop + (track.offsetHeight - innerHeight) * SETTLE;

function bindStage(): void {
  const copy = $(".hero-copy");
  const rail = $(".rail");
  const tl = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: {
      trigger: track,
      start: "top top",
      end: "bottom bottom",
      scrub: true,
      invalidateOnRefresh: true,
      onUpdate: (st) => {
        const now = st.progress >= SETTLE - 0.005;
        if (now !== settled) {
          settled = now;
          win.classList.toggle("is-settled", now);
          tour.setInView(now && st.isActive);
          if (!now) deactivate();
        }
      },
      onToggle: (st) => tour.setInView(st.isActive && settled),
    },
  });
  const startX = () => innerWidth * 0.5 - win.offsetLeft;
  tl.fromTo(
    win,
    { x: startX, y: () => innerHeight * 0.05, rotationY: -20, rotationX: 7, rotationZ: -1.4, scale: 0.92 },
    { x: 0, y: 0, rotationY: 0, rotationX: 0, rotationZ: 0, scale: 1, duration: SETTLE, ease: "sine.inOut" },
    0,
  );
  tl.fromTo(winBody, { "--thick": 1 }, { "--thick": 0, duration: SETTLE * 0.8, ease: "sine.in" }, SETTLE * 0.2);
  tl.to(copy, { y: -70, autoAlpha: 0, duration: 0.2, ease: "sine.in" }, 0.02);
  tl.fromTo(rail, { autoAlpha: 0, y: 22 }, { autoAlpha: 1, y: 0, duration: 0.2, ease: "sine.out" }, 0.25);
  tl.to({}, { duration: 1 - SETTLE }, SETTLE);

  // Pointer parallax while the window is still tilted; fades out as it settles.
  const rx = gsap.quickTo(winBody, "rotationX", { duration: 1.1, ease: "power3.out" });
  const ry = gsap.quickTo(winBody, "rotationY", { duration: 1.1, ease: "power3.out" });
  addEventListener("pointermove", (e) => {
    const k = Math.max(0, 1 - tl.progress() / 0.2);
    rx(((e.clientY / innerHeight) - 0.5) * -3.2 * k);
    ry(((e.clientX / innerWidth) - 0.5) * 4.2 * k);
  }, { passive: true });
}

function bindEntrance(): void {
  if (reduced) return;
  const lines = $$(".hero-title .line > span");
  const tl = gsap.timeline({ defaults: { ease: easeNav } });
  tl.from(lines, { yPercent: 108, duration: 1.25, stagger: 0.09 }, 0.1);
  tl.from([".hero-sub", ".hero-cta", ".brand"], { y: 18, autoAlpha: 0, duration: 1.1, stagger: 0.08 }, 0.42);
  tl.from(winBody, { y: 70, autoAlpha: 0, duration: 1.5 }, 0.15);
  tl.from(".dock", { y: 28, autoAlpha: 0, duration: 1.1, clearProps: "transform,opacity,visibility" }, 0.75);
}

/* ---------- Reveal, video, specular ---------- */
function bindReveals(): void {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });
  $$(".reveal").forEach((el, i) => {
    el.style.setProperty("--d", `${(i % 3) * 70}ms`);
    io.observe(el);
  });
}

function bindVideos(): void {
  if (reduced) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target as HTMLVideoElement;
      if (e.isIntersecting) {
        if (!v.src && v.dataset.src) v.src = v.dataset.src;
        void v.play().catch(() => undefined);
      } else {
        v.pause();
      }
    }
  }, { threshold: 0.3 });
  $$<HTMLVideoElement>("video[data-src]").forEach((v) => io.observe(v));
}

function bindSpecular(): void {
  document.addEventListener("pointermove", (e) => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>(".plaster");
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }, { passive: true });
}

/* ---------- Dock magnification: transforms only, outside any render loop ---------- */
function bindDock(): void {
  const dock = $("#dock");
  const bg = $("#dockBg");
  const items = $$<HTMLElement>(".dock-item, .dock-sep", dock);
  const cs = () => parseFloat(getComputedStyle(dock).getPropertyValue("--s")) || 50;
  const GAP = 7;
  const SEP = 12;
  const canMagnify = matchMedia("(hover: hover) and (pointer: fine) and (min-width: 900px)").matches && !reduced;
  let pointer: number | null = null;
  let raf = 0;
  const scale = items.map(() => 1);

  const layout = () => {
    const base = cs();
    const widths = items.map((el, i) => (el.classList.contains("dock-sep") ? SEP : base * scale[i]));
    const total = widths.reduce((a, b) => a + b + GAP, -GAP);
    let x = -total / 2;
    items.forEach((el, i) => {
      const center = x + widths[i] / 2;
      if (el.classList.contains("dock-sep")) el.style.transform = `translateX(${center}px)`;
      else {
        el.style.transform = `translateX(${center}px) scale(${scale[i]})`;
        el.style.setProperty("--inv", String(1 / scale[i]));
      }
      x += widths[i] + GAP;
    });
    bg.style.width = `${total + 18}px`;
  };

  const restCenters = () => {
    const base = cs();
    const total = items.reduce((a, el) => a + (el.classList.contains("dock-sep") ? SEP : base) + GAP, -GAP);
    let x = dock.getBoundingClientRect().left - total / 2;
    return items.map((el) => {
      const w = el.classList.contains("dock-sep") ? SEP : base;
      const c = x + w / 2;
      x += w + GAP;
      return c;
    });
  };

  const tick = () => {
    const centers = restCenters();
    let moving = false;
    items.forEach((el, i) => {
      let target = 1;
      if (pointer !== null && !el.classList.contains("dock-sep")) {
        const d = (pointer - centers[i]) / (cs() * 1.9);
        target = 1 + 0.62 * Math.exp(-d * d);
      }
      scale[i] += (target - scale[i]) * 0.22;
      if (Math.abs(target - scale[i]) > 0.002) moving = true;
      else scale[i] = target;
    });
    layout();
    raf = moving ? requestAnimationFrame(tick) : 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

  layout();
  addEventListener("resize", layout);
  if (canMagnify) {
    dock.addEventListener("pointermove", (e) => { pointer = e.clientX; kick(); });
    dock.addEventListener("pointerleave", () => { pointer = null; kick(); });
  }

  for (const a of $$<HTMLAnchorElement>("a.dock-item", dock)) {
    a.addEventListener("click", (e) => {
      const id = a.dataset.section ?? "";
      const t = document.getElementById(id);
      if (!t) return;
      e.preventDefault();
      scrollToY(t.getBoundingClientRect().top + scrollY);
    });
  }

  // Active section marker
  const sections = $$<HTMLElement>("[data-section]", dock);
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      for (const s of sections) s.classList.toggle("on", s.dataset.section === e.target.id);
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  sections.forEach((s) => { const t = document.getElementById(s.dataset.section ?? ""); if (t) spy.observe(t); });
}

/* ---------- Theme: page and embedded app flip together ---------- */
function applyTheme(next: "light" | "dark"): void {
  html.dataset.theme = next;
  try { localStorage.setItem("omp-site-theme", next); } catch { /* private mode */ }
  $<HTMLMetaElement>("meta[name=theme-color]").content = next === "dark" ? "#141319" : "#f3f1f6";
  $("#themeBtn").dataset.label = next === "dark" ? "切换浅色" : "切换深色";
  if (isLive) {
    poster.src = stillOf("workbench");
    syncAppTheme();
  } else {
    tour.refreshStill();
  }
}

function bindTheme(): void {
  const btn = $<HTMLButtonElement>("#themeBtn");
  applyLabels();
  btn.addEventListener("click", async (e) => {
    const next = html.dataset.theme === "dark" ? "light" : "dark";
    const doc = document as Document & { startViewTransition?: (cb: () => Promise<void> | void) => { ready: Promise<void> } };
    if (!doc.startViewTransition || reduced) {
      applyTheme(next);
      return;
    }
    const r = btn.getBoundingClientRect();
    const x = e.clientX || r.left + r.width / 2;
    const y = e.clientY || r.top + r.height / 2;
    const vt = doc.startViewTransition(async () => {
      applyTheme(next);
      // rAF does not fire while the transition holds rendering; give the app's React commit a beat.
      await new Promise((res) => setTimeout(res, 40));
    });
    try {
      await vt.ready;
    } catch {
      return;
    }
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    html.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 780, easing: "cubic-bezier(0.32, 0.72, 0, 1)", pseudoElement: "::view-transition-new(root)" },
    );
  });
}
function applyLabels(): void {
  $("#themeBtn").dataset.label = html.dataset.theme === "dark" ? "切换浅色" : "切换深色";
  if (html.dataset.theme === "dark") {
    poster.src = stillOf("workbench");
    $<HTMLMetaElement>("meta[name=theme-color]").content = "#141319";
  }
}

/* ---------- Providers ---------- */
function bindMarquee(): void {
  const names = ["deepseek", "gemini", "kimi", "qwen", "mistral", "minimax", "zhipu", "nvidia", "azure", "cloudflare", "together", "fireworks", "perplexity", "cerebras", "siliconflow", "alibaba", "litellm"];
  const box = $("#marquee");
  const tile = (n: string) => `<div class="logo-tile" title="${n}"><i style="--logo:url(../live/brands/${n}.svg)"></i></div>`;
  const row = names.map(tile).join("");
  box.innerHTML = `<div class="marquee-track">${row}${reduced ? "" : row}</div>`;
  if (reduced) return;
  const track = $(".marquee-track", box);
  const tw = gsap.to(track, { xPercent: -50, duration: 70, ease: "none", repeat: -1, paused: true });
  new IntersectionObserver(([e]) => { if (e?.isIntersecting) tw.play(); else tw.pause(); }).observe(box);
  box.addEventListener("pointerenter", () => gsap.to(tw, { timeScale: 0.2, duration: 0.6 }));
  box.addEventListener("pointerleave", () => gsap.to(tw, { timeScale: 1, duration: 0.6 }));
}

/* ---------- Bridge: one packet walks the real call path ---------- */
function bindChain(): void {
  const pulse = $("#chainPulse");
  const chain = $("#chain");
  if (reduced || !pulse || getComputedStyle(pulse).display === "none") {
    if (pulse) pulse.style.display = "none";
    return;
  }
  const tw = gsap.fromTo(pulse, { left: "2%", opacity: 0 }, {
    left: "88%", duration: 2.6, ease: "sine.inOut", repeat: -1, repeatDelay: 0.5, paused: true,
    keyframes: { opacity: [0, 1, 1, 1, 0] },
  });
  new IntersectionObserver(([e]) => { if (e?.isIntersecting) tw.play(); else tw.pause(); }).observe(chain);
}

/* ---------- Download ---------- */
function bindKeys(): void {
  if (reduced || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  for (const key of $$<HTMLElement>(".key")) {
    const rx = gsap.quickTo(key, "rotationX", { duration: 0.7, ease: "power3.out" });
    const ry = gsap.quickTo(key, "rotationY", { duration: 0.7, ease: "power3.out" });
    key.addEventListener("pointermove", (e) => {
      const r = key.getBoundingClientRect();
      rx(((e.clientY - r.top) / r.height - 0.5) * -7);
      ry(((e.clientX - r.left) / r.width - 0.5) * 7);
    });
    key.addEventListener("pointerleave", () => { rx(0); ry(0); });
  }
}

function renderDownload(rel: Release, platform: Platform | null): void {
  const assets = [...rel.assets];
  const primary = assets.find((a) => a.platform === platform);
  if (primary) assets.sort((a, b) => Number(b === primary) - Number(a === primary));
  const keys = $("#keys");
  keys.innerHTML = assets.map((a) => `
    <div class="key-well reveal in${a === primary ? " key-primary-well" : ""}">
      <a class="key${a === primary ? " key-primary" : ""}" href="${a.url}" download>
        <div>
          ${a === primary ? '<span class="key-tag">适合这台电脑</span>' : ""}
          <div class="key-name">${a.label}</div>
          <div class="key-detail">${a.detail}</div>
        </div>
        <div class="key-foot"><span class="key-go">下载</span><span class="key-size">${formatSize(a.bytes)}</span></div>
      </a>
    </div>`).join("");
  if (!primary) keys.style.gridTemplateColumns = "";
  $("#dlMeta").innerHTML = `当前版本 ${rel.version}，发布于 ${rel.publishedAt}。<a href="${rel.notesUrl}" target="_blank" rel="noopener">发行说明</a>，<a href="${CHANGELOG_URL}" target="_blank" rel="noopener">更新日志</a>。`;
  $("#noteWin").innerHTML = `<b>Windows</b> ${INSTALL_NOTES.win}`;
  $("#noteMac").innerHTML = `<b>macOS</b> ${INSTALL_NOTES.mac}`;
  if (rel.stars !== null) $("#repoLink").textContent = `查看源码（${rel.stars} 星）`;
  $("#repoLink").setAttribute("href", REPO_URL);

  // The hero button goes straight to the matching installer, otherwise to the options.
  const hero = $<HTMLAnchorElement>("[data-download]");
  if (primary) {
    hero.href = primary.url;
    hero.setAttribute("download", "");
  } else {
    hero.href = "#download";
    hero.removeAttribute("download");
  }
  bindKeys();
}

function bindCopy(): void {
  const btn = $<HTMLButtonElement>("#copyCmd");
  btn.addEventListener("click", async () => {
    const text = $("#srcCmd").textContent ?? "";
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const sel = getSelection();
      const range = document.createRange();
      range.selectNodeContents($("#srcCmd"));
      sel?.removeAllRanges();
      sel?.addRange(range);
      ok = document.execCommand("copy");
      sel?.removeAllRanges();
    }
    btn.textContent = ok ? "已复制" : "复制失败，请手动选中";
    btn.classList.toggle("done", ok);
    setTimeout(() => {
      btn.textContent = "复制";
      btn.classList.remove("done");
    }, 1800);
  });
}

/* ---------- Boot ---------- */
async function boot(): Promise<void> {
  bindTheme();
  bindReveals();
  bindVideos();
  bindSpecular();
  bindDock();
  bindMarquee();
  bindChain();
  bindCopy();
  bindResize();
  if (isStage) bindStage();
  else new IntersectionObserver(([e]) => tour.setInView(Boolean(e?.isIntersecting)), { threshold: 0.2 }).observe(win);
  bindEntrance();
  tour.start();

  // The layout is decided before first paint, so crossing the breakpoint needs a fresh start.
  matchMedia("(min-width: 900px) and (min-height: 600px)").addEventListener("change", () => location.reload());

  const heroDownload = $<HTMLAnchorElement>("[data-download]");
  heroDownload.addEventListener("click", (e) => {
    if (heroDownload.getAttribute("href") === "#download") {
      e.preventDefault();
      const t = document.getElementById("download");
      if (t) scrollToY(t.getBoundingClientRect().top + scrollY);
    }
  });

  // Paint real links from the snapshot immediately, then refresh from GitHub.
  const platform = await detectPlatform();
  renderDownload(SNAPSHOT, platform);
  void loadRelease().then((rel) => { if (rel !== SNAPSHOT) renderDownload(rel, platform); });

  // The embed is heavy: start it once the page itself has finished loading and is idle.
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  const start = () => (idle ? idle(mountEmbed, { timeout: 1500 }) : setTimeout(mountEmbed, 500));
  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
  await document.fonts?.ready;
  ScrollTrigger.refresh();
}

void boot();
