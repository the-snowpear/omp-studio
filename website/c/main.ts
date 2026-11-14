import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "../shared/base.css";
import "../shared/ui.css";
import "./style.css";
import "./hero.css";
import "./lens.css";
import "./sheets.css";
import "./titleblock.css";

import { piMark } from "../shared/icons";
import { buildAssembly } from "./assembly";
import { initExploded, initPins } from "./exploded";
import { initDownload } from "./download";
import { initLens } from "./lens";
import { initParts } from "./parts";
import { initSnap } from "./snap";

document.querySelectorAll("[data-pi]").forEach((el) => (el.innerHTML = piMark(20)));
document.querySelectorAll("[data-pi-small]").forEach((el) => (el.innerHTML = piMark(14)));

initLens(buildAssembly());
initSnap();
initExploded();
initPins();
initParts();
void initDownload();

// Mark the sheet being read in the top bar.
const links = [...document.querySelectorAll<HTMLAnchorElement>(".top-nav a")];
const seen = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      links.forEach((a) => a.setAttribute("aria-current", String(a.hash === `#${entry.target.id}`)));
    }
  },
  { rootMargin: "-45% 0px -50% 0px" },
);
document.querySelectorAll(".sheet").forEach((s) => seen.observe(s));
