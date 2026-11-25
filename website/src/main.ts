import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../shared/base.css";
import "../shared/ui.css";
import "./style.css";
import "./pitch.css";
import "./desk.css";
import "./sections.css";
import "./viewer.css";
import "./bento.css";
import "./download.css";

import { t } from "../shared/i18n";
import { icon, piMark } from "../shared/icons";
import type { Theme } from "../shared/ui";
import iconUrl from "../shared/media/icon-256.webp";
import { mountBento } from "./bento";
import { mountDemo } from "./demo";
import { mountDownload } from "./download";
import { mountNav, mountReveal } from "./page";
import { mountPitch, type Quest } from "./pitch";
import { mountRules } from "./rules";
import { mountViewer } from "./viewer";
import { mountWall } from "./wall";
import { Workbench, type WmEvent } from "./wm";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const root = document.documentElement;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const currentTheme = (): Theme => (root.dataset.theme === "dark" ? "dark" : "light");

// A missing live build served as this page must not boot inside its own iframe.
if (!(window.self !== window.top && new URLSearchParams(location.search).get("embed") === "1")) boot();

function boot() {
  $$("[data-pi]").forEach((el) => (el.innerHTML = piMark(22)));
  $("#gh").innerHTML = icon.github;
  $<HTMLImageElement>("#dl-icon").src = iconUrl;

  const toastEl = $("#toast");
  let toastTimer = 0;
  const toast = (text: string) => {
    toastEl.textContent = text;
    toastEl.dataset.on = "";
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.removeAttribute("data-on"), 2200);
  };

  // ---------------- the side panel and the workbench ----------------
  const QUEST_OF: Partial<Record<WmEvent, Quest>> = { snap: "snap", merge: "merge", layout: "layout", open: "open", pin: "pin" };
  const canvas = $("#canvas");
  const hint = $("#desk-hint");
  const themeBtn = $("#theme");
  const walls = [mountWall($("#wall")), mountWall($("#dl-wall"), 52)];
  const bench = new Workbench(canvas, $("#pip"), $("#dock"), $("#wm-preview"), walls[0]!, (event) => {
    hint.removeAttribute("data-on");
    const quest = QUEST_OF[event];
    if (quest) pitch.complete(quest);
  }, toast);
  const pitch = mountPitch($("#pitch"), (kind) => bench.open(kind), mountDemo(canvas, bench, themeBtn));
  const compact = canvas.clientWidth < 620;
  bench.open("chat", true, 250);
  if (!compact) bench.open("plan", true, 370);
  // Two tools in one window, so the desk opens with a tab strip to play with.
  if (compact) bench.open("browser", true, 370);
  else bench.openGroup(["browser", "terminal"], true, 490);
  bench.open("chat", true);

  // Point at the title bar until the visitor has moved something.
  setTimeout(() => {
    const bar = bench.barRect("chat");
    if (!bar) return;
    const o = canvas.getBoundingClientRect();
    const above = bar.top - o.top > 84;
    hint.toggleAttribute("data-below", !above);
    hint.style.transform = `translate3d(${bar.left - o.left + bar.width * 0.42}px, ${above ? bar.top - o.top - 34 : bar.bottom - o.top + 10}px, 0)`;
    hint.dataset.on = "";
  }, 3200);
  canvas.addEventListener("pointerdown", () => hint.removeAttribute("data-on"), { once: true });

  // ---------------- sections ----------------
  const rules = mountRules($("#rules"));
  const viewer = mountViewer($("#viewer"), currentTheme, (theme) => {
    remember(theme);
    paintTheme(theme, false);
  });
  mountBento($("#bento"));
  mountDownload(toast);
  mountNav($("#top"), $("#top-mark"), $("#top-nav"));
  mountReveal();

  // ---------------- theme ----------------
  function remember(theme: Theme) {
    try {
      localStorage.setItem("omp-site-theme", theme);
    } catch { /* private mode: the choice lasts for this visit */ }
  }

  function paintTheme(theme: Theme, notifyFrame = true) {
    const dark = theme === "dark";
    root.dataset.theme = theme;
    $$(".omp").forEach((el) => (el.dataset.theme = theme));
    rules.setTheme(theme);
    walls.forEach((w) => w.setDark(dark));
    themeBtn.innerHTML = dark ? icon.sun : icon.moon;
    themeBtn.setAttribute("aria-pressed", String(dark));
    themeBtn.setAttribute("aria-label", dark ? t("切换浅色主题", "Switch to light theme") : t("切换深色主题", "Switch to dark theme"));
    $<HTMLMetaElement>('meta[name="theme-color"]').content = dark ? "#0c0c10" : "#f4f4f7";
    viewer.setTheme(theme, notifyFrame);
  }
  paintTheme(currentTheme(), false);

  themeBtn.addEventListener("click", () => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    remember(next);
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
      await viewer.syncTheme(next);
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
}
