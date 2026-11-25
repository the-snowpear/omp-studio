// The app's popover menu: a heading, rows, and rows that unfold into more rows.
import { a, type AppIcon } from "../shared/app-icons";

export interface MenuItem {
  label: string;
  icon?: AppIcon;
  /** Present on rows that are one of a set; true on the current one. */
  checked?: boolean;
  /** Why it cannot be used here. */
  disabled?: string;
  /** A rule above this row. */
  rule?: boolean;
  run?: () => void;
  items?: MenuItem[];
}

export class Menu {
  private el = document.createElement("div");
  private runs: (() => void)[] = [];
  private back: HTMLElement | null = null;
  private onClose?: () => void;

  constructor(layer: HTMLElement) {
    this.el.className = "wm-menu";
    this.el.setAttribute("role", "menu");
    layer.append(this.el);
    this.el.addEventListener("click", (e) => {
      const row = (e.target as Element).closest<HTMLButtonElement>("button");
      if (!row || row.ariaDisabled === "true") return;
      if (row.dataset.fold !== undefined) return this.fold(row);
      const run = this.runs[Number(row.dataset.run)];
      this.close();
      run?.();
    });
    this.el.addEventListener("keydown", (e) => {
      const rows = [...this.el.querySelectorAll<HTMLElement>("button")].filter((b) => b.offsetParent);
      const at = rows.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowDown") rows[(at + 1) % rows.length]?.focus();
      else if (e.key === "ArrowUp") rows[(at - 1 + rows.length) % rows.length]?.focus();
      else if (e.key === "Home") rows[0]?.focus();
      else if (e.key === "End") rows.at(-1)?.focus();
      else if (e.key === "Tab") return this.close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    addEventListener("pointerdown", (e) => {
      if (this.isOpen && !this.el.contains(e.target as Node)) this.close();
    }, true);
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.isOpen) return;
      e.stopPropagation();
      this.close(true);
    }, true);
    addEventListener("scroll", () => this.close(), { passive: true });
    addEventListener("resize", () => this.close());
  }

  get isOpen() {
    return this.el.hasAttribute("data-on");
  }

  private rows(items: MenuItem[]): string {
    return items.map((item) => {
      const n = this.runs.push(item.run ?? (() => {})) - 1;
      const role = item.checked === undefined ? "menuitem" : "menuitemradio";
      const state = `${item.checked === undefined ? "" : ` aria-checked="${item.checked}"`}${item.disabled ? ` aria-disabled="true" title="${item.disabled}"` : ""}`;
      const row = `<button type="button" role="${role}" data-run="${n}"${item.items ? ' data-fold aria-expanded="false"' : ""}${state}>${item.icon ? a(item.icon) : ""}<span></span>${item.items ? a("chevron-d", "wm-menu-end") : item.checked ? a("check", "wm-menu-end") : ""}</button>`;
      return `${item.rule ? "<hr>" : ""}${row}${item.items ? `<div class="wm-menu-sub"><div>${this.rows(item.items)}</div></div>` : ""}`;
    }).join("");
  }

  private labels(items: MenuItem[]): string[] {
    return items.flatMap((item) => [item.label, ...(item.items ? this.labels(item.items) : [])]);
  }

  private fold(row: HTMLElement) {
    const open = row.getAttribute("aria-expanded") !== "true";
    this.el.querySelectorAll("[data-fold]").forEach((r) => r.setAttribute("aria-expanded", String(open && r === row)));
  }

  /** Open with its top left (or, `alignRight`, top right) at a viewport point. */
  open(x: number, y: number, title: string, items: MenuItem[], opts: { alignRight?: boolean; back?: HTMLElement | null; onClose?: () => void } = {}) {
    this.close();
    this.runs = [];
    this.back = opts.back ?? null;
    this.onClose = opts.onClose;
    this.el.setAttribute("aria-label", title);
    this.el.innerHTML = `<p>${title}</p>${this.rows(items)}`;
    // Labels can carry titles a visitor never typed but a page could, so they go in as text.
    const labels = this.labels(items);
    this.el.querySelectorAll("button > span:not(.i)").forEach((s, n) => (s.textContent = labels[n]!));
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const left = Math.min(Math.max(opts.alignRight ? x - w : x, 8), innerWidth - w - 8);
    const top = y + h > innerHeight - 8 ? Math.max(8, Math.min(y - h - 8, innerHeight - h - 8)) : y;
    this.el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    this.el.style.transformOrigin = opts.alignRight ? "100% 0" : "0 0";
    this.el.dataset.on = "";
    if (this.back?.matches(":focus-visible")) this.el.querySelector<HTMLElement>("button")?.focus();
  }

  close(refocus = false) {
    if (!this.isOpen) return;
    this.el.removeAttribute("data-on");
    this.onClose?.();
    if (refocus) this.back?.focus();
  }
}
