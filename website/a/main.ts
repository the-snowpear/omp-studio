import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "./style.css";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { INSTALL_NOTES, RELEASES_URL, SNAPSHOT, detectPlatform, formatSize, loadRelease, type Asset, type Platform, type Release } from "../shared/release";
import { createGlass } from "./glass";
import windowsIcon from "@phosphor-icons/core/assets/fill/windows-logo-fill.svg?raw";
import appleIcon from "@phosphor-icons/core/assets/fill/apple-logo-fill.svg?raw";
import githubIcon from "@phosphor-icons/core/assets/fill/github-logo-fill.svg?raw";
import arrowIcon from "@phosphor-icons/core/assets/bold/arrow-down-bold.svg?raw";

gsap.registerPlugin(ScrollTrigger);

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;
const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => Array.from(root.querySelectorAll(s)) as T[];
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const CHAPTERS = [
  { id: "plan", tab: "计划与审批", title: "计划先过目，再动手", body: "Plan 预览可以逐段批注，批准后才执行。Ask 卡片和权限档位把决定权留给你。" },
  { id: "hub", tab: "Agent Hub", title: "每个子 Agent 都看得见", body: "名册里盯状态、花费和上下文占用。选中一个，看血缘和实时记录，能恢复也能终止。" },
  { id: "tokens", tab: "Token 与成本", title: "这一轮花了多少，一眼算清", body: "顶栏展开用量、缓存命中和 Context 构成，首页有按年月周切换的曲线和热力图。" },
  { id: "models", tab: "模型与角色", title: "60+ 供应商，一页管完", body: "开关、端点和优先顺序同页完成。@default、@plan、@task 各配模型和思考强度。" },
  { id: "caps", tab: "能力中心", title: "Skills、MCP、Slash 收在一处", body: "Skills、Plugins、MCP、Slash Commands 同一页开关、探测和打开目录。" },
  { id: "git", tab: "Git", title: "Git 就在对话旁边", body: "暂存、看 diff、写 commit，Fetch、Pull、Push 和提交图都不用离开工作台。" },
] as const;

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Full choreography needs a wide viewport and a real pointer. Everything else gets the plain document flow. */
const full = matchMedia("(min-width: 900px) and (pointer: fine)").matches && !reduced;
document.documentElement.classList.add(full ? "is-full" : "is-plain");

/* Smooth scroll, driven by GSAP's ticker so pins and scrubs share one clock. */
let lenis: Lenis | null = null;
if (full) {
  lenis = new Lenis({ lerp: 0.11, wheelMultiplier: 0.9 });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis?.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}
const jump = (target: string) => {
  const el = $(target);
  if (!el) return;
  if (lenis) lenis.scrollTo(el, { duration: 1.6, easing: (t) => 1 - Math.pow(1 - t, 3) });
  else el.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
};
for (const a of $$<HTMLAnchorElement>('a[href^="#"]')) {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    jump(a.getAttribute("href")!);
  });
}

/* Glass π: hero and the download finale share one fixed canvas. Each owns its own state, so the
   hero's scrub is never disturbed; the ticker copies whichever scene is showing. */
const canvas = $<HTMLCanvasElement>("#glass");
const glass = createGlass(canvas);
/* Shader space to CSS pixels: the mark is .95 units tall from centre, the lens focal length 1.85. */
const uvPerPx = () => 1.25 / Math.min(innerWidth, innerHeight * 1.25);
const camForHalfHeight = (px: number) => (0.95 * 1.85) / (uvPerPx() * px);
const isWide = () => innerWidth >= 900;
/* Wide: the mark takes the right quarter, clear of the headline. Narrow: above the copy. */
const heroPose = () =>
  isWide()
    ? { shiftX: (innerWidth * 0.24) * uvPerPx(), shiftY: -0.02, cam: camForHalfHeight(Math.min(innerHeight * 0.33, innerWidth * 0.17)) }
    : { shiftX: 0, shiftY: (innerHeight * 0.2) * uvPerPx(), cam: camForHalfHeight(118) };
const shift0 = heroPose();
const heroScene = { fly: 0, shiftX: shift0.shiftX, shiftY: shift0.shiftY, cam: shift0.cam, intro: 0 };
/* In the finale the mark sits in the section's top space and scrolls with it, like any other content. */
const finalAnchor = () => $(".final-inner").getBoundingClientRect().top + parseFloat(getComputedStyle($(".final-inner")).paddingTop) / 2;
const finalCam = () => camForHalfHeight(isWide() ? 150 : 104);
const finalScene = { fly: 0, shiftX: 0, shiftY: 0, cam: finalCam() + 4, intro: 0 };
let heroOn = true;
let finalOn = false;
const syncGlass = () => {
  if (!glass) return;
  if (finalOn) finalScene.shiftY = (innerHeight / 2 - finalAnchor()) * uvPerPx();
  const scene = finalOn ? finalScene : heroScene;
  const out = glass.state;
  out.fly = scene.fly;
  out.shiftX = scene.shiftX;
  out.shiftY = scene.shiftY;
  out.cam = scene.cam;
  out.intro = scene.intro;
  if (reduced) glass.renderOnce();
  else glass.setActive(heroOn || finalOn);
};
if (glass) {
  if (reduced) {
    heroScene.intro = 1;
    finalScene.intro = 1;
    finalScene.cam = finalCam();
  } else {
    gsap.to(heroScene, { intro: 1, duration: 1.8, ease: "power2.out", delay: 0.1 });
    gsap.fromTo(heroScene, { cam: shift0.cam + 2.6 }, { cam: shift0.cam, duration: 2.4, ease: "expo.out" });
    gsap.ticker.add(syncGlass);
  }
  syncGlass();
  /* An observer, not a ScrollTrigger: it can't be fooled by page lengths measured while pins are reverted. */
  new IntersectionObserver((entries) => {
    finalOn = entries[0]!.isIntersecting;
    if (finalOn && !reduced) gsap.fromTo(finalScene, { cam: finalCam() + 4, intro: 0 }, { cam: finalCam(), intro: 1, duration: 2.2, ease: "expo.out", overwrite: true });
    syncGlass();
  }, { rootMargin: "0px 0px -12% 0px" }).observe($(".final"));
  if (reduced) addEventListener("scroll", () => finalOn && syncGlass(), { passive: true });
  if (!full) {
    new IntersectionObserver((e) => {
      heroOn = e[0]!.isIntersecting;
      syncGlass();
    }).observe($(".hero"));
  }
} else {
  canvas.remove();
  document.documentElement.classList.add("no-glass");
}

/* Hero entrance: lines rise out of a mask; copy follows. */
if (!reduced) {
  document.fonts.ready.then(() => {
    gsap.from(".hero h1 .ln > span", { yPercent: 112, duration: 1.15, ease: "expo.out", stagger: 0.09, delay: 0.15 });
    gsap.from(".hero-sub, .hero-cta", { opacity: 0, y: 18, duration: 1, ease: "power3.out", stagger: 0.08, delay: 0.5 });
    gsap.from(".nav", { opacity: 0, y: -10, duration: 0.9, ease: "power2.out", delay: 0.7 });
  });
}

if (full) {
  /* Hero scrub: the headline lifts away while the camera flies through the arch of the π. */
  const hero = gsap.timeline({
    scrollTrigger: {
      trigger: ".hero", start: "top top", end: "+=130%", pin: true, scrub: true, anticipatePin: 1,
      onToggle: (self) => {
        heroOn = self.isActive;
        syncGlass();
      },
    },
  });
  hero.to(".hero-copy", { y: -80, opacity: 0, duration: 0.35, ease: "power1.in" }, 0);
  if (glass) {
    hero.to(heroScene, { fly: 1, shiftX: 0, shiftY: 0, duration: 1, ease: "power2.in" }, 0);
    /* The scrub only owns fly and the drift; resizing re-aims the mark from the new layout. */
    addEventListener("resize", () => {
      const pose = heroPose();
      heroScene.cam = pose.cam;
      if (scrollY < 2) Object.assign(heroScene, { shiftX: pose.shiftX, shiftY: pose.shiftY });
      hero.invalidate();
      ScrollTrigger.refresh();
    });
  }

  buildPassage();
  buildChapters();

  /* Bridge: the strike-throughs draw as they enter; the line fills with progress; packets loop only here. */
  gsap.from(".nope s", { "--strike": 0, duration: 0.9, ease: "power3.inOut", stagger: 0.14, scrollTrigger: { trigger: ".nope", start: "top 78%" } });
  gsap.fromTo(".pipe-fill", { scaleX: 0 }, { scaleX: 1, ease: "none", scrollTrigger: { trigger: ".pipe", start: "top 86%", end: "top 40%", scrub: true } });
  gsap.from(".pipe li", { opacity: 0, y: 18, duration: 0.8, ease: "power3.out", stagger: 0.07, scrollTrigger: { trigger: ".pipe", start: "top 72%" } });
  const down = gsap.fromTo(".pk-down", { left: "0%" }, { left: "100%", duration: 2.8, ease: "none", repeat: -1, repeatDelay: 0.5, paused: true });
  const up = gsap.fromTo(".pk-up", { left: "100%" }, { left: "0%", duration: 2.8, ease: "none", repeat: -1, repeatDelay: 0.5, delay: 1.5, paused: true });
  ScrollTrigger.create({ trigger: ".bridge", start: "top bottom", end: "bottom top", onToggle: (s) => (s.isActive ? (down.play(), up.play()) : (down.pause(), up.pause())) });
  gsap.from(".laws > div", { opacity: 0, y: 22, duration: 0.8, ease: "power3.out", stagger: 0.08, scrollTrigger: { trigger: ".laws", start: "top 84%" } });

  /* Plain reveals. */
  gsap.from(".more-title", { opacity: 0, y: 28, duration: 1, ease: "power3.out", scrollTrigger: { trigger: ".more-title", start: "top 85%" } });
  gsap.from(".tile", { opacity: 0, y: 48, duration: 1, ease: "power3.out", stagger: 0.07, scrollTrigger: { trigger: ".mosaic", start: "top 80%" } });
  gsap.from(".final-inner > *", { opacity: 0, y: 26, duration: 0.9, ease: "power3.out", stagger: 0.06, scrollTrigger: { trigger: ".final-inner", start: "top 70%" } });
} else {
  buildChaptersPlain();
}

/* ------------------------------------------------------------------ passage */
function buildPassage(): void {
  const world = $(".world");
  const win = $("#win");
  const seq = $<HTMLCanvasElement>("#seq");
  const ctx = seq.getContext("2d", { alpha: false })!;
  const says = $$("[data-say]");
  const caps = $$("[data-cap]");

  /* The chaos: what a working day looks like before Studio. Typographic stand-ins, not product UI. */
  const PANELS: { t: string; b: string; web?: boolean }[] = [
    { t: "tmux: agent-1", b: "$ omp\n> 修一下 TS2322\n  thinking...\n  bash: npm run typecheck\n  error TS2322: Type 'string' is\n  not assignable to type 'number'" },
    { t: "provider console", b: "API Keys\nUsage this month\nRate limits\nInvoices", web: true },
    { t: "tmux: agent-2", b: "$ omp --resume\n  which session?\n  3a1f  yesterday\n  9c02  2 days ago\n  77de  last week" },
    { t: "git log --graph", b: "* 13fc431 merge\n|\\\n| * b4431e5 test\n* | 1a95443 test\n|/\n* cb17b74 merge" },
    { t: "pull request", b: "Files changed  12\nConversation  4\nChecks  1 failing", web: true },
    { t: "models.yml", b: "providers:\n  anthropic:\n  openai:\n  openrouter:\nmodelRoles:\n  default:\n  plan:\n  task:" },
    { t: "billing", b: "Credits remaining\nDaily spend\nExport CSV", web: true },
    { t: "zsh", b: "$ git diff --stat\n main.tsx | 3 ++-\n 1 file changed\n$ _" },
    { t: "docs: mcp servers", b: "Configuration\nTransport\nAuthentication", web: true },
    { t: "tmux: agent-3", b: "  subagent spawned\n  subagent spawned\n  ... which one is stuck?" },
    { t: "scratch.md", b: "TODO\n- 问 agent-2 进度\n- 今天花了多少?\n- skill 放哪个目录来着" },
    { t: "dashboard", b: "Tokens\nCache hit\nLatency p95", web: true },
    { t: "htop", b: "PID  CPU%  CMD\n912  38.1  bun\n930  12.4  omp\n954   7.7  node" },
    { t: "zsh", b: "$ tail -f agent.log\n[warn] compact\n[info] tool call\n[info] tool call" },
  ];
  type P = { el: HTMLElement; x: number; y: number; z: number; ry: number };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const TRAVEL = 5600;
  const panels: P[] = [];
  const count = 26;
  for (let i = 0; i < count; i++) {
    const d = PANELS[i % PANELS.length]!;
    const el = document.createElement("div");
    el.className = `panel${d.web ? " panel-web" : ""}`;
    el.innerHTML = `<header>${d.t}</header><pre></pre>`;
    el.querySelector("pre")!.textContent = d.b;
    world.append(el);
    // Keep a corridor down the middle so the camera threads between windows.
    const side = i % 2 ? 1 : -1;
    const x = side * lerp(0.2, 0.62, rnd());
    const y = lerp(-0.42, 0.42, rnd());
    panels.push({ el, x, y, z: -300 - (i / count) * TRAVEL, ry: -side * lerp(8, 26, rnd()) });
  }
  const placePanels = (cam: number) => {
    const W = innerWidth;
    const H = innerHeight;
    for (const p of panels) {
      const z = p.z + cam;
      const o = smooth(-3400, -2200, z) * (1 - smooth(-40, 340, z));
      if (o <= 0.002) {
        if (p.el.style.visibility !== "hidden") p.el.style.visibility = "hidden";
        continue;
      }
      p.el.style.visibility = "visible";
      p.el.style.opacity = o.toFixed(3);
      p.el.style.transform = `translate3d(${(p.x * W).toFixed(1)}px,${(p.y * H).toFixed(1)}px,${z.toFixed(1)}px) rotateY(${p.ry.toFixed(2)}deg)`;
    }
  };

  /* Frames: decode progressively; always draw the nearest one that is ready. */
  const FRAME_COUNT = 170;
  const frames: (HTMLImageElement | null)[] = new Array(FRAME_COUNT).fill(null);
  let shown = -1;
  let wanted = 0;
  const draw = (i: number) => {
    let k = i;
    for (let d = 0; d < FRAME_COUNT; d++) {
      if (frames[i - d]) { k = i - d; break; }
      if (frames[i + d]) { k = i + d; break; }
    }
    if (!frames[k] || k === shown) return;
    ctx.drawImage(frames[k]!, 0, 0, seq.width, seq.height);
    shown = k;
  };
  const loadFrame = async (i: number) => {
    const img = new Image();
    img.src = `../media/seq/chat/${String(i).padStart(4, "0")}.webp`;
    try {
      await img.decode();
      frames[i] = img;
      if (shown < 0 || Math.abs(i - wanted) < Math.abs(shown - wanted)) draw(wanted);
    } catch {
      /* a missing frame just holds the previous one */
    }
  };
  let loading = false;
  const startLoading = async () => {
    if (loading) return;
    loading = true;
    await loadFrame(0);
    // Coarse pass first so any scrub position has something close, then fill in.
    for (const step of [16, 8, 4, 2, 1]) {
      const batch: Promise<void>[] = [];
      for (let i = step; i < FRAME_COUNT; i += step) {
        if (frames[i]) continue;
        batch.push(loadFrame(i));
        if (batch.length >= 6) {
          await Promise.all(batch);
          batch.length = 0;
        }
      }
      await Promise.all(batch);
    }
  };
  ScrollTrigger.create({ trigger: ".passage", start: "top 300%", once: true, onEnter: () => void startLoading() });

  /* Camera inside the window: the frame stays put, the recording pushes in on what matters. */
  const KEYS = [
    { f: 0, s: 1, x: 0.5, y: 0.5 },
    { f: 8, s: 1, x: 0.5, y: 0.5 },
    { f: 20, s: 1.42, x: 0.6, y: 0.3 },
    { f: 66, s: 1.42, x: 0.6, y: 0.4 },
    { f: 80, s: 1.55, x: 0.6, y: 0.42 },
    { f: 98, s: 1.55, x: 0.6, y: 0.42 },
    { f: 112, s: 1.42, x: 0.6, y: 0.5 },
    { f: 135, s: 1.42, x: 0.6, y: 0.38 },
    { f: 156, s: 1.6, x: 0.6, y: 0.55 },
    { f: 169, s: 1.6, x: 0.6, y: 0.55 },
  ];
  const camera = (f: number) => {
    let a = KEYS[0]!;
    let b = KEYS[KEYS.length - 1]!;
    for (let i = 0; i < KEYS.length - 1; i++) {
      if (f >= KEYS[i]!.f && f <= KEYS[i + 1]!.f) { a = KEYS[i]!; b = KEYS[i + 1]!; break; }
    }
    const t = smooth(a.f, b.f, f);
    return { s: lerp(a.s, b.s, t), x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  };

  const CAPS = [[0.325, 0.385], [0.395, 0.56], [0.57, 0.695], [0.705, 0.83], [0.85, 0.955]] as const;
  const FLIGHT_END = 0.21;
  const LAND = [0.2, 0.31] as const;
  const SEQ = [0.31, 0.955] as const;
  const flash = $(".flash");
  const render = (p: number) => {
    flash.style.opacity = String(1 - smooth(0, 0.028, p));
    placePanels(smooth(0, FLIGHT_END + 0.08, p) * (TRAVEL + 500));
    says[0]!.style.opacity = String(smooth(0.005, 0.03, p) * (1 - smooth(0.075, 0.1, p)));
    says[0]!.style.transform = `translateZ(${lerp(-90, 110, smooth(0, 0.1, p)).toFixed(1)}px)`;
    says[1]!.style.opacity = String(smooth(0.1, 0.125, p) * (1 - smooth(0.19, 0.215, p)));
    says[1]!.style.transform = `translateZ(${lerp(-90, 110, smooth(0.1, 0.215, p)).toFixed(1)}px)`;

    const land = smooth(LAND[0], LAND[1], p);
    const out = smooth(0.968, 1, p);
    const z = lerp(-2800, 0, 1 - Math.pow(1 - land, 2.2));
    win.style.opacity = String(smooth(LAND[0], LAND[0] + 0.05, p) * (1 - out));
    win.style.transform = `translate3d(0,${(out * -36).toFixed(1)}px,${z.toFixed(1)}px) rotateX(${((1 - land) * 7).toFixed(2)}deg) scale(${(1 - out * 0.05).toFixed(4)})`;

    const fp = clamp((p - SEQ[0]) / (SEQ[1] - SEQ[0]));
    const f = fp * (FRAME_COUNT - 1);
    wanted = Math.round(f);
    draw(wanted);
    const cam = camera(f);
    const W = seq.clientWidth;
    const H = seq.clientHeight;
    const tx = clamp(W / 2 - cam.x * W * cam.s, W - W * cam.s, 0);
    const ty = clamp(H / 2 - cam.y * H * cam.s, H - H * cam.s, 0);
    seq.style.transform = `translate3d(${tx.toFixed(2)}px,${ty.toFixed(2)}px,0) scale(${cam.s.toFixed(4)})`;

    caps.forEach((el, i) => {
      const [a, b] = CAPS[i]!;
      const v = smooth(a, a + 0.016, p) * (1 - smooth(b - 0.012, b, p));
      el.style.opacity = v.toFixed(3);
      el.style.transform = `translateY(${((1 - v) * 16).toFixed(1)}px)`;
      el.style.visibility = v < 0.004 ? "hidden" : "visible";
    });
  };

  ScrollTrigger.create({
    trigger: ".passage",
    start: "top top",
    end: "+=720%",
    pin: ".stage",
    pinSpacing: true,
    anticipatePin: 1,
    onEnter: () => gsap.set(".stage", { autoAlpha: 1 }),
    onLeaveBack: () => gsap.set(".stage", { autoAlpha: 0 }),
    onUpdate: (self) => render(self.progress),
    onRefresh: (self) => {
      gsap.set(".stage", { autoAlpha: self.progress > 0 || scrollY >= self.start ? 1 : 0 });
      render(self.progress);
    },
  });
  render(0);
}

/* ------------------------------------------------------------------ chapters */

function chapterCard(c: (typeof CHAPTERS)[number]): HTMLElement {
  const el = document.createElement("div");
  el.className = "ch-card";
  el.dataset.id = c.id;
  el.innerHTML = `<div class="ch-tilt"><video muted loop playsinline preload="none" poster="../media/poster/${c.id}.webp" src="../media/clip/${c.id}.mp4" aria-label="${c.tab}录屏"></video></div>`;
  return el;
}

function buildChapters(): void {
  const track = $(".ch-track");
  const titles = $(".ch-titles");
  const tabs = $(".ch-tabs");
  const cards = CHAPTERS.map((c, i) => {
    const el = chapterCard(c);
    track.append(el);
    const t = document.createElement("div");
    t.className = "ch-title";
    t.innerHTML = `<h2>${c.title}</h2><p>${c.body}</p>`;
    titles.append(t);
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = c.tab;
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => {
      const st = trigger;
      if (!st) return;
      const y = st.start + (st.end - st.start) * (i / (CHAPTERS.length - 1));
      lenis?.scrollTo(y, { duration: 1.3, easing: (k) => 1 - Math.pow(1 - k, 3) });
    });
    tabs.append(b);
    return { el, tilt: el.querySelector<HTMLElement>(".ch-tilt")!, video: el.querySelector("video")!, title: t, tab: b };
  });
  const ink = document.createElement("i");
  ink.className = "ch-ink";
  tabs.append(ink);

  let trigger: ScrollTrigger | null = null;
  let active = -1;
  const setActive = (i: number) => {
    if (i === active) return;
    const prev = cards[active];
    prev?.video.pause();
    active = i;
    const cur = cards[i]!;
    if (trigger?.isActive || i === 0) {
      cur.video.currentTime = 0;
      void cur.video.play().catch(() => {});
    }
    cards.forEach((c, k) => {
      c.tab.setAttribute("aria-selected", String(k === i));
    });
    ink.style.width = `${cur.tab.offsetWidth}px`;
    ink.style.transform = `translateX(${cur.tab.offsetLeft}px)`;
  };

  /* Pointer tilt on the centre card only. */
  const tilt = { rx: 0, ry: 0, tx: 0, ty: 0 };
  $(".ch-stage").addEventListener("pointermove", (e) => {
    const ev = e as PointerEvent;
    tilt.ty = ((ev.clientX / innerWidth) * 2 - 1) * 3.2;
    tilt.tx = -((ev.clientY / innerHeight) * 2 - 1) * 2.4;
  });

  const render = (p: number) => {
    const pos = p * (CHAPTERS.length - 1);
    const cw = track.clientWidth;
    cards.forEach((c, i) => {
      const off = i - pos;
      const abs = Math.abs(off);
      const x = off * cw * 0.84;
      const z = -abs * 260;
      const ry = -off * 24;
      c.el.style.transform = `translate3d(${x.toFixed(1)}px,${(abs * 18).toFixed(1)}px,${z.toFixed(1)}px) rotateY(${ry.toFixed(2)}deg)`;
      c.el.style.opacity = String(clamp(1 - (abs - 0.2) * 0.72));
      c.el.style.visibility = abs > 2.1 ? "hidden" : "visible";
      c.el.style.pointerEvents = abs < 0.5 ? "auto" : "none";
      const v = 1 - smooth(0.16, 0.42, abs);
      c.title.style.opacity = v.toFixed(3);
      c.title.style.transform = `translateX(${(off * 90).toFixed(1)}px)`;
      c.title.style.visibility = v < 0.004 ? "hidden" : "visible";
    });
    setActive(Math.round(pos));
  };
  gsap.ticker.add(() => {
    tilt.rx += (tilt.tx - tilt.rx) * 0.06;
    tilt.ry += (tilt.ty - tilt.ry) * 0.06;
    const c = cards[active];
    if (c) c.tilt.style.transform = `rotateX(${tilt.rx.toFixed(3)}deg) rotateY(${tilt.ry.toFixed(3)}deg)`;
  });

  trigger = ScrollTrigger.create({
    trigger: ".chapters",
    start: "top top",
    end: `+=${CHAPTERS.length * 85}%`,
    pin: ".ch-stage",
    anticipatePin: 1,
    snap: { snapTo: 1 / (CHAPTERS.length - 1), duration: { min: 0.25, max: 0.7 }, delay: 0.08, ease: "power2.inOut" },
    onUpdate: (self) => render(self.progress),
    onRefresh: (self) => render(self.progress),
    onToggle: (self) => {
      const c = cards[active];
      if (!c) return;
      if (self.isActive) void c.video.play().catch(() => {});
      else c.video.pause();
    },
  });
  render(0);
}

function buildChaptersPlain(): void {
  const stage = $(".ch-stage");
  stage.innerHTML = "";
  const rail = document.createElement("div");
  rail.className = "ch-rail";
  for (const c of CHAPTERS) {
    const el = document.createElement("article");
    el.innerHTML = `<h2>${c.title}</h2><p>${c.body}</p><video data-lazy data-src="../media/clip/${c.id}.mp4" poster="../media/poster/${c.id}.webp" muted loop playsinline></video>`;
    rail.append(el);
  }
  stage.append(rail);
}

/* ------------------------------------------------------------------ media */
/* Clips only download when near the viewport, and only play while visible. */
function lazyVideos(): void {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target as HTMLVideoElement;
      if (e.isIntersecting) {
        if (!v.src) v.src = v.dataset.src!;
        if (!reduced) void v.play().catch(() => {});
      } else v.pause();
    }
  }, { rootMargin: "200px 0px", threshold: 0.15 });
  for (const v of $$<HTMLVideoElement>("video[data-lazy]")) {
    if (reduced) v.controls = true;
    io.observe(v);
  }
}
lazyVideos();

/* Spotlight border on tiles: the highlight follows the pointer via CSS variables, no re-layout. */
for (const t of $$(".tile")) {
  t.addEventListener("pointermove", (e) => {
    const r = t.getBoundingClientRect();
    const ev = e as PointerEvent;
    t.style.setProperty("--mx", `${ev.clientX - r.left}px`);
    t.style.setProperty("--my", `${ev.clientY - r.top}px`);
  });
}

/* Provider logos, one marquee; the list is doubled so the loop is seamless. */
{
  const names = ["deepseek", "gemini", "mistral", "nvidia", "kimi", "qwen", "zhipu", "alibaba", "azure", "cloudflare", "huggingface", "minimax", "perplexity", "together", "fireworks", "siliconflow", "cerebras"];
  const track = $(".logos-track");
  for (const round of [0, 1]) {
    for (const n of names) {
      const img = document.createElement("img");
      img.src = `../media/brands/${n}.svg`;
      img.alt = round ? "" : n;
      img.width = 34;
      img.height = 34;
      img.loading = "lazy";
      if (n === "kimi") img.className = "logo-ink";
      track.append(img);
    }
  }
}

/* Magnetic primary buttons. Tweened, so no per-move layout or re-render. */
if (full) {
  for (const b of $$(".magnetic")) {
    const x = gsap.quickTo(b, "x", { duration: 0.55, ease: "power3.out" });
    const y = gsap.quickTo(b, "y", { duration: 0.55, ease: "power3.out" });
    b.addEventListener("pointermove", (e) => {
      const r = b.getBoundingClientRect();
      const ev = e as PointerEvent;
      x((ev.clientX - r.left - r.width / 2) * 0.22);
      y((ev.clientY - r.top - r.height / 2) * 0.32);
    });
    b.addEventListener("pointerleave", () => {
      x(0);
      y(0);
    });
  }
}

/* ------------------------------------------------------------------ download */
const ICONS: Record<Platform, string> = { "win-x64": windowsIcon, "win-arm64": windowsIcon, "mac-arm64": appleIcon };
const noteFor = (p: Platform) => (p === "mac-arm64" ? INSTALL_NOTES.mac : INSTALL_NOTES.win);

function renderRelease(rel: Release, platform: Platform | null): void {
  for (const el of $$("[data-version]")) el.textContent = rel.version;
  for (const el of $$("[data-date]")) el.textContent = rel.publishedAt;
  if (rel.stars !== null) {
    const star = $("[data-stars]");
    star.textContent = String(rel.stars);
    star.setAttribute("aria-label", `GitHub ${rel.stars} stars`);
  }
  const main: Asset | undefined = rel.assets.find((a) => a.platform === platform);
  for (const b of $$<HTMLAnchorElement>("[data-primary]")) {
    b.href = main?.url ?? RELEASES_URL;
    const label = $("[data-primary-label]", b);
    const heroButton = !b.classList.contains("btn-big");
    label.textContent = main ? (heroButton ? `下载 ${main.label.split(" ")[0]} 版` : `下载 ${main.label}`) : "前往下载页";
    const icon = b.querySelector(".ico");
    if (!icon) {
      const i = document.createElement("span");
      i.className = "ico";
      i.innerHTML = main ? ICONS[main.platform] : arrowIcon;
      b.prepend(i);
    } else if (main) icon.innerHTML = ICONS[main.platform];
    const size = b.querySelector("[data-primary-size]");
    if (size) size.textContent = main ? formatSize(main.bytes) : "";
  }
  const note = $("[data-note]");
  note.textContent = main ? noteFor(main.platform) : "这台设备暂时没有桌面安装包，可以在电脑上打开本页，或从源码运行。";
  const others = $("[data-others]");
  others.innerHTML = "";
  for (const a of rel.assets) {
    if (a === main) continue;
    const li = document.createElement("li");
    li.innerHTML = `<a href="${a.url}"><span class="ico">${ICONS[a.platform]}</span><span class="o-name">${a.label}<small>${a.detail}</small></span><span class="o-size">${formatSize(a.bytes)}</span></a><p>${noteFor(a.platform)}</p>`;
    others.append(li);
  }
}

void (async () => {
  const platform = await detectPlatform();
  renderRelease(SNAPSHOT, platform);
  const rel = await loadRelease();
  if (rel !== SNAPSHOT) renderRelease(rel, platform);
})();

$("[data-icon=github]").insertAdjacentHTML("afterbegin", `<span class="ico">${githubIcon}</span>`);

const copyBtn = $<HTMLButtonElement>("[data-copy]");
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($(".cmd code").textContent ?? "");
    copyBtn.textContent = "已复制";
  } catch {
    copyBtn.textContent = "复制失败，请手动选择";
  }
  setTimeout(() => (copyBtn.textContent = "复制"), 1800);
});

window.addEventListener("load", () => ScrollTrigger.refresh());
document.fonts?.ready.then(() => ScrollTrigger.refresh());
