// 功能: the six full pages as screenshots stacked in depth. Scrolling racks
// focus from one to the next; the one in focus is sharp and lit.
import { i } from "../shared/icons";
import { EXTRAS, PAGES, shot } from "../shared/ui";

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export interface Pages {
  el: HTMLElement;
  render(progress: number): void;
}

export function initPages(section: HTMLElement, reduced: boolean): Pages {
  const index = section.querySelector<HTMLElement>("[data-pages-index]")!;
  const text = section.querySelector<HTMLElement>("[data-pages-text]")!;
  const rack = section.querySelector<HTMLElement>("[data-rack]")!;

  index.innerHTML = PAGES.map((p, n) => `<li><button type="button" data-n="${n}">${i(p.icon)}<span>${p.title}</span></button></li>`).join("");
  text.innerHTML = PAGES.map((p) => `<p>${p.text}</p>`).join("");
  rack.innerHTML = PAGES.map((p) =>
    `<figure><img src="${shot(p.shot, "dark")}" alt="" width="1440" height="900" decoding="async" loading="lazy"><i></i></figure>`).join("");

  const extras = document.querySelector<HTMLElement>("[data-extras]")!;
  extras.innerHTML = EXTRAS.map((e) => `<div><dt>${i(e.icon)}${e.title}</dt><dd>${e.text}</dd></div>`).join("");

  const buttons = [...index.querySelectorAll<HTMLButtonElement>("button")];
  const texts = [...text.children] as HTMLElement[];
  const cards = [...rack.children] as HTMLElement[];
  const veils = cards.map((c) => c.querySelector<HTMLElement>("i")!);
  const last = PAGES.length - 1;
  let active = -1;

  const setActive = (n: number) => {
    if (n === active) return;
    active = n;
    buttons.forEach((b, k) => b.toggleAttribute("aria-current", k === n));
    texts.forEach((t, k) => t.toggleAttribute("data-on", k === n));
  };

  if (reduced) {
    // A plain list: every page with its screenshot, nothing scrubbed.
    section.dataset.static = "";
    cards.forEach((card, n) => {
      const cap = document.createElement("figcaption");
      cap.innerHTML = `<h3>${PAGES[n]!.title}</h3><p>${PAGES[n]!.text}</p>`;
      card.append(cap);
    });
    rack.removeAttribute("aria-hidden");
    return { el: section, render() {} };
  }

  // The focal plane dwells on each page, then racks quickly to the next.
  const focusAt = (p: number) => {
    const f = clamp(p) * last;
    const base = Math.floor(f);
    const u = clamp((f - base - 0.3) / 0.4);
    return Math.min(last, base + u * u * (3 - 2 * u));
  };

  const render = (p: number) => {
    const focus = focusAt(p);
    setActive(Math.round(focus));
    const narrow = innerWidth <= 860;
    cards.forEach((card, n) => {
      const d = n - focus; // > 0: still behind the focal plane; < 0: already passed the lens
      const behind = Math.max(0, d);
      const passed = Math.max(0, -d);
      const x = narrow ? behind * 14 : behind * 38 - passed * 30;
      const y = behind * (narrow ? -9 : -30) + passed * 46;
      const s = Math.max(0.5, 1 - behind * 0.07 + passed * 0.16);
      card.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${s.toFixed(4)})`;
      card.style.opacity = clamp(1 - passed * 1.7).toFixed(3);
      card.style.zIndex = String(100 - Math.round(behind * 10));
      // Out of focus is drawn with a veil, not a per-frame blur filter.
      veils[n]!.style.opacity = clamp(behind * 0.52).toFixed(3);
      card.toggleAttribute("data-soft", Math.abs(d) > 0.5);
    });
  };

  buttons.forEach((b, n) =>
    b.addEventListener("click", () => {
      const span = section.offsetHeight - innerHeight;
      window.scrollTo({ top: section.offsetTop + (span * n) / last, behavior: "smooth" });
    }),
  );
  render(0);
  return { el: section, render };
}
