// The hero's side panel. At rest it is type and one button. The headline arrives
// a character at a time and one phrase of it, "随你摆放", is put in place by a
// cursor that then leaves; the visitor can pick the phrase up. The four tools
// named in the lede open their windows on the desk, and each thing-to-try is
// ticked by a spark that flies in from wherever on the page it was done.
import gsap from "gsap";
import { KINDS, type Kind } from "../shared/ui";

export type Quest = "snap" | "layout" | "open" | "pin" | "theme";
interface Point { x: number; y: number }

export interface Pitch {
  /** Tick a thing-to-try. `from` is where it happened; by default, wherever the visitor last acted. */
  complete(quest: Quest, from?: Point): void;
}

const CHECK = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4.6 9.4 7.8 12.4 13.4 5.9"/></svg>';

const root = document.documentElement;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const centre = (r: DOMRect): Point => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export function mountPitch(pitch: HTMLElement, openTool: (kind: Kind) => void): Pitch {
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => pitch.querySelector<T>(sel)!;
  const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...pitch.querySelectorAll<T>(sel)];

  const layer = document.createElement("div");
  layer.className = "fx-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.append(layer);
  const put = (cls: string) => {
    const el = document.createElement("i");
    el.className = cls;
    layer.append(el);
    return el;
  };

  // Where the visitor last did something, so a finished task can fly in from there.
  const last = { x: innerWidth * 0.66, y: innerHeight * 0.5, key: false };
  const track = (e: PointerEvent) => {
    last.x = e.clientX;
    last.y = e.clientY;
    last.key = false;
  };
  addEventListener("pointerdown", track, { capture: true, passive: true });
  addEventListener("pointermove", track, { capture: true, passive: true });
  addEventListener("keydown", () => (last.key = true), { capture: true, passive: true });

  // ---------------- headline ----------------
  // Latin words stay whole so their kerning survives; everything else moves one character at a time.
  const lines = $$(".h-line").map((line) => {
    const chars: HTMLElement[] = [];
    for (const node of [...line.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const parts = document.createDocumentFragment();
      for (const token of node.textContent!.match(/[A-Za-z0-9]+|\s+|./gu) ?? []) {
        if (!token.trim()) {
          parts.append(token);
          continue;
        }
        const slot = document.createElement("span");
        slot.className = "ch";
        const ch = document.createElement("span");
        ch.className = "ch-i";
        ch.textContent = token;
        slot.append(ch);
        parts.append(slot);
        chars.push(ch);
      }
      node.replaceWith(parts);
    }
    return chars;
  });

  const move = $("#h-move");
  const piece = $(".h-piece");
  const slot = $(".h-slot");
  const cursor = $(".h-cursor");
  const snapFlash = () => {
    slot.removeAttribute("data-snap");
    void slot.offsetWidth;
    slot.dataset.snap = "";
  };
  slot.addEventListener("animationend", () => slot.removeAttribute("data-snap"));
  const settle = () => {
    delete piece.dataset.lifted;
    delete move.dataset.away;
    snapFlash();
  };

  // Pick it up. In the air it is a copy above the whole page, so it can be carried across onto the desk.
  let ghost: HTMLElement | null = null;
  piece.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType === "touch" || ghost || move.hasAttribute("data-away")) return;
    e.preventDefault();
    const home = piece.getBoundingClientRect();
    const held = (ghost = piece.cloneNode(true) as HTMLElement);
    held.classList.add("h-ghost");
    held.dataset.lifted = "";
    held.style.fontSize = getComputedStyle(piece).fontSize;
    layer.append(held);
    piece.style.opacity = "0";
    piece.dataset.lifted = "";
    move.dataset.away = "";
    move.dataset.held = "";
    root.dataset.wmDragging = "";
    try {
      piece.setPointerCapture(e.pointerId);
    } catch { /* synthetic pointers may not support capture */ }

    const at = { x: 0, y: 0, r: 0, s: 1 };
    let speed = 0;
    let px = e.clientX;
    const draw = () => (held.style.transform = `translate3d(${home.left + at.x}px, ${home.top + at.y}px, 0) rotate(${at.r}deg) scale(${at.s})`);
    // It swings behind the hand: the faster it is carried sideways, the more it leans.
    const swing = () => {
      at.r += (clamp(speed * 0.55, -11, 11) - at.r) * 0.16;
      speed *= 0.82;
      draw();
    };
    draw();
    gsap.ticker.add(swing);
    gsap.to(at, { s: 1.06, duration: 0.3, ease: "back.out(3)" });

    const carry = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      at.x = ev.clientX - e.clientX;
      at.y = ev.clientY - e.clientY;
      speed = ev.clientX - px;
      px = ev.clientX;
    };
    const drop = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      removeEventListener("pointermove", carry);
      removeEventListener("pointerup", drop);
      removeEventListener("pointercancel", drop);
      gsap.ticker.remove(swing);
      gsap.killTweensOf(at);
      delete root.dataset.wmDragging;
      // Home is reached twice: the slot takes it on first contact, the copy leaves once the spring is still.
      const touch = () => {
        delete held.dataset.lifted;
        settle();
      };
      const rest = () => {
        held.remove();
        ghost = null;
        piece.style.opacity = "";
        delete move.dataset.held;
      };
      if (reduced()) {
        touch();
        return rest();
      }
      // It runs home and overshoots by about a finger's width however far it was carried,
      // then rocks itself level.
      const far = Math.hypot(at.x, at.y);
      const past = clamp(20 / Math.max(far, 1), 0.02, 0.1);
      let kick = 1.7;
      for (let lo = 0, hi = 1.7, n = 0; n < 12; n++) {
        kick = (lo + hi) / 2;
        if ((4 * kick ** 3) / (27 * (kick + 1) ** 2) > past) hi = kick;
        else lo = kick;
      }
      const duration = clamp(0.42 + far / 1500, 0.46, 0.8);
      gsap.to(at, { x: 0, y: 0, duration, ease: `back.out(${kick.toFixed(3)})`, onUpdate: draw });
      gsap.to(at, { r: 0, s: 1, duration: duration + 0.5, ease: "elastic.out(1, 0.42)", onUpdate: draw, onComplete: rest });
      gsap.delayedCall(duration / (kick + 1), touch);
    };
    addEventListener("pointermove", carry);
    addEventListener("pointerup", drop);
    addEventListener("pointercancel", drop);
  });
  // No pointer to drag with on a touch screen: a tap lifts it and lets it fall back.
  piece.addEventListener("click", (e) => {
    if ((e as PointerEvent).pointerType !== "touch" || reduced() || move.hasAttribute("data-away")) return;
    move.dataset.away = "";
    piece.dataset.lifted = "";
    gsap.timeline()
      .to(piece, { x: 20, y: -26, rotate: 6, scale: 1.05, duration: 0.35, ease: "power3.out" })
      .to(piece, { x: 0, y: 0, rotate: 0, scale: 1, duration: 0.9, ease: "elastic.out(1, 0.6)", clearProps: "transform" }, ">0.12")
      .add(settle, "<0.2");
  });

  // ---------------- lede: tools you can press ----------------
  for (const word of $$<HTMLButtonElement>(".tw")) {
    const kind = word.dataset.open as Kind;
    const shelf = () => document.querySelector(`.dock-item[data-kind="${kind}"]`);
    word.style.setProperty("--tint", KINDS[kind].tint);
    word.title = `在工作台打开「${word.textContent}」窗口`;
    word.addEventListener("click", () => openTool(kind));
    for (const [on, off] of [["pointerenter", "pointerleave"], ["focus", "blur"]] as const) {
      word.addEventListener(on, () => shelf()?.setAttribute("data-cue", ""));
      word.addEventListener(off, () => shelf()?.removeAttribute("data-cue"));
    }
  }

  // ---------------- things to try ----------------
  const meter = $("#q-meter");
  const count = $("#q-count");
  const rows = new Map<Quest, HTMLElement>();
  for (const row of $$("[data-quest]")) {
    const quest = row.dataset.quest as Quest;
    rows.set(quest, row);
    row.querySelector(".q-box")!.innerHTML = CHECK;
    // Pointing at a task lights up the control it is about (styles in desk.css).
    row.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") root.dataset.cue = quest;
    });
    row.addEventListener("pointerleave", () => delete root.dataset.cue);
  }
  meter.addEventListener("animationend", () => meter.removeAttribute("data-bump"));

  const started = new Set<Quest>();
  let ticked = 0;
  const tick = (quest: Quest) => {
    const row = rows.get(quest)!;
    row.dataset.done = "";
    row.setAttribute("aria-label", `已完成：${row.querySelector(".q-text")!.textContent}`);
    ticked++;
    count.textContent = String(ticked);
    meter.setAttribute("aria-label", `已完成 ${ticked} 项，共 ${rows.size} 项`);
    meter.dataset.some = "";
    meter.dataset.bump = "";
    if (ticked < rows.size) return;
    $("#quests-done").hidden = false;
    if (!reduced()) confetti(centre(meter.getBoundingClientRect()));
  };

  /** A spark and its tail along an arc from `a` to `b`. */
  const fly = (a: Point, b: Point, arrive: () => void) => {
    const far = Math.hypot(b.x - a.x, b.y - a.y);
    if (far < 48) return arrive();
    const top = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - Math.min(170, far * 0.26) };
    const path: Keyframe[] = [];
    for (let n = 0; n <= 24; n++) {
      const t = n / 24;
      const u = 1 - t;
      const x = u * u * a.x + 2 * u * t * top.x + t * t * b.x;
      const y = u * u * a.y + 2 * u * t * top.y + t * t * b.y;
      path.push({ transform: `translate3d(${x}px, ${y}px, 0) scale(${1.2 - t * 0.5})` });
    }
    const duration = clamp(far * 0.72, 460, 820);
    // The tail is drawn first so the head sits on top of it.
    for (let k = 15; k >= 0; k--) {
      const spark = put("spark");
      spark.style.setProperty("--k", String(k));
      if (k === 0) spark.dataset.head = "";
      spark.animate(path, { duration, delay: k * 5, easing: "cubic-bezier(0.6, 0, 0.2, 1)", fill: "both" }).finished.then(() => {
        spark.remove();
        if (k === 0) arrive();
      });
    }
  };

  const burst = (p: Point) => {
    const ring = put("burst-ring");
    const here = `translate3d(${p.x}px, ${p.y}px, 0)`;
    ring.animate([{ transform: `${here} scale(0.8)`, opacity: 0.9 }, { transform: `${here} scale(2.6)`, opacity: 0 }], { duration: 600, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }).finished.then(() => ring.remove());
  };

  /** All five done: small windows in the tools' own colours are thrown up and fall. */
  const confetti = (p: Point) => {
    const tints = Object.values(KINDS).map((k) => k.tint);
    for (let k = 0; k < 18; k++) {
      const bit = put("bit");
      bit.style.setProperty("--c", tints[k % tints.length]!);
      const dx = rand(-190, 70);
      const up = rand(70, 210);
      const spin = rand(-260, 260);
      bit.animate(
        [
          { transform: `translate3d(${p.x}px, ${p.y}px, 0) rotate(0deg) scale(0.4)`, opacity: 1, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
          { transform: `translate3d(${p.x + dx * 0.62}px, ${p.y - up}px, 0) rotate(${spin * 0.5}deg) scale(1)`, opacity: 1, offset: 0.38, easing: "cubic-bezier(0.5, 0, 0.9, 0.6)" },
          { transform: `translate3d(${p.x + dx}px, ${p.y - up + rand(120, 260)}px, 0) rotate(${spin}deg) scale(0.9)`, opacity: 0 },
        ],
        { duration: rand(1200, 1800), delay: rand(0, 140), fill: "backwards" },
      ).finished.then(() => bit.remove());
    }
  };

  const complete = (quest: Quest, from?: Point) => {
    if (started.has(quest)) return;
    started.add(quest);
    const box = rows.get(quest)!.querySelector(".q-box")!;
    const target = box.getBoundingClientRect();
    const inView = target.width > 0 && target.bottom > 0 && target.top < innerHeight;
    if (reduced() || !inView) return tick(quest);
    const focus = document.activeElement;
    const origin = from ?? (last.key && focus && focus !== document.body ? centre(focus.getBoundingClientRect()) : { x: last.x, y: last.y });
    fly(origin, centre(target), () => {
      tick(quest);
      burst(centre(box.getBoundingClientRect()));
    });
  };

  // ---------------- entrance ----------------
  if (root.dataset.intro === "pending") {
    const faces = [document.fonts.load('800 1em "Noto Sans SC Variable"', "把装进一张随你摆放的工作台"), document.fonts.load('800 1em "Bricolage Grotesque Variable"', "Agent")];
    // Wait for the headline's own type, but not for long: a late font is better than a late page.
    Promise.race([Promise.allSettled(faces), new Promise((done) => setTimeout(done, 900))]).then(() => {
      if (root.dataset.intro !== "pending") return;
      const em = parseFloat(getComputedStyle(piece).fontSize);
      const away = { x: em * 0.92, y: -em * 1.08 };
      // While it carries the phrase the cursor's tip is on the frame's corner; parked, it stands just clear of it.
      const grip = { x: -7, y: -6 };
      const still = "transform,opacity";
      const tl = gsap.timeline({
        defaults: { ease: "expo.out" },
        onComplete: () => delete root.dataset.intro,
      });
      lines.forEach((chars, n) => tl.from(chars, { yPercent: 125, rotate: 6, transformOrigin: "0% 100%", duration: 1.05, stagger: 0.034, clearProps: "all" }, 0.06 + n * 0.13));
      // Everything under the headline comes up quietly, in reading order.
      tl.from([$(".lede"), $(".dl-btn"), $(".cta-meta"), $("#quests-card")], { y: 14, opacity: 0, duration: 1.1, stagger: 0.12, clearProps: still }, 0.5);

      // The slot waits, empty; a cursor brings the phrase over the first line and sets it down.
      move.dataset.away = "";
      piece.dataset.lifted = "";
      tl.fromTo(slot, { opacity: 0 }, { opacity: 1, duration: 0.5, clearProps: "opacity" }, 0.3)
        .fromTo(piece, { x: away.x, y: away.y, rotate: 7, scale: 1.05, opacity: 0 }, { opacity: 1, duration: 0.35, ease: "power2.out" }, 0.74)
        .fromTo(cursor, { x: away.x + grip.x, y: away.y + grip.y, opacity: 0 }, { opacity: 1, duration: 0.35, ease: "power2.out" }, 0.74)
        .to(piece, { x: 0, y: 0, rotate: 0, duration: 0.95, ease: "power4.inOut" }, 1)
        .to(cursor, { ...grip, duration: 0.95, ease: "power4.inOut" }, 1)
        .add(settle, 1.9)
        .to(piece, { scale: 1, duration: 0.55, ease: "back.out(3)", clearProps: still }, 1.9)
        // Its work done, the cursor lets go, drifts off and is gone; the headline is left as plain type.
        .to(cursor, { x: 0, y: 0, duration: 0.6, ease: "power3.out" }, 1.98)
        .to(cursor, { x: 30, y: 22, opacity: 0, duration: 0.7, ease: "power2.in", clearProps: still }, 2.6);
      // The starting poses are in place; let the panel show.
      root.dataset.intro = "run";
    });
  }

  return { complete };
}
