// "Show me": a hand walks onto the desk and does one of the things to try. It sends the
// same pointer events a visitor's mouse would, so what is shown is what actually happens.
// Any real press on the desk takes over at once.
import gsap from "gsap";
import type { Quest } from "./pitch";
import type { Workbench } from "./wm";

const HAND = '<svg viewBox="0 0 20 20" width="26" height="26"><path d="M3.3 2.4 16.7 8.7 10.8 10.7 8.8 16.6z"/></svg>';
const POINTER = 4242;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

class TakenOver extends Error {}

export function mountDemo(canvas: HTMLElement, bench: Workbench, themeButton: HTMLElement) {
  return async function demo(quest: Quest): Promise<void> {
    if (quest !== "theme") {
      const r = canvas.getBoundingClientRect();
      if (r.top > innerHeight * 0.4 || r.bottom < innerHeight * 0.5) {
        canvas.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
        await new Promise((done) => setTimeout(done, reduced() ? 50 : 700));
      }
    }
    const layer = document.querySelector<HTMLElement>(".fx-layer")!;
    const hand = document.createElement("div");
    hand.className = "demo-hand";
    hand.innerHTML = HAND;
    layer.append(hand);
    const at = { x: innerWidth * 0.5, y: innerHeight * 0.72, o: 0 };
    const draw = () => {
      hand.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
      hand.style.opacity = String(at.o);
    };
    draw();

    let stopped = false;
    let held = false;
    const takeOver = (e: PointerEvent) => {
      if (e.isTrusted) stopped = true;
    };
    addEventListener("pointerdown", takeOver, true);
    const send = (target: EventTarget, type: string, more: PointerEventInit = {}) =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: POINTER, pointerType: "mouse", clientX: at.x, clientY: at.y, button: 0, ...more }));
    const check = () => {
      if (stopped) throw new TakenOver();
    };
    const go = (x: number, y: number, duration = 0.8) =>
      new Promise<void>((done, fail) => {
        gsap.to(at, {
          x, y, o: 1, duration: reduced() ? 0 : duration, ease: "power3.inOut", overwrite: true,
          onUpdate() {
            draw();
            if (held) send(window, "pointermove");
            if (stopped) {
              this.kill();
              fail(new TakenOver());
            }
          },
          onComplete: done,
        });
      });
    const pause = async (ms: number) => {
      await new Promise((done) => setTimeout(done, reduced() ? 0 : ms));
      check();
    };
    const to = (el: Element, fx = 0.5, fy = 0.5, duration?: number) => {
      const r = el.getBoundingClientRect();
      return go(r.left + r.width * fx, r.top + r.height * fy, duration);
    };
    const press = async (el: HTMLElement) => {
      hand.dataset.down = "";
      await pause(140);
      delete hand.dataset.down;
      el.click();
    };

    try {
      if (quest !== "theme" && quest !== "open" && !bench.fronts().length) bench.open("chat");
      const win = bench.fronts()[0];
      if (quest === "snap" && win) {
        const bar = win.querySelector<HTMLElement>(".ow-bar")!;
        await to(bar, 0.42);
        hand.dataset.down = "";
        held = true;
        send(bar, "pointerdown");
        await pause(140);
        const o = canvas.getBoundingClientRect();
        await go(o.left + o.width * 0.3, o.top + o.height * 0.45, 0.6);
        await go(o.left + 12, o.top + o.height * 0.45, 0.8);
        await pause(600);
        send(window, "pointerup");
        held = false;
        delete hand.dataset.down;
      } else if (quest === "layout" && win) {
        const max = win.querySelector<HTMLElement>('[data-act="max"]')!;
        await to(max);
        send(max, "pointerenter", { bubbles: false });
        await pause(700);
        const cell = canvas.querySelector<HTMLElement>('.picker [data-layout="4"][data-cell="0"]')!;
        await to(cell, 0.5, 0.5, 0.6);
        cell.dataset.hot = "";
        await pause(300);
        await press(cell);
        delete cell.dataset.hot;
      } else if (quest === "open") {
        const item = canvas.querySelector<HTMLElement>(".dock-item:not([data-open])") ?? canvas.querySelector<HTMLElement>(".dock-item")!;
        item.dataset.cue = "";
        await to(item);
        await press(item);
        delete item.dataset.cue;
      } else if (quest === "pin" && win) {
        const pin = win.querySelector<HTMLElement>('[data-act="pin"]')!;
        await to(pin, 0.5, 0.5);
        await press(pin);
        await pause(420);
        // The third of the five: it stays above the whole page.
        const choice = document.querySelector<HTMLElement>('.wm-menu[data-on] [role="menuitemradio"]:nth-of-type(3)')!;
        await to(choice, 0.4, 0.5, 0.5);
        choice.dataset.hot = "";
        await pause(260);
        await press(choice);
      } else if (quest === "merge" && win) {
        if (bench.fronts().length < 2) {
          bench.open("git");
          await pause(700);
        }
        const [held_, ...rest] = bench.fronts();
        const from = held_!.querySelector<HTMLElement>(".ow-bar")!;
        // Somewhere on another window's title bar that can be seen.
        const spots = rest.flatMap((w) => {
          const bar = w.querySelector<HTMLElement>(".ow-bar")!;
          const r = bar.getBoundingClientRect();
          return [0.3, 0.16, 0.45, 0.6].map((f) => ({ bar, x: r.left + r.width * f, y: r.top + r.height / 2 }));
        });
        const aim = spots.find((s) => s.bar.contains(document.elementFromPoint(s.x, s.y))) ?? spots[0]!;
        await to(from, 0.34);
        hand.dataset.down = "";
        held = true;
        send(from, "pointerdown");
        await pause(140);
        await go(aim.x, aim.y, 1.1);
        await pause(650);
        send(window, "pointerup");
        held = false;
        delete hand.dataset.down;
      } else if (quest === "theme") {
        await to(themeButton);
        await press(themeButton);
      }
      await pause(500);
    } catch (e) {
      if (!(e instanceof TakenOver)) throw e;
    } finally {
      removeEventListener("pointerdown", takeOver, true);
      if (held) send(window, "pointercancel");
      document.querySelectorAll(".desk [data-cue], [data-hot]").forEach((el) => {
        el.removeAttribute("data-cue");
        el.removeAttribute("data-hot");
      });
      gsap.to(at, { o: 0, y: at.y + 14, duration: 0.3, overwrite: true, onUpdate: draw, onComplete: () => hand.remove() });
    }
  };
}
