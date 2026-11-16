// 明细表: the features as a bill of materials. The six full pages are
// selectable rows; selecting one shows its real screenshot.
import { i } from "../shared/icons";
import { EXTRAS, PAGES, shot } from "../shared/ui";

export function initParts(): void {
  const body = document.querySelector<HTMLElement>("[data-parts-body]")!;
  const img = document.querySelector<HTMLImageElement>("[data-view-img]")!;
  const title = document.querySelector<HTMLElement>("[data-view-title]")!;
  const no = document.querySelector<HTMLElement>("[data-view-no]")!;
  const pad = (n: number) => String(n).padStart(2, "0");

  body.innerHTML =
    PAGES.map(
      (p, n) =>
        `<tr data-page="${n}"><td>${pad(n + 1)}</td><td><button class="part-name" type="button" aria-pressed="false">${i(p.icon)}${p.title}</button></td><td>${p.text}</td></tr>`,
    ).join("") +
    EXTRAS.map(
      (e, n) =>
        `<tr${n === 0 ? " data-first-extra" : ""}><td>${pad(PAGES.length + n + 1)}</td><td><span class="part-name">${i(e.icon)}${e.title}</span></td><td>${e.text}</td></tr>`,
    ).join("");

  const rows = [...body.querySelectorAll<HTMLElement>("tr[data-page]")];
  let current = -1;
  const select = (n: number) => {
    if (n === current) return;
    current = n;
    const page = PAGES[n]!;
    rows.forEach((r, k) => {
      r.toggleAttribute("data-on", k === n);
      r.querySelector("button")!.setAttribute("aria-pressed", String(k === n));
    });
    img.removeAttribute("data-swap");
    img.src = shot(page.shot, "light");
    img.alt = `${page.title}页面的截图`;
    void img.offsetWidth; // restart the swap animation
    img.setAttribute("data-swap", "");
    title.textContent = page.title;
    no.textContent = `${pad(n + 1)} / ${pad(PAGES.length)}`;
  };
  rows.forEach((row, n) => {
    row.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && select(n));
    row.addEventListener("click", () => select(n));
    row.querySelector("button")!.addEventListener("focus", () => select(n));
  });
  select(0);

  // Warm the other screenshots once the list is near, so rows switch instantly.
  new IntersectionObserver(
    ([entry], io) => {
      if (!entry!.isIntersecting) return;
      io.disconnect();
      PAGES.forEach((p) => (new Image().src = shot(p.shot, "light")));
    },
    { rootMargin: "600px" },
  ).observe(body);
}
