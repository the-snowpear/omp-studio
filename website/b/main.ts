import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/noto-serif-sc/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../shared/base.css";
import "../shared/ui.css";
import "./style.css";
import "./take.css";
import "./world.css";
import "./after.css";
import "./get.css";

import Lenis from "lenis";
import { piMark } from "../shared/icons";
import iconUrl from "../shared/media/icon-512.webp";
import { FACTS } from "../shared/ui";
import { initDownload } from "./get";
import { initPages } from "./pages";
import { buildStills } from "./stills";
import { createTake } from "./take";
import { SENTENCE } from "./world";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

document.querySelectorAll<HTMLElement>("[data-pi]").forEach((el) => (el.innerHTML = piMark(22)));
document.querySelectorAll<HTMLImageElement>("[data-icon], [data-icon-static]").forEach((img) => (img.src = iconUrl));
$("[data-facts]").textContent = `${FACTS.map((f) => `${f.n} ${f.label}`).join("，")}。Windows 和 macOS 都能用，以 MIT 许可证开源。`;

const takeEl = $(".b-take");
const stage = $(".b-stage");
const top = $(".b-top");
const progressOf = (el: HTMLElement) => {
  const span = el.offsetHeight - innerHeight;
  return span > 0 ? Math.min(1, Math.max(0, (scrollY - el.offsetTop) / span)) : 0;
};

const pages = initPages($(".b-pages"), reduced);
void initDownload();

if (reduced) {
  takeEl.dataset.static = "";
  buildStills(stage);
  top.dataset.solid = "";
} else {
  const take = createTake(stage);
  const lenis = new Lenis({ lerp: 0.11, wheelMultiplier: 0.9, anchors: true });

  // The camera eases toward the scroll position, so a wheel notch never reads as a step.
  let shown = -1;
  let pagesShown = -1;
  const frame = (time: number) => {
    lenis.raf(time);
    const target = progressOf(takeEl);
    const next = shown < 0 || Math.abs(target - shown) < 0.0002 ? target : shown + (target - shown) * 0.16;
    if (next !== shown) {
      shown = next;
      take.render(shown);
    }
    const pagesTarget = progressOf(pages.el);
    const pagesNext = pagesShown < 0 || Math.abs(pagesTarget - pagesShown) < 0.0004 ? pagesTarget : pagesShown + (pagesTarget - pagesShown) * 0.18;
    if (pagesNext !== pagesShown) {
      pagesShown = pagesNext;
      pages.render(pagesShown);
    }
    top.toggleAttribute("data-solid", scrollY > takeEl.offsetTop + takeEl.offsetHeight - innerHeight * 0.6);
    requestAnimationFrame(frame);
  };

  const remeasure = () => {
    take.measure();
    shown = -1;
  };
  remeasure();
  requestAnimationFrame(frame);
  let resizeTimer = 0;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(remeasure, 120);
  });
  void document.fonts.ready.then(() => {
    remeasure();
    // The opening sentence types itself once, then scroll takes over.
    let count = 0;
    const type = () => {
      take.setTyped(++count);
      shown = -1;
      if (count < SENTENCE.length) setTimeout(type, 46 + Math.random() * 70);
    };
    setTimeout(type, 500);
  });
}

// Mark the nav link of the section in view.
const links = [...document.querySelectorAll<HTMLAnchorElement>('.b-nav a[href^="#"]')];
const watch = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      links.forEach((a) => a.toggleAttribute("aria-current", a.hash === `#${entry.target.id}`));
    }
  },
  { rootMargin: "-45% 0px -50% 0px" },
);
links.forEach((a) => {
  const target = document.getElementById(a.hash.slice(1));
  if (target) watch.observe(target);
});
