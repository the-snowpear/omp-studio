// 图 3: the workbench pulled apart into its five dock zones.
// 图 4: one diagram per pin mode.
import { i, type IconName } from "../shared/icons";
import { DOCK_ZONES, PIN_MODES } from "../shared/ui";

interface Zone { text: string; x: number; y: number; w: number; h: number; z: number; tag: [number, number]; lead: number }

// Plan-view rectangles on a 560 × 360 application window; z is the layer it lifts to.
const ZONE_GEOMETRY: Zone[] = [
  { text: "和项目、会话列表在同一侧。左侧栏全应用只有一份，换一场对话也不会变。", x: 34, y: 0, w: 118, h: 360, z: 1, tag: [8, 94], lead: 40 },
  { text: "紧挨着每场对话的一列，跟着这场对话走。把对话拖成浮窗，它的工具区会一起带走。", x: 318, y: 0, w: 70, h: 248, z: 2, tag: [10, 6], lead: 54 },
  { text: "最多分成上下两组。对话窗口也能拖进来，和工具一起作为标签显示。", x: 392, y: 0, w: 168, h: 248, z: 3, tag: [58, 8], lead: 40 },
  { text: "最多分成左右两组。按 Ctrl J 收起或展开，macOS 是 ⌘ J。", x: 156, y: 252, w: 404, h: 108, z: 1.4, tag: [92, 80], lead: 34 },
  { text: "浮在工作台上，一扇里可以放多个标签。可以吸附分屏，也可以钉成独立的系统窗口。", x: 176, y: 60, w: 176, h: 128, z: 4.3, tag: [4, 8], lead: 38 },
];

const TOOLS: { name: string; icon: IconName; zone: number }[] = [
  { name: "Files", icon: "folderOpen", zone: 0 },
  { name: "Changes", icon: "fileDiff", zone: 0 },
  { name: "Git", icon: "gitBranch", zone: 1 },
  { name: "Agents", icon: "bot", zone: 1 },
  { name: "Browser", icon: "globe", zone: 2 },
  { name: "Computer", icon: "monitor", zone: 2 },
  { name: "Terminal", icon: "terminal", zone: 3 },
  { name: "Logs", icon: "scrollText", zone: 3 },
  { name: "BTW", icon: "messageCircle", zone: 4 },
];

export function initExploded(): void {
  const wrap = document.querySelector<HTMLElement>("[data-iso-wrap]")!;
  const iso = wrap.querySelector<HTMLElement>("[data-iso]")!;
  const list = document.querySelector<HTMLElement>("[data-zone-list]")!;
  const nameEl = document.querySelector<HTMLElement>("[data-zone-name]")!;
  const textEl = document.querySelector<HTMLElement>("[data-zone-text]")!;
  const chips = document.querySelector<HTMLElement>("[data-tool-chips]")!;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const where = TOOLS.map((t) => t.zone);
  let selected = 4;

  const geo = (z: { x: number; y: number; w: number; h: number }) => `--x:${z.x};--y:${z.y};--w:${z.w};--h:${z.h}`;
  iso.innerHTML =
    `<div class="iso-base" data-frame style="${geo({ x: 0, y: 0, w: 560, h: 360 })}"></div>` +
    `<div class="iso-base" style="${geo({ x: 0, y: 0, w: 30, h: 360 })}"></div>` +
    `<div class="iso-base" style="${geo({ x: 156, y: 0, w: 158, h: 248 })}"><span>对话</span></div>` +
    ZONE_GEOMETRY.map(
      (z, n) =>
        `<button class="iso-plane" type="button" data-zone="${n}" aria-pressed="false" aria-label="${DOCK_ZONES[n]}" style="${geo(z)};--z:${z.z}">` +
        `<span class="iso-tools"></span><span class="iso-tag" style="--tx:${z.tag[0]};--ty:${z.tag[1]};--lead:${z.lead}"><span></span><b>${DOCK_ZONES[n]}</b></span></button>`,
    ).join("");
  const planes = [...iso.querySelectorAll<HTMLButtonElement>(".iso-plane")];

  list.innerHTML = DOCK_ZONES.map((name, n) => `<button class="zone-btn" type="button" data-zone="${n}" aria-pressed="false">${name}</button>`).join("");
  const zoneBtns = [...list.querySelectorAll<HTMLButtonElement>("button")];
  chips.innerHTML = TOOLS.map((t, n) => `<button class="tool-chip" type="button" data-tool="${n}" aria-pressed="false">${i(t.icon)}${t.name}</button>`).join("");
  const chipBtns = [...chips.querySelectorAll<HTMLButtonElement>("button")];

  const render = () => {
    planes.forEach((p, n) => {
      p.setAttribute("aria-pressed", String(n === selected));
      p.querySelector(".iso-tools")!.innerHTML = TOOLS.filter((_, k) => where[k] === n).map((t) => `<i>${t.name}</i>`).join("");
    });
    zoneBtns.forEach((b, n) => b.setAttribute("aria-pressed", String(n === selected)));
    chipBtns.forEach((b, k) => {
      const here = where[k] === selected;
      b.setAttribute("aria-pressed", String(here));
      b.setAttribute("aria-label", `${TOOLS[k]!.name}，现在在${DOCK_ZONES[where[k]!]}${here ? "" : `，点击移到${DOCK_ZONES[selected]}`}`);
    });
    nameEl.textContent = DOCK_ZONES[selected]!;
    textEl.textContent = ZONE_GEOMETRY[selected]!.text;
  };
  const select = (n: number) => {
    selected = n;
    render();
  };
  planes.forEach((p, n) => {
    p.addEventListener("click", () => select(n));
    p.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && select(n));
    p.addEventListener("focus", () => select(n));
  });
  zoneBtns.forEach((b, n) => b.addEventListener("click", () => select(n)));
  chipBtns.forEach((b, k) =>
    b.addEventListener("click", () => {
      where[k] = selected;
      render();
    }),
  );
  render();

  // Fit the drawing to its frame, and open the layers as the sheet scrolls in.
  new ResizeObserver(() => iso.style.setProperty("--k", String(Math.min(1.12, wrap.clientWidth / 770)))).observe(wrap);
  if (reduce) return;
  let queued = false;
  const update = () => {
    queued = false;
    const box = wrap.getBoundingClientRect();
    const vh = innerHeight;
    const t = Math.min(1, Math.max(0, (vh * 0.98 - box.top) / (vh * 0.62)));
    // ease-out, so the layers settle as the drawing reaches the middle of the screen
    iso.style.setProperty("--e", String(1 - (1 - t) ** 3));
  };
  addEventListener("scroll", () => queued || ((queued = true), requestAnimationFrame(update)), { passive: true });
  addEventListener("resize", update);
  update();
}

const PIN_TEXT = [
  "跟着当前会话的布局，只在工作台里显示。",
  "在同一个工作区里换页面、换会话，它都在。换了工作区就隐藏，回来时恢复。",
  "换页面、换会话、换工作区，它一直都在。",
  "成为一扇普通的系统窗口，可以拖到另一块显示器。",
  "还是那扇独立窗口，但保持在其他应用窗口的上方。",
];

function pinFigure(mode: number): string {
  const inApp = mode < 3;
  const rect = (x: number, y: number, w: number, h: number, label: string, on: boolean) =>
    `<rect class="${on ? "pin-bound" : "pin-dash"}" x="${x}" y="${y}" width="${w}" height="${h}"/>` +
    `<text class="pin-text"${on ? " data-on" : ""} x="${x + 4}" y="${y + 10.5}">${label}</text>`;
  const win = (x: number, y: number, w: number, h: number) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="var(--sheet)"/><rect class="pin-win" x="${x}" y="${y}" width="${w}" height="${h}"/>` +
    `<path d="M${x} ${y + 6}h${w}" stroke="var(--chalk)" stroke-width="1"/>`;
  let body = rect(2, 2, 156, 106, inApp ? "" : "屏幕", !inApp);
  if (inApp) {
    body += rect(8, 12, 112, 84, "应用", mode === 2) + rect(16, 26, 88, 62, "工作区", mode === 1) + rect(24, 40, 52, 40, "会话", mode === 0);
    body += [win(32, 54, 36, 21), win(58, 58, 38, 24), win(86, 66, 30, 22)][mode]!;
  } else {
    body += rect(8, 18, 84, 66, "应用", false);
    if (mode === 4) body += rect(100, 26, 52, 44, "其他应用", false);
    body += mode === 3 ? win(104, 44, 46, 32) : win(112, 46, 40, 30);
    // taskbar with one icon for the app and one for the window
    body += `<path d="M2 96h156" stroke="var(--line-2)" stroke-width="1"/><rect x="66" y="99" width="6" height="6" fill="none" stroke="var(--line-2)"/><rect class="pin-win" x="76" y="99" width="6" height="6"/>`;
  }
  return `<svg viewBox="0 0 160 110" role="img" aria-label="${PIN_MODES[mode]}示意图"><defs><pattern id="pin-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0v5" stroke="var(--line-2)" stroke-width="1"/></pattern></defs>${body}</svg>`;
}

export function initPins(): void {
  document.querySelector<HTMLElement>("[data-pins]")!.innerHTML = PIN_MODES.map(
    (name, n) => `<li>${pinFigure(n)}<h3><b>${n + 1}</b>${name}</h3><p>${PIN_TEXT[n]}</p></li>`,
  ).join("");
}
