// What else the app does, as eight small things to handle rather than a list to read.
// Each tile's picture is the feature in miniature, and answers to a press, a drag or a key.
import { i, type IconName } from "../shared/icons";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const HAND = '<svg viewBox="0 0 20 20" width="22" height="22"><path d="M3.3 2.4 16.7 8.7 10.8 10.7 8.8 16.6z"/></svg>';

// ---------------- computer use: scrub through what it did ----------------
const ACTIONS = [
  { x: 0.2, y: 0.2, text: "打开「设置」" },
  { x: 0.14, y: 0.49, text: "点击「外观」" },
  { x: 0.83, y: 0.42, text: "打开「深色模式」" },
  { x: 0.62, y: 0.7, text: "把字号拖到 15" },
  { x: 0.86, y: 0.9, text: "点击「应用」，完成" },
];

function computer(el: HTMLElement) {
  el.innerHTML = `<div class="cu-screen" data-step="0"><div class="cu-app"><aside><b>设置</b><span>通用</span><span class="cu-look">外观</span><span>键盘</span></aside><div class="cu-main"><p><span>深色模式</span><i class="cu-switch"></i></p><p><span>字号</span><i class="cu-slide"><em></em></i></p><div class="cu-foot"><i class="cu-apply">应用</i></div></div></div><span class="cu-hand" aria-hidden="true">${HAND}</span></div>
<div class="cu-strip"><span class="cu-text"></span><input type="range" min="0" max="${ACTIONS.length - 1}" step="0.01" value="0" aria-label="回看操作历史"></div>`;
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
  el.innerHTML = `<div class="pk-page"><button type="button" data-name="h1.title"><b>秋季新品</b></button><button type="button" data-name="p.price"><span>299 元</span></button><button type="button" data-name="button.buy"><em>立即购买</em></button></div>
<div class="pk-input"><span class="pk-chips"></span><span class="pk-hint">选一个页面元素</span>${i("arrowUp")}</div>`;
  const chips = el.querySelector<HTMLElement>(".pk-chips")!;
  const hint = el.querySelector<HTMLElement>(".pk-hint")!;
  el.querySelector(".pk-page")!.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-name]");
    if (!b) return;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "pk-chip";
    chip.setAttribute("aria-label", `移除 ${b.dataset.name}`);
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
  const words = "把这个函数拆成两个，再补一条测试";
  el.innerHTML = `<p class="vo-text"><b></b><span></span></p><button type="button" class="vo-key"><span class="vo-wave" aria-hidden="true">${'<i></i>'.repeat(13)}</span><span class="vo-label">按住说话</span></button>`;
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
    label.textContent = "正在听写";
    timer = window.setInterval(() => {
      n = Math.min(n + 1, words.length);
      show();
    }, 110);
  };
  const stop = () => {
    clearInterval(timer);
    timer = 0;
    delete el.dataset.on;
    label.textContent = n >= words.length ? "再说一次" : "按住说话";
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
    { name: "本机", line: "D:\\Project\\omp-web>" },
    { name: "SSH", line: "dev@devbox:~/omp-web$" },
    { name: "WSL", line: "me@Ubuntu:~/omp-web$" },
  ];
  el.innerHTML = `<div class="pl-seg" role="group" aria-label="运行位置"><i aria-hidden="true"></i>${at.map((p, n) => `<button type="button" aria-pressed="${n === 1}">${p.name}</button>`).join("")}</div><p class="pl-line"><span></span><b></b></p>`;
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
  const ask = `<p>运行 <code>npm run check</code>？</p><div><button type="button" data-ok>允许一次</button><button type="button">拒绝</button></div>`;
  el.innerHTML = `<div class="ph"><div class="ph-card">${ask}</div></div>`;
  const card = el.querySelector<HTMLElement>(".ph-card")!;
  card.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("button");
    if (!b) return;
    const ok = b.hasAttribute("data-ok");
    card.innerHTML = `<p class="ph-done">${i(ok ? "check" : "x")}${ok ? "已允许，电脑上继续执行" : "已拒绝，Agent 会换个做法"}</p>`;
    setTimeout(() => (card.innerHTML = ask), 2600);
  });
}

// ---------------- BTW: a side question that leaves the main thread running ----------------
function btw(el: HTMLElement) {
  el.innerHTML = `<svg class="bt-map" viewBox="0 0 240 112" aria-hidden="true"><path class="bt-main" pathLength="1" d="M8 36H232"/><path class="bt-side" pathLength="1" d="M62 36C92 36 92 84 122 84H176"/><g class="bt-dots"><circle cx="20" cy="36" r="4.500"/><circle cx="62" cy="36" r="4.500"/><circle cx="122" cy="36" r="4.500"/><circle cx="182" cy="36" r="4.500"/></g><circle class="bt-end" cx="180" cy="84" r="4.500"/><circle class="bt-run" cx="226" cy="36" r="5.500"/></svg><button type="button" class="bt-ask">顺便问一句</button><span class="bt-answer" aria-live="polite"></span>`;
  const ask = el.querySelector<HTMLElement>(".bt-ask")!;
  const answer = el.querySelector<HTMLElement>(".bt-answer")!;
  ask.addEventListener("click", () => {
    const on = !el.hasAttribute("data-on");
    el.toggleAttribute("data-on", on);
    ask.textContent = on ? "收起" : "顺便问一句";
    answer.textContent = on ? "主线程没有停" : "";
  });
}

// ---------------- keys: press them for real ----------------
function keys(el: HTMLElement) {
  const caps: [key: string, label: string, does: string][] = [
    ["F6", "F6", "切到下一个区域"],
    ["ArrowLeft", "←", "分界线左移"],
    ["ArrowRight", "→", "分界线右移"],
    ["Escape", "Esc", "取消这次拖动"],
  ];
  el.innerHTML = `<div class="kb-panes" aria-hidden="true"><i></i><i></i><i></i></div><div class="kb">${caps.map(([k, l]) => `<button type="button" data-key="${k}">${l}</button>`).join("")}</div><p class="kb-say" aria-live="polite">按一下试试</p>`;
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
  { id: "computer", icon: "mousePointer", title: "电脑操作", text: "Agent 的每个动作都配一张画面，可以拖回去看它点了哪里，随时叫停，再决定要不要继续。", mount: computer },
  { id: "browser", icon: "globe", title: "聊天浏览器", text: "点一个页面元素，引用就进了输入框。登录状态会留下来。", mount: picker },
  { id: "files", icon: "file", title: "文件查看器", text: "文档、表格、图片和音视频都在窗口里打开。", mount: fileFan },
  { id: "voice", icon: "mic", title: "语音输入", text: "按住空格听写，文字落在光标处。", mount: voice },
  { id: "places", icon: "server", title: "本机、SSH 与 WSL", text: "换一台机器，工作台不变。", mount: places },
  { id: "phone", icon: "smartphone", title: "手机访问", text: "同一局域网里扫码配对，在手机上继续对话和审批。", mount: phone },
  { id: "btw", icon: "messageCircle", title: "BTW 旁路追问", text: "不打断主线程，单独问一句。", mount: btw },
  { id: "keys", icon: "keyboard", title: "键盘可达", text: "切换区域、微调布局，都不用鼠标。", mount: keys },
];

export function mountBento(root: HTMLElement) {
  root.innerHTML = TILES.map(
    (t, n) => `<article class="tile-card rv" data-tile="${t.id}" style="--n:${n % 4}"><div class="tile-pic"></div><div class="tile-copy"><h3>${i(t.icon)}${t.title}</h3><p>${t.text}</p></div></article>`,
  ).join("");
  TILES.forEach((t) => t.mount(root.querySelector<HTMLElement>(`[data-tile="${t.id}"] .tile-pic`)!));
}
