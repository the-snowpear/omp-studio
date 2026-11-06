import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import "./style.css";
import { PI, PI_PATH, piSvg } from "../shared/pi";
import {
  type Asset,
  type Platform,
  detectPlatform,
  formatSize,
  INSTALL_NOTES,
  loadRelease,
  RELEASES_URL,
  REPO_URL,
  CHANGELOG_URL,
  DOCS_URL,
  SNAPSHOT,
} from "../shared/release";
import { type Frame, loadBitmap, Resolver, webgl2Available } from "./resolve";

gsap.registerPlugin(ScrollTrigger);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = matchMedia("(pointer: coarse)").matches;
const narrow = () => innerWidth < 768;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const NOISE = "░▒▓█/\\|<>#%&*+=-~";
const CLONE = "git clone --recurse-submodules https://github.com/the-snowpear/omp-studio.git";

let lenis: Lenis | null = null;

function scrollToEl(target: string | HTMLElement | number): void {
  if (lenis) lenis.scrollTo(target as never, { duration: 1.1 });
  else if (typeof target === "number") scrollTo({ top: target });
  else (typeof target === "string" ? document.querySelector(target) : target)?.scrollIntoView();
}

function toast(msg: string): void {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  window.setTimeout(() => t.classList.remove("on"), 1600);
}

async function copy(text: string, msg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    toast("浏览器拒绝了剪贴板，请手动选中复制");
  }
}

/* ------------------------------------------------------------------ */
/* Text scramble                                                       */
/* ------------------------------------------------------------------ */
function scrambleIn(el: HTMLElement, text: string, ms = 820): void {
  el.setAttribute("aria-label", text);
  el.textContent = "";
  const cells = [...text].map((ch) => {
    const s = document.createElement("span");
    s.className = "sc scr";
    s.setAttribute("aria-hidden", "true");
    s.textContent = NOISE[Math.floor(Math.random() * NOISE.length)]!;
    el.append(s);
    return { s, ch };
  });
  const start = performance.now();
  const tick = (now: number) => {
    const t = (now - start) / ms;
    cells.forEach(({ s, ch }, i) => {
      const settleAt = 0.25 + (i / cells.length) * 0.75;
      if (t >= settleAt) {
        if (s.textContent !== ch) { s.textContent = ch; s.classList.remove("scr"); }
      } else if (Math.random() < 0.45) {
        s.textContent = NOISE[Math.floor(Math.random() * NOISE.length)]!;
      }
    });
    if (t < 1) requestAnimationFrame(tick);
    else cells.forEach(({ s, ch }) => { s.textContent = ch; s.classList.remove("scr"); });
  };
  requestAnimationFrame(tick);
}

function scrambleLine(el: HTMLElement, text: string, ms = 360): void {
  if (reduced) { el.textContent = text; return; }
  const start = performance.now();
  const chars = [...text];
  const tick = (now: number) => {
    const t = clamp((now - start) / ms);
    const shown = Math.floor(t * chars.length);
    el.textContent = chars.map((c, i) => (i < shown ? c : NOISE[Math.floor(Math.random() * NOISE.length)]!)).join("");
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = text;
  };
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ */
/* Chapters                                                            */
/* ------------------------------------------------------------------ */
type Chapter = { key: string; title: string; text: string; op: string; img: string; focusX: number; focusY: number };
const CHAPTERS: Chapter[] = [
  { key: "工作台", title: "工作台", text: "项目、会话、文件树和终端，都在一扇窗里。不用在 TUI 和一堆网页之间来回跳。", op: 'query("home.get")', img: "shot-chat-00592", focusX: .55, focusY: .42 },
  { key: "对话", title: "对话", text: "流式输出、工具卡片和本轮 diff 都是结构化事件，不是从屏幕上刮下来的字。", op: 'query("conversation.open")', img: "shot-chat-01556", focusX: .6, focusY: .3 },
  { key: "计划", title: "计划与审批", text: "Plan 可以逐段批注后再批准。权限分三档，Agent 提问就在对话里作答。", op: 'command("mode.plan.review.respond")', img: "shot-plan-00243", focusX: .28, focusY: .3 },
  { key: "Hub", title: "Agent Hub", text: "主会话和每个子 Agent 的状态、花费、上下文占用，一张名册看完。", op: 'query("session.agents.list")', img: "shot-hub-00540", focusX: .32, focusY: .4 },
  { key: "Token", title: "Token 与成本", text: "用量曲线和热力图按年、月、周、日切换。缓存命中和 TPS 在对话顶栏随时展开。", op: 'query("usage.get")', img: "shot-tokens-00761", focusX: .5, focusY: .72 },
  { key: "模型", title: "模型与角色", text: "@default、@plan、@task 各配各的模型和思考强度。上游支持 60+ 供应商，统一收在一页。", op: 'query("models.get")', img: "shot-models-00437", focusX: .4, focusY: .4 },
];
const stillUrl = (name: string) => `/media/still/${name}.webp`;

function buildChapters(): HTMLElement[] {
  const host = $("resolve-chapters");
  const rail = $("rail");
  const out = CHAPTERS.map((c) => {
    const a = document.createElement("article");
    a.className = "caption box";
    const title = document.createElement("span");
    title.className = "box-title";
    title.textContent = c.title;
    const p = document.createElement("p");
    p.textContent = c.text;
    const op = document.createElement("p");
    op.className = "op";
    op.textContent = c.op;
    a.append(title, p, op);
    host.append(a);
    return a;
  });
  CHAPTERS.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = c.key;
    b.dataset.i = String(i);
    rail.append(b);
  });
  const tip = document.createElement("span");
  tip.className = "rail-tip";
  tip.textContent = coarse ? "" : "鼠标移到画面上，会把它还原成字符";
  rail.append(tip);
  return out;
}

function goStatic(): void {
  document.documentElement.classList.add("static");
  $("resolve-chapters").querySelectorAll<HTMLElement>(".caption").forEach((a, i) => {
    if (a.querySelector("img")) return;
    const img = document.createElement("img");
    img.src = stillUrl(CHAPTERS[i]!.img);
    img.alt = `${CHAPTERS[i]!.title}界面（演示数据）`;
    img.loading = "lazy";
    img.width = 2400;
    img.height = 1350;
    a.prepend(img);
  });
  ScrollTrigger.refresh();
}

/* ------------------------------------------------------------------ */
/* The stage: hero plus chapter dissolves on one canvas                */
/* ------------------------------------------------------------------ */
function initStage(captions: HTMLElement[]): void {
  const canvas = $<HTMLCanvasElement>("stage-gl");
  const hero = $("hero");
  const rail = $("rail");
  const railBtns = [...rail.querySelectorAll("button")];
  let r: Resolver;
  try {
    r = new Resolver(canvas, { onLost: goStatic });
  } catch {
    goStatic();
    return;
  }

  const n = CHAPTERS.length;
  const HERO_END = 0.13;
  const L = (1 - HERO_END) / (n - 1);
  const DIRS: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0], [.7, .7], [0, 1]];
  const textures: (ReturnType<Resolver["upload"]> | null)[] = CHAPTERS.map(() => null);
  const maxW = narrow() ? 1600 : undefined;

  const frameFor = (i: number, zoom = 1, focusX = .58): Frame => {
    if (narrow()) {
      const c = CHAPTERS[i]!;
      return { fit: "cover", top: 48, bottom: 196, focusX: c.focusX, focusY: c.focusY, zoom };
    }
    return { fit: "contain", top: 48, bottom: 48, zoom, focusX, focusY: .46 };
  };

  let progress = 0;
  let activeCaption = -1;

  const apply = (t: number) => {
    progress = t;
    const s = r.state;
    let caption = -1;
    if (t < HERO_END) {
      const h = t / HERO_END;
      const pp = smooth(.02, .86, h);
      s.p = pp;
      s.mix = 0;
      s.dirX = DIRS[0]![0]; s.dirY = DIRS[0]![1];
      const z = 1 + (1 - smooth(.0, .9, h)) * .42;
      if (textures[0]) r.setImages(textures[0], narrow() ? { fit: "cover", top: 0, bottom: lerpBottom(h), focusX: .55, focusY: .42, zoom: 1 } : frameFor(0, z, .45 + .13 * smooth(0, .9, h)));
      s.gain = 1;
      s.dim = narrow() ? 0 : (1 - smooth(.05, .5, h));
      if (narrow()) s.gain = 1 - (1 - smooth(.05, .5, h)) * .46;
      s.flicker = pp < .02 ? 1 : 0;
      const fade = 1 - smooth(.04, .32, h);
      hero.style.opacity = String(fade);
      hero.style.transform = `translate3d(0, ${(-40 * (1 - fade)).toFixed(1)}px, 0)`;
      hero.style.visibility = fade < .01 ? "hidden" : "visible";
      hero.style.pointerEvents = fade < .5 ? "none" : "";
      if (h > .84) caption = 0;
    } else {
      hero.style.visibility = "hidden";
      s.dim = 0; s.gain = 1; s.flicker = 0;
      const u = clamp((t - HERO_END) / L, 0, n - 1 - 1e-5);
      const i = Math.floor(u);
      const local = u - i;
      const trans = Math.min(1, local / .46);
      const low = .14;
      const dip = trans < .5 ? smooth(0, .5, trans) : 1 - smooth(.5, 1, trans);
      s.p = 1 - dip * (1 - low);
      const dir = DIRS[i + 1]!;
      s.dirX = dir[0]; s.dirY = dir[1];
      const from = textures[i], to = textures[i + 1];
      if (trans >= 1 && to) {
        s.mix = 0;
        r.setImages(to, frameFor(i + 1));
      } else if (from && to) {
        s.mix = smooth(.4, .6, trans);
        r.setImages(from, frameFor(i), to, frameFor(i + 1));
      } else if (from) {
        s.mix = 0;
        r.setImages(from, frameFor(i));
      }
      if (trans < .06) caption = i;
      else if (trans > .72) caption = i + 1;
    }
    r.invalidate();
    const railOn = t > HERO_END * .7;
    rail.classList.toggle("on", railOn);
    if (caption !== activeCaption) {
      if (activeCaption >= 0) captions[activeCaption]!.classList.remove("on");
      if (caption >= 0) {
        captions[caption]!.classList.add("on");
        const title = captions[caption]!.querySelector<HTMLElement>(".box-title")!;
        scrambleLine(title, CHAPTERS[caption]!.title);
      }
      activeCaption = caption;
    }
    const cur = t < HERO_END ? 0 : Math.floor((t - HERO_END) / L + .77);
    railBtns.forEach((b, i) => b.setAttribute("aria-current", String(i === clamp(cur, 0, n - 1))));
  };
  const lerpBottom = (h: number) => Math.round(196 * smooth(.3, .9, h));

  const chapterAt = (i: number) => (i === 0 ? HERO_END * .97 : HERO_END + (i - 1) * L + L * .62);
  const section = $("resolve");
  const trigger = ScrollTrigger.create({
    trigger: section,
    start: "top top",
    end: "bottom bottom",
    onUpdate: (self) => apply(self.progress),
    onRefresh: (self) => apply(self.progress),
  });
  railBtns.forEach((b, i) => b.addEventListener("click", () => scrollToEl(trigger.start + (trigger.end - trigger.start) * chapterAt(i))));
  (window as unknown as { __chapterY: (i: number) => number }).__chapterY = (i) => trigger.start + (trigger.end - trigger.start) * chapterAt(i);

  // Lens: glyphs turn into the real UI under the pointer, and once the UI has resolved it goes the other way.
  if (!coarse) {
    const stage = $("stage");
    const mx = gsap.quickTo(r.state, "mx", { duration: .32, ease: "power3", onUpdate: () => r.invalidate() });
    const my = gsap.quickTo(r.state, "my", { duration: .32, ease: "power3", onUpdate: () => r.invalidate() });
    let seen = false;
    stage.addEventListener("pointermove", (e) => {
      if (!seen) {
        seen = true;
        r.state.mx = e.clientX; r.state.my = e.clientY;
        gsap.to(r.state, { lens: 1, duration: .5, overwrite: "auto", onUpdate: () => r.invalidate() });
      }
      mx(e.clientX); my(e.clientY);
    });
    stage.addEventListener("pointerleave", () => {
      seen = false;
      gsap.to(r.state, { lens: 0, duration: .4, overwrite: "auto", onUpdate: () => r.invalidate() });
    });
  }

  const load = async () => {
    for (let i = 0; i < CHAPTERS.length; i++) {
      try {
        const bmp = await loadBitmap(stillUrl(CHAPTERS[i]!.img), maxW);
        textures[i] = r.upload(bmp);
        bmp.close();
        if (i === 0) {
          document.documentElement.classList.add("stage-ready");
          apply(progress);
        }
      } catch {
        if (i === 0) { goStatic(); return; }
      }
      await new Promise((res) => (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 60)))(() => res(null)));
    }
    apply(progress);
  };
  void load();
}

/* π: same shader, small ladder, on its own transparent canvas */
function initPi(): void {
  const canvas = $<HTMLCanvasElement>("pi-gl");
  const size = 720;
  const src = document.createElement("canvas");
  src.width = size; src.height = Math.round(size * .94);
  const c = src.getContext("2d")!;
  c.fillStyle = "#000"; c.fillRect(0, 0, src.width, src.height);
  c.scale(size / 100, size / 100);
  const g = c.createLinearGradient(5, 0, 80, 94);
  g.addColorStop(0, PI.stops[0]); g.addColorStop(.55, PI.stops[1]); g.addColorStop(1, PI.stops[2]);
  c.fillStyle = g;
  c.fill(new Path2D(PI_PATH));
  let r: Resolver;
  try {
    r = new Resolver(canvas, { ladder: [16, 12, 9, 7, 5, 4], transparent: true, maxDpr: 2, edge: .2, block: 6 });
  } catch {
    canvas.outerHTML = `<span class="hero-pi">${piSvg(112)}</span>`;
    return;
  }
  r.setImages(r.upload(src), { fit: "contain" });
  r.state.gain = 1.1;
  r.state.dirX = .5; r.state.dirY = .86;
  const inv = () => r.invalidate();
  if (reduced) { r.state.p = 1; inv(); return; }
  gsap.to(r.state, { p: 1, duration: 1.8, delay: .55, ease: "power2.inOut", onUpdate: inv });
  let busy = false;
  canvas.addEventListener("pointerenter", () => {
    if (busy) return;
    busy = true;
    gsap.timeline({ onUpdate: inv, onComplete: () => { busy = false; } })
      .to(r.state, { p: .08, duration: .55, ease: "power2.out" })
      .to(r.state, { p: 1, duration: 1.1, ease: "power2.inOut" });
  });
}

/* ------------------------------------------------------------------ */
/* Bridge inspector                                                    */
/* ------------------------------------------------------------------ */
type Step = { name: string; pkg: string; title: string; code: string; note: string };
const k = (s: string) => `<span class="k">${s}</span>`;
const h = (s: string) => `<span class="h">${s}</span>`;
const STEPS: Step[] = [
  {
    name: "Renderer", pkg: "apps/renderer", title: "StudioClient.command",
    code: `${k("// 你按下发送，界面发出一条语义命令")}
await client.command(${h('"core.prompt"')}, {
  text: "跑一遍 typecheck，把 TS2322 修掉"
});`,
    note: "Renderer 只有 StudioClient。拿不到 Bridge token、进程句柄和 OMP 会话路径。",
  },
  {
    name: "StudioClient", pkg: "@omp-studio/client", title: "CommandHandle<\"core.prompt\">",
    code: `${k("// 先记成本地状态，后面的变化都靠事件推进")}
{
  requestId,
  commandName: "core.prompt",
  status: ${h('"local_pending"')},
  idempotencyKey,
  issuedAt
}`,
    note: "reducer 按 requestId 跟踪这条命令，事件带 epoch 和 cursor，过期的丢弃，有缺口就重新同步。",
  },
  {
    name: "Desktop IPC", pkg: "@omp-studio/transport-desktop", title: "DESKTOP_IPC_CHANNELS.command",
    code: `${k("// preload 暴露的 window.ompStudio")}
ipc channel:
  ${h('"omp-studio:desktop:command"')}

${k("// 没有通用的 invoke(channel, payload)")}
${k("// Renderer 只能走这几个固定频道")}`,
    note: "这一层只认信封形状，不碰业务字段。客户端身份由 Main 按发送方 WebContents 识别。",
  },
  {
    name: "Host facade", pkg: "@omp-studio/host-client-api", title: "ClientCommandAccepted",
    code: `${k("// Host 收下了，仅此而已")}
{
  commandName: "core.prompt",
  requestId,
  status: ${h('"accepted"')},
  acceptedAt
}`,
    note: "accepted 不等于成功。未知 mutation 在这里直接失败关闭。",
  },
  {
    name: "Studio Bridge", pkg: "@omp-studio/studio-protocol", title: "StudioRequest",
    code: `{
  type: ${h('"studio.request"')},
  requestId,
  runtimeEpoch,
  idempotencyKey,
  operation: {
    kind: "core.prompt",
    text: "跑一遍 typecheck，把 TS2322 修掉"
  }
}`,
    note: "到这一层才是 Runtime 协议。PTY 字节不是控制协议，终端归终端。",
  },
  {
    name: "omp --mode studio-host", pkg: "omp-patch/overlay", title: "StudioReceipt",
    code: `${k("// 只有终态回执才算数")}
{
  type: "studio.receipt",
  requestId,
  runtimeEpoch,
  stateVersion,
  status: ${h('"completed"')}
}`,
    note: "终态只有 completed、failed、rejected、outcome_unknown。回执沿原路回到界面。",
  },
];
const KILLED: Step = {
  name: "omp --mode studio-host", pkg: "omp-patch/overlay", title: "CommandReceipt",
  code: `${k("// Runtime 掉了，旧 epoch 被封存")}
{
  commandName: "core.prompt",
  requestId,
  status: ${h('"outcome_unknown"')},
  reason,
  observedAt
}`,
  note: "没结算的 accepted 一律变成 outcome_unknown。界面不会替你猜它跑完了没有。",
};

function initBridge(): void {
  const layers = $("layers");
  const titleEl = $("payload-title");
  const codeEl = $("payload-code");
  const noteEl = $("payload-note");
  let i = 0;
  let killed = false;
  let auto = true;
  let autoTimer = 0;

  const btns = STEPS.map((s, idx) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "layer";
    b.innerHTML = `<b>${s.name}</b><small>${s.pkg}</small>`;
    b.addEventListener("click", () => { stopAuto(); killed = false; go(idx); });
    li.append(b);
    layers.append(li);
    return b;
  });
  const packet = document.createElement("span");
  packet.className = "packet";
  packet.setAttribute("aria-hidden", "true");
  layers.append(packet);

  const stopAuto = () => { auto = false; window.clearTimeout(autoTimer); };
  const packetY = (idx: number) => {
    const b = btns[idx]!;
    const pr = layers.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return br.bottom - pr.top - 6;
  };

  function render(step: Step): void {
    titleEl.textContent = step.title;
    noteEl.textContent = step.note;
    codeEl.innerHTML = step.code;
    if (reduced) return;
    // Reveal by characters across the highlighted markup without breaking tags.
    const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
    const nodes: { node: Text; full: string }[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push({ node: n as Text, full: n.nodeValue ?? "" }); n.nodeValue = ""; }
    const total = nodes.reduce((a, x) => a + x.full.length, 0);
    const start = performance.now();
    const token = ++renderToken;
    const tick = (now: number) => {
      if (token !== renderToken) return;
      let left = Math.floor(clamp((now - start) / 340) * total);
      for (const x of nodes) {
        const take = Math.min(left, x.full.length);
        x.node.nodeValue = x.full.slice(0, take);
        left -= take;
      }
      if (now - start < 340) requestAnimationFrame(tick);
      else nodes.forEach((x) => { x.node.nodeValue = x.full; });
    };
    requestAnimationFrame(tick);
  }
  let renderToken = 0;

  function go(next: number, fromKill = false): void {
    i = clamp(next, 0, STEPS.length - 1);
    btns.forEach((b, idx) => {
      b.classList.toggle("active", idx === i);
      b.classList.toggle("dead", killed && idx === STEPS.length - 1);
      b.setAttribute("aria-current", String(idx === i));
    });
    render(fromKill ? KILLED : STEPS[i]!);
    if (getComputedStyle(packet).display !== "none") {
      gsap.to(packet, { y: packetY(i), duration: reduced ? 0 : .5, ease: "power3.inOut", overwrite: true });
    }
  }

  const prev = () => { stopAuto(); killed = false; go(i - 1); };
  const next = () => { stopAuto(); killed = false; go(i + 1); };
  const kill = () => { stopAuto(); killed = !killed; go(STEPS.length - 1, killed); $("step-kill").firstChild!.textContent = killed ? "接回 Runtime" : "拔掉 Runtime"; };
  $("step-prev").addEventListener("click", prev);
  $("step-next").addEventListener("click", next);
  $("step-kill").addEventListener("click", kill);
  go(0);

  let inView = false;
  const startAuto = () => {
    if (!auto || reduced) return;
    autoTimer = window.setTimeout(() => {
      if (!auto || !inView) return;
      if (i < STEPS.length - 1) { go(i + 1); startAuto(); } else auto = false;
    }, 2600);
  };
  new IntersectionObserver(([e]) => {
    const was = inView;
    inView = !!e?.isIntersecting;
    if (inView && !was) { window.clearTimeout(autoTimer); startAuto(); }
  }, { threshold: .35 }).observe($("inspector"));
  new IntersectionObserver(([e], ob) => {
    if (e?.isIntersecting) { $("nopes").classList.add("go"); ob.disconnect(); }
  }, { threshold: .8 }).observe($("nopes"));

  document.addEventListener("keydown", (e) => {
    if (!inView || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.activeElement?.closest("#picker, #tablist, #rail")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
    if (e.key === "x" || e.key === "X") kill();
  });
  addEventListener("resize", () => { if (getComputedStyle(packet).display !== "none") gsap.set(packet, { y: packetY(i) }); });
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

/* ------------------------------------------------------------------ */
/* Feature tabs                                                        */
/* ------------------------------------------------------------------ */
const FEATURES = [
  { name: "Git", clip: "git", note: "暂存、看 diff、写 commit，Fetch、Pull、Push 和提交图都在对话旁边。" },
  { name: "能力中心", clip: "caps", note: "Skills、Plugins、MCP、Slash Commands 同一页开关、探测和打开目录。" },
  { name: "Skills 抽屉", clip: "skills", note: "按项目、全局、内置分组。点「加入」，skill 就进当前草稿。" },
  { name: "权限档位", clip: "perm", note: "三档权限在 Composer 里随手切，批准可以按范围记住，也可以再忘掉。" },
  { name: "BTW", clip: "btw", note: "主线还在跑的时候，旁边单开一问，不打断它。" },
  { name: "回溯与分叉", clip: "restore", note: "从某一轮回溯，或者分叉出去再试一条路。" },
  { name: "Ctrl K", clip: "cmdk", note: "搜页面、会话和动作。这个网站的命令面板也是照它做的。" },
  { name: "应用内更新", clip: "update", note: "后台差分下载，Ed25519 验签，等你点重启才应用。任务还在跑时会延后，并告诉你在等谁。" },
];

function initFeatures(): void {
  const list = $("tablist");
  const video = $<HTMLVideoElement>("clip");
  const glCanvas = $<HTMLCanvasElement>("clip-gl");
  const note = $("clip-note");
  const panel = $("tabpanel");
  let current = -1;
  let r: Resolver | null = null;
  try {
    if (!reduced && webgl2Available()) r = new Resolver(glCanvas, { ladder: [24, 16, 12, 9, 6], maxDpr: 1.5, block: 14 });
  } catch {
    r = null;
  }
  if (!r) glCanvas.remove();
  const posters = new Map<number, ReturnType<Resolver["upload"]>>();

  const tabs = FEATURES.map((f, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab";
    b.id = `tab-${i}`;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", "tabpanel");
    b.textContent = f.name;
    b.addEventListener("click", () => select(i));
    list.append(b);
    return b;
  });
  list.addEventListener("keydown", (e) => {
    const vertical = !narrow();
    const nextKey = vertical ? "ArrowDown" : "ArrowRight";
    const prevKey = vertical ? "ArrowUp" : "ArrowLeft";
    if (e.key !== nextKey && e.key !== prevKey) return;
    e.preventDefault();
    const n = (current + (e.key === nextKey ? 1 : -1) + tabs.length) % tabs.length;
    select(n);
    tabs[n]!.focus();
  });

  let inView = false;
  let tl: gsap.core.Tween | null = null;

  async function select(i: number): Promise<void> {
    if (i === current) return;
    current = i;
    const f = FEATURES[i]!;
    tabs.forEach((t, n) => {
      t.setAttribute("aria-selected", String(n === i));
      t.tabIndex = n === i ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", `tab-${i}`);
    note.textContent = f.note;
    if (narrow()) tabs[i]!.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    video.pause();
    video.poster = `/media/poster/${f.clip}.webp`;
    video.src = `/media/clip/${f.clip}.mp4`;
    if (r) {
      tl?.kill();
      let tex = posters.get(i);
      if (!tex) {
        try {
          const bmp = await loadBitmap(`/media/poster/${f.clip}.webp`);
          tex = r.upload(bmp);
          bmp.close();
          posters.set(i, tex);
        } catch { /* fall through to plain video */ }
      }
      if (current !== i) return;
      if (tex) {
        glCanvas.style.display = "block";
        glCanvas.style.opacity = "1";
        r.setImages(tex, { fit: "cover" });
        r.state.p = .12;
        r.state.dirX = i % 2 ? 1 : 0; r.state.dirY = i % 2 ? 0 : 1;
        const rr = r;
        tl = gsap.to(r.state, {
          p: 1, duration: .85, ease: "power2.inOut",
          onUpdate: () => rr.invalidate(),
          onComplete: () => { glCanvas.style.display = "none"; if (inView) void video.play().catch(() => undefined); },
        });
        return;
      }
    }
    if (inView) void video.play().catch(() => undefined);
  }

  new IntersectionObserver(([e]) => {
    inView = !!e?.isIntersecting;
    if (inView && !reduced && (!r || glCanvas.style.display === "none")) void video.play().catch(() => undefined);
    else if (!inView) video.pause();
  }, { threshold: .3 }).observe(video);
  void select(0);
}

/* ------------------------------------------------------------------ */
/* Download picker                                                     */
/* ------------------------------------------------------------------ */
let downloadFor: (p: Platform) => void = () => undefined;

function initDownload(): void {
  const picker = $("picker");
  const note = $("install-note");
  const meta = $("download-meta");
  const device = $("device-note");
  let assets: Asset[] = SNAPSHOT.assets;
  let detected: Platform | null = null;
  let sel = 0;
  let links: HTMLAnchorElement[] = [];

  const render = () => {
    picker.textContent = "";
    links = assets.map((a, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "presentation");
      const l = document.createElement("a");
      l.className = "pick";
      l.href = a.url;
      l.setAttribute("role", "option");
      l.innerHTML = `<span class="mark" aria-hidden="true"></span><b>${a.label}</b><span class="sub">${a.detail}</span><span class="size">${formatSize(a.bytes)}</span><span class="yours">${a.platform === detected ? "你的系统" : ""}</span>`;
      l.addEventListener("pointerenter", () => setSel(i, false));
      l.addEventListener("focus", () => setSel(i, false));
      li.append(l);
      picker.append(li);
      return l;
    });
    setSel(sel, false);
  };

  const setSel = (i: number, focus: boolean) => {
    sel = (i + assets.length) % assets.length;
    links.forEach((l, n) => {
      const on = n === sel;
      l.classList.toggle("sel", on);
      l.setAttribute("aria-selected", String(on));
      l.tabIndex = on ? 0 : -1;
      l.querySelector(".mark")!.textContent = on ? ">" : "";
    });
    const a = assets[sel]!;
    note.textContent = INSTALL_NOTES[a.platform.startsWith("mac") ? "mac" : "win"];
    if (focus) links[sel]!.focus();
  };

  picker.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(sel + 1, true); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSel(sel - 1, true); }
    if (e.key === "Home") { e.preventDefault(); setSel(0, true); }
    if (e.key === "End") { e.preventDefault(); setSel(assets.length - 1, true); }
  });

  downloadFor = (p) => {
    const a = assets.find((x) => x.platform === p);
    if (a) location.href = a.url;
  };

  render();
  void detectPlatform().then((p) => {
    detected = p;
    if (p) {
      sel = Math.max(0, assets.findIndex((a) => a.platform === p));
    } else {
      device.hidden = false;
      device.textContent = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
        ? "手机上装不了。到电脑上打开这一页，或者把链接发给自己。"
        : "目前只有 Windows 和 macOS Apple Silicon 的桌面安装包，没有 Linux 版。";
    }
    render();
  });
  void loadRelease().then((rel) => {
    assets = rel.assets;
    sel = Math.min(sel, assets.length - 1);
    if (detected) sel = Math.max(0, assets.findIndex((a) => a.platform === detected));
    render();
    meta.textContent = `最新版本 ${rel.version}，发布于 ${rel.publishedAt}。MIT 开源。`;
    if (rel.stars !== null) $("stars").textContent = `★ ${rel.stars}`;
  });
  $("copy-source").addEventListener("click", () => void copy($("source-code").textContent ?? "", "命令已复制"));
}

/* ------------------------------------------------------------------ */
/* Palette and single-key shortcuts                                    */
/* ------------------------------------------------------------------ */
type Cmd = { label: string; hint: string; words?: string; run: () => void };
const COMMANDS: Cmd[] = [
  { label: "跳到下载", hint: "D", words: "download xiazai", run: () => scrollToEl("#download") },
  { label: "下载 Windows x64", hint: "安装包", words: "win exe download", run: () => downloadFor("win-x64") },
  { label: "下载 Windows ARM64", hint: "安装包", words: "win arm exe download", run: () => downloadFor("win-arm64") },
  { label: "下载 macOS Apple Silicon", hint: "安装包", words: "mac dmg download", run: () => downloadFor("mac-arm64") },
  { label: "复制 git clone 命令", hint: "剪贴板", words: "copy clone source", run: () => void copy(CLONE, "git clone 已复制") },
  { label: "打开 GitHub 仓库", hint: "G", words: "github source repo", run: () => window.open(REPO_URL, "_blank", "noopener") },
  { label: "看所有 Releases", hint: "外链", words: "release history", run: () => window.open(RELEASES_URL, "_blank", "noopener") },
  { label: "看更新日志", hint: "外链", words: "changelog", run: () => window.open(CHANGELOG_URL, "_blank", "noopener") },
  { label: "看文档", hint: "外链", words: "docs", run: () => window.open(DOCS_URL, "_blank", "noopener") },
  { label: "跳到 Bridge", hint: "B", words: "bridge protocol ipc", run: () => scrollToEl("#bridge") },
  { label: "跳到功能", hint: "F", words: "features git", run: () => scrollToEl("#features") },
  { label: "回到顶部", hint: "T", words: "top home", run: () => scrollToEl(0) },
  ...CHAPTERS.map((c, i): Cmd => ({
    label: `看 ${c.title}`, hint: "画面", words: c.key,
    run: () => {
      const fn = (window as unknown as { __chapterY?: (i: number) => number }).__chapterY;
      if (fn && !document.documentElement.classList.contains("static")) scrollToEl(fn(i));
      else $("resolve-chapters").querySelectorAll<HTMLElement>(".caption")[i]?.scrollIntoView();
    },
  })),
];

/** Subsequence match; contiguous and early hits score higher. */
function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  let ti = 0, score = 0, streak = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    streak = at === ti ? streak + 1 : 0;
    score += 1 + streak * 2 - Math.min(at, 20) * .02;
    ti = at + 1;
  }
  return score;
}

function initPalette(): void {
  const wrap = $("palette");
  const input = $<HTMLInputElement>("palette-input");
  const list = $("palette-list");
  let items: Cmd[] = [];
  let sel = 0;
  let returnTo: HTMLElement | null = null;

  const paint = () => {
    [...list.children].forEach((li, i) => {
      li.classList.toggle("sel", i === sel);
      li.setAttribute("aria-selected", String(i === sel));
      if (i === sel) { (li as HTMLElement).scrollIntoView({ block: "nearest" }); input.setAttribute("aria-activedescendant", li.id); }
    });
  };
  const filter = () => {
    const q = input.value.trim();
    items = COMMANDS.map((c) => ({ c, s: fuzzy(q, `${c.label} ${c.words ?? ""}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    if (!q) items = COMMANDS;
    sel = 0;
    list.textContent = "";
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "none";
      li.textContent = "没有匹配的命令";
      list.append(li);
      return;
    }
    items.forEach((c, i) => {
      const li = document.createElement("li");
      li.id = `pal-${i}`;
      li.setAttribute("role", "option");
      li.innerHTML = `<span></span><small></small>`;
      li.firstElementChild!.textContent = c.label;
      li.lastElementChild!.textContent = c.hint;
      li.addEventListener("pointermove", () => { if (sel !== i) { sel = i; paint(); } });
      li.addEventListener("click", () => run(i));
      list.append(li);
    });
    paint();
  };
  const open = () => {
    returnTo = document.activeElement as HTMLElement | null;
    wrap.hidden = false;
    input.value = "";
    filter();
    input.focus();
    lenis?.stop();
  };
  const close = () => {
    wrap.hidden = true;
    lenis?.start();
    returnTo?.focus?.();
  };
  const run = (i: number) => {
    const c = items[i];
    if (!c) return;
    close();
    c.run();
  };

  input.addEventListener("input", filter);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; paint(); } }
    if (e.key === "ArrowUp") { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; paint(); } }
    if (e.key === "Enter") { e.preventDefault(); run(sel); }
    if (e.key === "Tab") e.preventDefault();
  });
  wrap.addEventListener("pointerdown", (e) => { if (e.target === wrap) close(); });
  $("palette-open").addEventListener("click", open);
  if (/Mac/i.test(navigator.platform)) $("palette-key").textContent = "⌘K";

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (wrap.hidden) open(); else close();
      return;
    }
    if (!wrap.hidden) { if (e.key === "Escape") { e.preventDefault(); close(); } return; }
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key === "d") scrollToEl("#download");
    if (key === "g") window.open(REPO_URL, "_blank", "noopener");
    if (key === "b") scrollToEl("#bridge");
    if (key === "f") scrollToEl("#features");
    if (key === "t") scrollToEl(0);
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
function initAnchors(): void {
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href")!;
      e.preventDefault();
      if (id === "#top") scrollToEl(0);
      else if (id === "#resolve-chapters" && !document.documentElement.classList.contains("static")) {
        const fn = (window as unknown as { __chapterY?: (i: number) => number }).__chapterY;
        if (fn) scrollToEl(fn(0));
      } else scrollToEl(id);
    });
  });
}

async function boot(): Promise<void> {
  document.querySelector<HTMLElement>("[data-pi]")!.innerHTML = piSvg(20, "pi-nav");
  const captions = buildChapters();
  const canShader = !reduced && webgl2Available();
  if (!reduced) {
    lenis = new Lenis({ anchors: false, lerp: .11, wheelMultiplier: 1 });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((t) => lenis!.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    scrambleIn($("hero-title"), "别再解析终端了");
  }
  initAnchors();
  initPalette();
  initDownload();
  initBridge();
  // The atlas measures the mono font, so wait for it before the first shader build.
  await Promise.race([
    Promise.all([document.fonts.load('500 40px "JetBrains Mono Variable"'), document.fonts.ready]),
    new Promise((res) => setTimeout(res, 1800)),
  ]);
  if (canShader) {
    initStage(captions);
    initPi();
  } else {
    goStatic();
    $("pi-gl").outerHTML = "";
  }
  initFeatures();
  ScrollTrigger.refresh();
}

void boot();
