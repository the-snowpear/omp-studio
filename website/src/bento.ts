// What else the app does, as eight small things to handle rather than a list to read.
// Each tile's picture is the feature in miniature, and answers to a press, a drag or a key.
import { t } from "../shared/i18n";
import { i, type IconName } from "../shared/icons";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const HAND = '<svg viewBox="0 0 20 20" width="22" height="22"><path d="M3.3 2.4 16.7 8.7 10.8 10.7 8.8 16.6z"/></svg>';

// ---------------- computer use: scrub through what it did ----------------
const ACTIONS = [
  { x: 0.2, y: 0.2, text: t("打开「设置」", 'Open "Settings"') },
  { x: 0.14, y: 0.49, text: t("点击「外观」", 'Click "Appearance"') },
  { x: 0.83, y: 0.42, text: t("打开「深色模式」", 'Enable "Dark mode"') },
  { x: 0.62, y: 0.7, text: t("把字号拖到 15", "Set font size to 15") },
  { x: 0.86, y: 0.9, text: t("点击「应用」，完成", 'Click "Apply", done') },
];

function computer(el: HTMLElement) {
  el.innerHTML = `<div class="cu-screen" data-step="0"><div class="cu-app"><aside><b>${t("设置", "Settings")}</b><span>${t("通用", "General")}</span><span class="cu-look">${t("外观", "Appearance")}</span><span>${t("键盘", "Keyboard")}</span></aside><div class="cu-main"><p><span>${t("深色模式", "Dark mode")}</span><i class="cu-switch"></i></p><p><span>${t("字号", "Font size")}</span><i class="cu-slide"><em></em></i></p><div class="cu-foot"><i class="cu-apply">${t("应用", "Apply")}</i></div></div></div><span class="cu-hand" aria-hidden="true">${HAND}</span></div>
<div class="cu-strip"><span class="cu-text"></span><input type="range" min="0" max="${ACTIONS.length - 1}" step="0.01" value="0" aria-label="${t("回看操作历史", "Scrub action history")}"></div>`;
  const screen = el.querySelector<HTMLElement>(".cu-screen")!;
  const hand = el.querySelector<HTMLElement>(".cu-hand")!;
  const text = el.querySelector<HTMLElement>(".cu-text")!;
  const range = el.querySelector<HTMLInputElement>("input")!;
  const draw = () => {
    const v = Number(range.value);
    const n = Math.floor(v);
    const a = ACTIONS[n]!;
    const b = ACTIONS[Math.min(n + 1, ACTIONS.length - 1)]!;
    const k = v - n;
    const e = k * k * (3 - 2 * k);
    hand.style.left = `${(a.x + (b.x - a.x) * e) * 100}%`;
    hand.style.top = `${(a.y + (b.y - a.y) * e) * 100}%`;
    const step = Math.round(v);
    screen.dataset.step = String(step);
    screen.style.setProperty("--size", String(clamp((v - 2.3) / 0.7, 0, 1)));
    text.textContent = ACTIONS[step]!.text;
    range.setAttribute("aria-valuetext", ACTIONS[step]!.text);
    range.style.setProperty("--v", String(v / (ACTIONS.length - 1)));
  };
  let touched = false;
  range.addEventListener("input", () => {
    touched = true;
    draw();
  });
  draw();
  if (reduced()) return;
  // Plays once when it comes into view, then waits to be scrubbed.
  new IntersectionObserver((entries, io) => {
    if (!entries[0]!.isIntersecting) return;
    io.disconnect();
    const t0 = performance.now() + 500;
    const run = (now: number) => {
      if (touched) return;
      // Dwell on each step, travel between them.
      const t = Math.max(now - t0, 0) / 1300;
      const n = Math.floor(t);
      const v = Math.min(n + clamp((t - n - 0.35) / 0.65, 0, 1), ACTIONS.length - 1);
      range.value = String(v);
      draw();
      if (v < ACTIONS.length - 1) requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
  }, { threshold: 0.6 }).observe(el);
}

// ---------------- browser: point at an element, quote it ----------------
function picker(el: HTMLElement) {
  el.innerHTML = `<div class="pk-page"><button type="button" data-name="h1.title"><b>${t("秋季新品", "Autumn Drop")}</b></button><button type="button" data-name="p.price"><span>${t("299 元", "$49")}</span></button><button type="button" data-name="button.buy"><em>${t("立即购买", "Buy now")}</em></button></div>
<div class="pk-input"><span class="pk-chips"></span><span class="pk-hint">${t("选一个页面元素", "Pick a page element")}</span>${i("arrowUp")}</div>`;
  const chips = el.querySelector<HTMLElement>(".pk-chips")!;
  const hint = el.querySelector<HTMLElement>(".pk-hint")!;
  el.querySelector(".pk-page")!.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-name]");
    if (!b) return;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "pk-chip";
    chip.setAttribute("aria-label", `${t("移除", "Remove")} ${b.dataset.name}`);
    chip.textContent = b.dataset.name!;
    chip.addEventListener("click", () => {
      chip.remove();
      hint.hidden = chips.childElementCount > 0;
    });
    if ([...chips.children].some((c) => c.textContent === b.dataset.name)) return;
    chips.append(chip);
    hint.hidden = true;
    if (reduced()) return;
    // The quote flies from the element into the composer.
    const from = b.getBoundingClientRect();
    const to = chip.getBoundingClientRect();
    chip.animate(
      [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(1.15)`, opacity: 0.4 }, { transform: "none", opacity: 1 }],
      { duration: 520, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  });
}

// ---------------- files ----------------
function fileFan(el: HTMLElement) {
  const kinds = [["PDF", "#d6453d"], ["XLSX", "#1f8a52"], ["MD", "#5b5f6b"], ["PNG", "#c2410c"], ["MP4", "#6e56cf"]];
  el.innerHTML = `<div class="ff">${kinds.map(([k, c], n) => `<span style="--k:${n - 2};--c:${c}"><i></i><b>${k}</b></span>`).join("")}</div>`;
}

// ---------------- dictation: hold to talk ----------------
function voice(el: HTMLElement) {
  const words = t("把这个函数拆成两个，再补一条测试", "Split this function into two and add a test");
  el.innerHTML = `<p class="vo-text"><b></b><span></span></p><button type="button" class="vo-key"><span class="vo-wave" aria-hidden="true">${'<i></i>'.repeat(13)}</span><span class="vo-label">${t("按住说话", "Hold to speak")}</span></button>`;
  const said = el.querySelector<HTMLElement>(".vo-text b")!;
  const rest = el.querySelector<HTMLElement>(".vo-text span")!;
  const key = el.querySelector<HTMLElement>(".vo-key")!;
  const label = el.querySelector<HTMLElement>(".vo-label")!;
  let timer = 0;
  let n = 0;
  const show = () => {
    said.textContent = words.slice(0, n);
    rest.textContent = words.slice(n);
  };
  show();
  const start = () => {
    if (timer) return;
    if (n >= words.length) n = 0;
    el.dataset.on = "";
    label.textContent = t("正在听写", "Listening");
    timer = window.setInterval(() => {
      n = Math.min(n + 1, words.length);
      show();
    }, t(110, 48));
  };
  const stop = () => {
    clearInterval(timer);
    timer = 0;
    delete el.dataset.on;
    label.textContent = n >= words.length ? t("再说一次", "Speak again") : t("按住说话", "Hold to speak");
  };
  key.addEventListener("pointerdown", start);
  for (const type of ["pointerup", "pointercancel", "pointerleave", "blur"]) key.addEventListener(type, stop);
  key.addEventListener("contextmenu", (e) => e.preventDefault());
  key.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    start();
  });
  key.addEventListener("keyup", stop);
}

// ---------------- where the work runs ----------------
function places(el: HTMLElement) {
  const at = [
    { name: t("本机", "Local"), line: "D:\\Project\\omp-web>" },
    { name: "SSH", line: "dev@devbox:~/omp-web$" },
    { name: "WSL", line: "me@Ubuntu:~/omp-web$" },
  ];
  el.innerHTML = `<div class="pl-seg" role="group" aria-label="${t("运行位置", "Workspace target")}"><i aria-hidden="true"></i>${at.map((p, n) => `<button type="button" aria-pressed="${n === 1}">${p.name}</button>`).join("")}</div><p class="pl-line"><span></span><b></b></p>`;
  const buttons = [...el.querySelectorAll<HTMLElement>("button")];
  const seg = el.querySelector<HTMLElement>(".pl-seg")!;
  const line = el.querySelector<HTMLElement>(".pl-line span")!;
  const pick = (n: number) => {
    seg.style.setProperty("--at", String(n));
    buttons.forEach((b, k) => b.setAttribute("aria-pressed", String(k === n)));
    line.textContent = at[n]!.line;
    if (!reduced()) line.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0)" }], { duration: 480, easing: "steps(22)" });
  };
  buttons.forEach((b, n) => b.addEventListener("click", () => pick(n)));
  pick(1);
}

// ---------------- phone ----------------
function phone(el: HTMLElement) {
  const ask = `<p>${t("运行", "Run")} <code>npm run check</code>${t("？", "?")}</p><div><button type="button" data-ok>${t("允许一次", "Allow once")}</button><button type="button">${t("拒绝", "Deny")}</button></div>`;
  el.innerHTML = `<div class="ph"><div class="ph-card">${ask}</div></div>`;
  const card = el.querySelector<HTMLElement>(".ph-card")!;
  card.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("button");
    if (!b) return;
    const ok = b.hasAttribute("data-ok");
    card.innerHTML = `<p class="ph-done">${i(ok ? "check" : "x")}${ok ? t("已允许，电脑上继续执行", "Allowed — running on computer") : t("已拒绝，Agent 会换个做法", "Denied — Agent will adapt")}</p>`;
    setTimeout(() => (card.innerHTML = ask), 2600);
  });
}

// ---------------- BTW: a side question that leaves the main thread running ----------------
function btw(el: HTMLElement) {
  el.innerHTML = `<svg class="bt-map" viewBox="0 0 240 112" aria-hidden="true"><path class="bt-main" pathLength="1" d="M8 36H232"/><path class="bt-side" pathLength="1" d="M62 36C92 36 92 84 122 84H176"/><g class="bt-dots"><circle cx="20" cy="36" r="4.500"/><circle cx="62" cy="36" r="4.500"/><circle cx="122" cy="36" r="4.500"/><circle cx="182" cy="36" r="4.500"/></g><circle class="bt-end" cx="180" cy="84" r="4.500"/><circle class="bt-run" cx="226" cy="36" r="5.500"/></svg><button type="button" class="bt-ask">${t("顺便问一句", "Ask on the side")}</button><span class="bt-answer" aria-live="polite"></span>`;
  const ask = el.querySelector<HTMLElement>(".bt-ask")!;
  const answer = el.querySelector<HTMLElement>(".bt-answer")!;
  ask.addEventListener("click", () => {
    const on = !el.hasAttribute("data-on");
    el.toggleAttribute("data-on", on);
    ask.textContent = on ? t("收起", "Hide") : t("顺便问一句", "Ask on the side");
    answer.textContent = on ? t("主线程没有停", "Main thread kept running") : "";
  });
}

// ---------------- keys: press them for real ----------------
function keys(el: HTMLElement) {
  const caps: [key: string, label: string, does: string][] = [
    ["F6", "F6", t("切到下一个区域", "Switch region")],
    ["ArrowLeft", "←", t("分界线左移", "Move split left")],
    ["ArrowRight", "→", t("分界线右移", "Move split right")],
    ["Escape", "Esc", t("取消这次拖动", "Cancel drag")],
  ];
  el.innerHTML = `<div class="kb-panes" aria-hidden="true"><i></i><i></i><i></i></div><div class="kb">${caps.map(([k, l]) => `<button type="button" data-key="${k}">${l}</button>`).join("")}</div><p class="kb-say" aria-live="polite">${t("按一下试试", "Press a key")}</p>`;
  const say = el.querySelector<HTMLElement>(".kb-say")!;
  const panes = el.querySelector<HTMLElement>(".kb-panes")!;
  const kids = [...panes.children] as HTMLElement[];
  let focus = 0;
  let shift = 0;
  const hit = (key: string) => {
    const cap = caps.find(([k]) => k === key);
    if (!cap) return false;
    if (key === "F6") focus = (focus + 1) % 3;
    else if (key === "ArrowLeft") shift = Math.max(shift - 1, -3);
    else if (key === "ArrowRight") shift = Math.min(shift + 1, 3);
    else shift = 0;
    panes.style.setProperty("--shift", String(shift));
    kids.forEach((k, n) => k.toggleAttribute("data-on", n === focus));
    say.textContent = cap[2];
    const button = el.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
    button.dataset.down = "";
    setTimeout(() => delete button.dataset.down, 160);
    return true;
  };
  el.querySelectorAll<HTMLElement>("[data-key]").forEach((b) => b.addEventListener("click", () => hit(b.dataset.key!)));
  // The real keys work too, while the tile is in use.
  const tile = el.closest<HTMLElement>(".tile-card")!;
  let over = false;
  tile.addEventListener("pointerenter", () => (over = true));
  tile.addEventListener("pointerleave", () => (over = false));
  addEventListener("keydown", (e) => {
    if ((!over && !tile.contains(document.activeElement)) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (hit(e.key)) e.preventDefault();
  });
  kids[0]!.dataset.on = "";
}

const TILES: { id: string; icon: IconName; title: string; text: string; mount: (el: HTMLElement) => void }[] = [
  { id: "computer", icon: "mousePointer", title: t("电脑操作", "Computer Use"), text: t("Agent 的每个动作都配一张画面，可以拖回去看它点了哪里，随时叫停，再决定要不要继续。", "Every Agent action captures a frame you can scrub back through, pause per session, and resume explicitly."), mount: computer },
  { id: "browser", icon: "globe", title: t("聊天浏览器", "Chat Browser"), text: t("点一个页面元素，引用就进了输入框。登录状态会留下来。", "Pick any page element to quote it straight into the composer, with persistent auth profiles and WebMCP."), mount: picker },
  { id: "files", icon: "file", title: t("文件查看器", "File Viewer"), text: t("文档、表格、图片和音视频都在窗口里打开。", "Code, Markdown, PDF, spreadsheets, images, and media all open in workbench windows."), mount: fileFan },
  { id: "voice", icon: "mic", title: t("语音输入", "Voice Dictation"), text: t("按住空格听写，文字落在光标处。", "Hold Space to dictate right at your cursor, with audio recovery if transcription fails."), mount: voice },
  { id: "places", icon: "server", title: t("本机、SSH 与 WSL", "Local, SSH & WSL 2"), text: t("换一台机器，工作台不变。", "Run on local disks, signed SSH hosts, or Windows WSL 2 distros in the same workbench."), mount: places },
  { id: "phone", icon: "smartphone", title: t("手机访问", "Mobile Access"), text: t("同一局域网里扫码配对，在手机上继续对话和审批。", "Pair a phone over LAN HTTPS to review approvals and keep conversations moving."), mount: phone },
  { id: "btw", icon: "messageCircle", title: t("BTW 旁路追问", "BTW Side Questions"), text: t("不打断主线程，单独问一句。", "Ask quick side questions without interrupting the main Agent run."), mount: btw },
  { id: "keys", icon: "keyboard", title: t("键盘可达", "Keyboard Navigation"), text: t("切换区域、微调布局，都不用鼠标。", "Jump across regions and resize split panes without touching the mouse."), mount: keys },
];

export function mountBento(root: HTMLElement) {
  root.innerHTML = TILES.map(
    (t, n) => `<article class="tile-card rv" data-tile="${t.id}" style="--n:${n % 4}"><div class="tile-pic"></div><div class="tile-copy"><h3>${i(t.icon)}${t.title}</h3><p>${t.text}</p></div></article>`,
  ).join("");
  TILES.forEach((t) => t.mount(root.querySelector<HTMLElement>(`[data-tile="${t.id}"] .tile-pic`)!));
}
