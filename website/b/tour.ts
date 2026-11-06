/**
 * Guided tour. It drives the real renderer by clicking its real controls in the
 * same-origin iframe; nothing is simulated. On touch and narrow screens the embed
 * is absent, so the same chapters swap stills instead.
 *
 * Renderer selectors this depends on (apps/renderer):
 *   .app-rail-btn[aria-label=...]  .thread  button[aria-label='Token 用量详情']
 *   button[aria-label='Agent Hub']  .hub-card  .tk-views button[data-view]
 *   #mcTabRoles  #capTab-mcp  button[aria-label='恢复会话']
 */
import gsap from "gsap";

export type TourHost = {
  doc: () => Document | null;
  ring: HTMLElement;
  ease: (t: number) => number;
  isLive: boolean;
  isFlow: boolean;
  reduced: boolean;
  showStill: (route: string) => void;
};

type Step = { sel: string; text?: string; ring?: string };
type Chapter = { id: string; title: string; caption: string; still: string; steps: Step[]; leave?: Step; stillOnly?: boolean; liveOnly?: boolean };

const rail = (label: string): Step => ({ sel: `.app-rail-btn[aria-label='${label}']` });

const CHAPTERS: Chapter[] = [
  {
    id: "conv", title: "会话", still: "workbench",
    caption: "工具卡片、改动和子 Agent 都排在对话流里，不用切窗口。",
    steps: [rail("工作台"), { sel: ".thread", text: "跟踪上游" }],
  },
  {
    id: "token", title: "用量", still: "workbench", liveOnly: true,
    caption: "顶栏随时展开本轮 Token、缓存命中和子 Agent 花费。",
    steps: [rail("工作台"), { sel: "button[aria-label='Token 用量详情']" }],
    leave: { sel: "button[aria-label='Token 用量详情']" },
  },
  {
    id: "hub", title: "Agent Hub", still: "agent-hub",
    caption: "主会话和每个子 Agent 的状态、花费与上下文占用。",
    steps: [{ sel: "button[aria-label='Agent Hub']" }, { sel: ".hub-card", text: "audit" }],
  },
  {
    id: "home", title: "首页", still: "home",
    caption: "最近项目、Token 曲线和热力图，按年、月、周、日切换。",
    steps: [rail("首页"), { sel: ".tk-views button[data-view='month']" }],
  },
  {
    id: "models", title: "模型配置", still: "model-config",
    caption: "供应商、端点和角色在同一处配好。",
    steps: [rail("模型配置"), { sel: "#mcTabRoles" }],
  },
  {
    id: "caps", title: "能力中心", still: "capabilities",
    caption: "Skills、Plugins、MCP 和 Slash Commands 一页开关。",
    steps: [rail("能力中心"), { sel: "#capTab-mcp" }],
  },
  {
    id: "history", title: "会话历史", still: "history",
    caption: "恢复、Fork 或只读咨询，旧会话随时接着用。",
    steps: [rail("会话历史"), { sel: "button[aria-label='恢复会话']", ring: "only" }],
  },
];

const DWELL = 5.6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scroll only the app's own pane: Element.scrollIntoView would also move the outer page. */
function bringIntoPane(el: HTMLElement): void {
  for (let box = el.parentElement; box; box = box.parentElement) {
    if (box.scrollHeight <= box.clientHeight + 2 || !/auto|scroll/.test(getComputedStyle(box).overflowY)) continue;
    const a = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (a.top < b.top + 8 || a.bottom > b.bottom - 8) box.scrollTop += a.top - b.top - (b.height - a.height) / 2;
    return;
  }
}

export function createTour(host: TourHost, list: HTMLElement, toggle: HTMLButtonElement) {
  const chapters = CHAPTERS.filter((c) => (host.isLive ? !c.stillOnly : !c.liveOnly));
  let current = -1;
  let runId = 0;
  let ready = !host.isLive;
  let inView = host.isFlow;
  let stopped = host.reduced;
  let timer: gsap.core.Tween | null = null;
  let leave: Step | undefined;

  list.innerHTML = chapters.map((c, i) => `
    <li class="ch" data-i="${i}">
      <span class="ch-line"></span>
      <button class="ch-btn" type="button" aria-pressed="false">
        <span class="ch-title">${c.title}</span>
        <span class="ch-cap-wrap"><span class="ch-cap"><span>${c.caption}</span></span></span>
      </button>
    </li>`).join("");
  const items = [...list.querySelectorAll<HTMLElement>(".ch")];

  // Flow layout hides per-chapter captions, so one caption sits under the chips.
  const flowCap = document.createElement("p");
  if (host.isFlow) {
    flowCap.className = "flow-cap";
    list.parentElement?.querySelector(".rail-foot")?.prepend(flowCap);
  }

  const find = async (step: Step): Promise<HTMLElement | null> => {
    const started = performance.now();
    while (performance.now() - started < 2200) {
      const d = host.doc();
      if (d) {
        const all = [...d.querySelectorAll<HTMLElement>(step.sel)];
        const hit = all.find((el) => el.getClientRects().length > 0 && (!step.text || el.textContent?.includes(step.text)));
        if (hit) return hit;
      }
      await sleep(90);
    }
    return null;
  };

  const ringTo = (el: HTMLElement, instant = false) => {
    const r = el.getBoundingClientRect();
    const m = 3;
    gsap.killTweensOf(host.ring);
    return new Promise<void>((resolve) => {
      gsap.to(host.ring, {
        x: r.left - m, y: r.top - m, width: r.width + m * 2, height: r.height + m * 2, opacity: 1,
        duration: instant || host.reduced ? 0 : 0.75, ease: host.ease, onComplete: resolve,
      });
    });
  };

  async function runSteps(c: Chapter, id: number): Promise<void> {
    if (leave) {
      const el = await find(leave);
      if (id !== runId) return;
      el?.click();
      leave = undefined;
    }
    for (const step of c.steps) {
      const el = await find(step);
      if (id !== runId) return;
      if (!el || el.classList.contains("active")) continue;
      bringIntoPane(el);
      await ringTo(el);
      if (id !== runId) return;
      if (step.ring !== "only") el.click();
      await sleep(620);
      if (id !== runId) return;
    }
    leave = c.leave;
    gsap.to(host.ring, { opacity: 0, duration: 0.5, delay: 1.1 });
  }

  function mark(i: number): void {
    items.forEach((it, n) => {
      it.classList.toggle("on", n === i);
      it.querySelector("button")?.setAttribute("aria-pressed", String(n === i));
      if (n !== i) gsap.set(it.querySelector(".ch-line"), { scaleY: 0 });
    });
    if (host.isFlow) {
      flowCap.textContent = chapters[i].caption;
      // Horizontal only: a rotating chip must never pull the page back while someone reads below.
      const chip = items[i];
      list.scrollTo({ left: chip.offsetLeft - (list.clientWidth - chip.offsetWidth) / 2, behavior: host.reduced ? "auto" : "smooth" });
    }
  }

  function arm(): void {
    timer?.kill();
    timer = null;
    if (stopped || current < 0) return;
    const line = items[current].querySelector(".ch-line");
    timer = gsap.fromTo(line, { scaleY: 0 }, {
      scaleY: 1, duration: DWELL, ease: "none", paused: !(inView && ready),
      onComplete: () => go((current + 1) % chapters.length),
    });
  }

  function go(i: number): void {
    current = i;
    const id = ++runId;
    mark(i);
    if (host.isLive) void runSteps(chapters[i], id);
    else host.showStill(chapters[i].still);
    arm();
  }

  function syncTimer(): void {
    if (!timer) return;
    if (inView && ready && !stopped) timer.play();
    else timer.pause();
  }

  function setStopped(v: boolean): void {
    stopped = v;
    toggle.textContent = v ? "继续导览" : "暂停导览";
    if (v) {
      timer?.kill();
      timer = null;
    } else if (current >= 0) {
      go((current + 1) % chapters.length);
    } else if (ready && inView) {
      go(0);
    }
  }

  list.addEventListener("click", (e) => {
    const li = (e.target as Element).closest<HTMLElement>(".ch");
    if (!li) return;
    setStopped(true);
    go(Number(li.dataset.i));
    gsap.set(items[current].querySelector(".ch-line"), { scaleY: 1 });
  });
  toggle.addEventListener("click", () => setStopped(!stopped));

  return {
    start(): void {
      if (host.reduced) toggle.textContent = "继续导览";
      if (!host.isLive) {
        // Stills are available immediately.
        current = 0;
        mark(0);
        host.showStill(chapters[0].still);
        if (!stopped) arm();
        if (timer && !host.isFlow) timer.pause();
      } else if (host.isFlow) {
        mark(0);
        current = 0;
      }
    },
    onReady(): void {
      ready = true;
      if (!stopped && inView && current < 0) go(0);
      else if (!stopped && inView && host.isLive && host.isFlow) go(current);
      syncTimer();
    },
    setInView(v: boolean): void {
      inView = v;
      if (v && !stopped && ready && current < 0) go(0);
      syncTimer();
    },
    stopByUser(): void {
      if (!stopped) setStopped(true);
    },
    /** The visitor is driving now, so no chapter describes what the window shows. */
    release(): void {
      runId++;
      current = -1;
      items.forEach((it) => it.classList.remove("on"));
    },
    refreshStill(): void {
      if (current >= 0) host.showStill(chapters[current].still);
    },
  };
}
