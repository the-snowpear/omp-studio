// 图 1: builds the workbench twice (line drawing and real UI), then measures
// the drawing to place dimension strings and numbered balloons.
import { i, piMark } from "../shared/icons";
import { ompWindow, surface } from "../shared/ui";

const SESSIONS = [
  ["新建对话（空白）", ""],
  ["跟踪上游 pi-web 更新", "on"],
  ["Audit and fix OSS repo", ""],
  ["Mermaid 全屏缩放计划", ""],
  ["修复 Git Bash 路径", ""],
];

function workbench(): HTMLElement {
  const wb = document.createElement("div");
  wb.className = "wb";
  wb.innerHTML = `
<div class="wb-top">${i("panelLeft")}<span class="wb-menu">文件　编辑　视图　帮助</span>
<span class="wb-tab" data-on>${i("messageSquare")}跟踪上游 pi-web</span><span class="wb-tab">${i("globe")}Studio 组件预览</span><span class="wb-tab">${i("messageSquare")}Mermaid 全屏缩放</span>${i("plus")}
<span class="wb-grow"></span><span class="wb-tele">↑3.5M ↓73k</span><span class="wb-tele">22%</span>${i("panelRight")}${i("sun")}</div>
<div class="wb-rail" data-part="rail"><span data-on>${i("layoutGrid")}</span><span>${i("house")}</span><span>${i("history")}</span><span>${i("boxes")}</span><span>${i("brain")}</span><span>${i("settings")}</span><i class="wb-grow"></i><span>S</span></div>
<div class="wb-side" data-part="side">
<div class="wb-side-h">${piMark(16)}OMP Studio${i("search")}</div>
<div class="wb-new">${i("plus")}新建对话<kbd>Ctrl ⇧ O</kbd></div>
<div class="wb-label">项目与对话</div>
<div class="wb-sess" data-proj>${i("folderOpen")}<span>omp-web</span></div>
${SESSIONS.map(([name, on]) => `<div class="wb-sess"${on ? " data-on" : ""}><span>${name}</span></div>`).join("")}
<div class="wb-sess" data-proj>${i("folder")}<span>pi-web (upstream)</span></div>
${surface("files")}</div>
<div class="wb-work"></div>
<div class="wb-bottom" data-part="bottom"><div class="wb-bottom-tabs"><span data-on>${i("terminal")}Terminal</span><span>${i("scrollText")}OMP Logs</span><span>${i("fileDiff")}Changes</span></div>${surface("terminal")}</div>`;
  const work = wb.querySelector(".wb-work")!;
  const buttons: ("pin" | "min" | "max" | "close")[] = ["min", "max", "close"];
  for (const kind of ["chat", "plan", "browser"] as const) {
    const win = ompWindow({ kind, buttons, focused: kind === "chat" });
    win.dataset.part = kind;
    // The drawing is an illustration: nothing in it takes focus.
    win.querySelectorAll("button").forEach((b) => (b.tabIndex = -1));
    work.append(win);
  }
  return wb;
}

/** Parts called out on the drawing, in balloon order. */
const PARTS: { part: string; name: string; at: [number, number]; angle: number }[] = [
  { part: "rail", name: "主导航", at: [0.5, 0.66], angle: 270 },
  { part: "side", name: "项目与会话", at: [0.8, 0.42], angle: 200 },
  { part: "chat", name: "对话窗口", at: [0.9, 0.3], angle: 200 },
  { part: "plan", name: "计划审批窗口", at: [0.92, 0.5], angle: 200 },
  { part: "browser", name: "浏览器窗口", at: [0.92, 0.72], angle: 200 },
  { part: "bottom", name: "底栏终端", at: [0.94, 0.5], angle: 200 },
];

export interface Assembly {
  root: HTMLElement;
  drawing: HTMLElement;
  real: HTMLElement;
  frames: HTMLElement;
  /** Drawing size in its own (unscaled) pixels. */
  size(): { w: number; h: number };
  /** Screen pixels per drawing pixel. */
  scale(): number;
  onLayout(fn: () => void): void;
}

export function buildAssembly(): Assembly {
  const root = document.querySelector<HTMLElement>(".assembly")!;
  const stage = root.querySelector<HTMLElement>("[data-assembly]")!;
  const drawing = root.querySelector<HTMLElement>("[data-drawing]")!;
  const line = root.querySelector<HTMLElement>('[data-layer="line"]')!;
  const real = root.querySelector<HTMLElement>('[data-layer="real"]')!;
  const notes = root.querySelector<HTMLElement>("[data-notes]")!;
  const frames = root.querySelector<HTMLElement>("[data-frames]")!;
  const dimTop = root.querySelector<HTMLElement>("[data-dim-top]")!;
  const dimLeft = root.querySelector<HTMLElement>("[data-dim-left]")!;
  const legend = root.querySelector<HTMLElement>("[data-legend]")!;

  line.append(workbench());
  real.append(workbench());
  legend.innerHTML = PARTS.map((p, n) => `<li><b>${n + 1}</b>${p.name}</li>`).join("");

  let w = 1040;
  let h = 640;
  let s = 1;
  const listeners: (() => void)[] = [];

  const dims = (host: HTMLElement, segments: [number, string][]) => {
    host.innerHTML =
      segments.map(([px, label]) => `<div class="dim" style="flex:${px} 1 0"><span>${label}</span></div>`).join("") +
      `<div class="dim dim-end"></div>`;
  };

  const annotate = () => {
    const box = (part: string) => {
      const el = line.querySelector<HTMLElement>(`[data-part="${part}"]`);
      if (!el || !el.offsetWidth) return null;
      // offset* are in unscaled drawing pixels; walk up to the layer.
      let x = 0;
      let y = 0;
      for (let n: HTMLElement | null = el; n && n !== line; n = n.offsetParent as HTMLElement | null) {
        x += n.offsetLeft + n.clientLeft;
        y += n.offsetTop + n.clientTop;
      }
      return { x, y, w: el.offsetWidth, h: el.offsetHeight };
    };
    const rail = box("rail");
    const side = box("side");
    const bottom = box("bottom");
    // True sizes from the app's layout tokens, as a drawing states real
    // measurements whatever scale it is printed at.
    const railW = rail?.w ?? 44;
    const sideW = side?.w ?? 0;
    dims(dimTop, [[railW, "56"], ...(sideW ? [[sideW, "272"] as [number, string]] : []), [w - railW - sideW, "对话工作区，随窗口伸缩"]]);
    const bottomH = bottom?.h ?? 128;
    dims(dimLeft, [[34, "44"], [h - 34 - bottomH, "自适应"], [bottomH, "240"]]);

    notes.innerHTML = PARTS.map((p, n) => {
      const b = box(p.part);
      if (!b) return "";
      const x = Math.round(b.x + b.w * p.at[0]);
      const y = Math.round(b.y + b.h * p.at[1]);
      return `<span class="balloon" style="--x:${x};--y:${y};--a:${p.angle}deg"><b>${n + 1}</b></span>`;
    }).join("");
    legend.querySelectorAll("li").forEach((li, n) => (li.hidden = !box(PARTS[n]!.part)));
  };

  const layout = () => {
    const width = stage.clientWidth;
    if (!width) return;
    const compact = width < 520;
    root.toggleAttribute("data-compact", compact);
    w = compact ? 520 : 1040;
    h = compact ? 660 : 640;
    s = width / w;
    drawing.style.setProperty("--s", String(s));
    annotate();
    listeners.forEach((fn) => fn());
  };
  new ResizeObserver(layout).observe(stage);
  layout();

  return { root, drawing, real, frames, size: () => ({ w, h }), scale: () => s, onLayout: (fn) => listeners.push(fn) };
}
