// Page chrome: the top bar's two states, the marker under the current section's link, and
// the one-time entrance of each block.

export function mountNav(top: HTMLElement, mark: HTMLElement, nav: HTMLElement) {
  new IntersectionObserver(([entry]) => top.toggleAttribute("data-stuck", !entry!.isIntersecting)).observe(mark);

  const pill = document.createElement("i");
  pill.className = "nav-pill";
  pill.setAttribute("aria-hidden", "true");
  nav.prepend(pill);
  const links = [...nav.querySelectorAll<HTMLAnchorElement>("a")];
  let current: HTMLAnchorElement | undefined;
  const move = (link: HTMLAnchorElement | undefined) => {
    pill.toggleAttribute("data-on", !!link);
    if (!link) return;
    pill.style.width = `${link.offsetWidth}px`;
    pill.style.transform = `translate3d(${link.offsetLeft}px, 0, 0)`;
  };
  const select = (id: string) => {
    current = links.find((a) => a.hash === `#${id}`);
    links.forEach((a) => (a === current ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
    move(current);
  };
  // The section crossing the middle of the screen is the current one. "more" belongs to 功能.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) select(e.target.id === "more" ? "features" : e.target.id);
  }, { rootMargin: "-50% 0px -50% 0px" });
  document.querySelectorAll("main > section").forEach((s) => io.observe(s));
  links.forEach((a) => {
    a.addEventListener("pointerenter", () => move(a));
    a.addEventListener("focus", () => move(a));
    a.addEventListener("blur", () => move(current));
  });
  nav.addEventListener("pointerleave", () => move(current));
  document.fonts.ready.then(() => move(current));
}

export function mountReveal() {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      (e.target as HTMLElement).dataset.in = "";
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".rv").forEach((el) => io.observe(el));
}
