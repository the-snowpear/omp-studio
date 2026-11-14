import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../shared/base.css";
import "../shared/ui.css";
import "./style.css";
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
import { mountRules } from "./rules";
import { Workbench, type WmEvent } from "./wm";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const root = document.documentElement;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

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

// ---------------- things to try ----------------
const QUEST_OF: Partial<Record<WmEvent, string>> = { snap: "snap", layout: "layout", open: "open", pin: "pin" };
const done = new Set<string>();
function complete(id: string) {
  if (done.has(id)) return;
  done.add(id);
  const li = $(`[data-quest="${id}"]`);
  li.dataset.done = "";
  li.setAttribute("aria-label", `已完成：${li.textContent}`);
  if (done.size === 5) $("#quests-done").hidden = false;
}

// ---------------- the workbench ----------------
const canvas = $("#canvas");
const hint = $("#desk-hint");
const bench = new Workbench(canvas, $("#pip"), $("#dock"), $("#wm-preview"), (event) => {
  hint.removeAttribute("data-on");
  const quest = QUEST_OF[event];
  if (quest) complete(quest);
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

// ---------------- theme ----------------
const themeBtn = $("#theme");
const rules = mountRules($("#rules"));

function paintTheme(theme: Theme) {
  root.dataset.theme = theme;
  $$(".omp").forEach((el) => (el.dataset.theme = theme));
  rules.setTheme(theme);
  themeBtn.innerHTML = theme === "dark" ? icon.sun : icon.moon;
  themeBtn.setAttribute("aria-pressed", String(theme === "dark"));
  themeBtn.setAttribute("aria-label", theme === "dark" ? "切换浅色主题" : "切换深色主题");
  $<HTMLMetaElement>('meta[name="theme-color"]').content = theme === "dark" ? "#0d0c14" : "#f6f5fb";
  $$<HTMLImageElement>("[data-shot]").forEach((img) => (img.src = shot(img.dataset.shot as never, theme)));
}
paintTheme((root.dataset.theme as Theme) ?? "light");

themeBtn.addEventListener("click", () => {
  const next: Theme = root.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("omp-site-theme", next);
  } catch { /* private mode: the choice lasts for this visit */ }
  complete("theme");
  if (!document.startViewTransition || reduced()) return paintTheme(next);
  // The new theme opens from the button, like light spreading from a switch.
  const b = themeBtn.getBoundingClientRect();
  const x = b.left + b.width / 2;
  const y = b.top + b.height / 2;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  root.dataset.themeSwap = "";
  const transition = document.startViewTransition(() => paintTheme(next));
  transition.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 620, easing: "cubic-bezier(0.3, 0, 0.1, 1)", pseudoElement: "::view-transition-new(root)" },
    );
  });
  transition.finished.finally(() => delete root.dataset.themeSwap);
});

// ---------------- feature viewer ----------------
const viewer = $("#viewer");
viewer.innerHTML = `<div class="viewer-tabs" role="tablist" aria-label="应用页面">${PAGES.map(
  (p, n) => `<button type="button" role="tab" id="vt-${n}" aria-controls="viewer-panel" aria-selected="${n === 0}" tabindex="${n === 0 ? 0 : -1}">${i(p.icon)}<span>${p.title}</span></button>`,
).join("")}</div>
<div class="viewer-panel" id="viewer-panel" role="tabpanel" aria-labelledby="vt-0">
<div class="viewer-frame"><div class="viewer-bar"><i></i><i></i><i></i><span id="viewer-title"></span></div>
<div class="viewer-shots">${PAGES.map((p, n) => `<img data-shot="${p.shot}" src="${shot(p.shot, root.dataset.theme as Theme)}" alt="${p.title}页面截图" width="1440" height="900" ${n ? 'loading="lazy"' : ""} ${n === 0 ? "data-on" : ""}>`).join("")}</div></div>
<p class="viewer-text" id="viewer-text"></p></div>`;
const tabs = $$(".viewer-tabs [role=tab]");
const shots = $$(".viewer-shots img");
function showPage(n: number, focus = false) {
  const page = PAGES[n]!;
  tabs.forEach((t, k) => {
    t.setAttribute("aria-selected", String(k === n));
    t.tabIndex = k === n ? 0 : -1;
  });
  shots.forEach((s, k) => s.toggleAttribute("data-on", k === n));
  $("#viewer-title").textContent = page.title;
  $("#viewer-text").textContent = page.text;
  $("#viewer-panel").setAttribute("aria-labelledby", `vt-${n}`);
  if (focus) tabs[n]!.focus();
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
showPage(0);

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
const osIcon = (asset: Asset) => (asset.platform === "mac-arm64" ? icon.apple : icon.windows);

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
  $("[data-dl-note]").textContent = mine ? `版本 ${release.version}，${formatSize(mine.bytes)}，${mine.requires}` : "Windows x64 / ARM64 与 macOS Apple Silicon";
  $("#dl-req").textContent = mine ? `${mine.requires}，${formatSize(mine.bytes)}` : "本机系统没有对应的安装包，可以从源码运行。";

  if (old) {
    const pending = $("#dl-pending");
    pending.hidden = false;
    pending.innerHTML = `本页介绍的窗口化工作台属于 ${WORKBENCH_VERSION}，它的安装包还没有发布，现在下载到的是 ${release.version}。想先用上新工作台，可以按右侧的命令从源码运行 <a href="${REPO_URL}/tree/${WORKBENCH_VERSION}">${WORKBENCH_VERSION} 分支</a>，或者在 <a href="${RELEASES_URL}">Releases</a> 等待新版本。`;
  }
});
