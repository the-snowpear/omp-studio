import { iconSvg } from "../icons";
import { MOTION_EASE, MOTION_MS, motionReduced } from "../motion";
import { chipIconName } from "./ingest";
import type { ComposerChipKind } from "./types";
import { acceptsFileScope, composerDropAt, type CapsuleOrigin, type ComposerDropTarget, type ComposerFileScope, type DropPoint, type DroppedChip } from "./composerDrop";
import { beginPointerDrag } from "../dock/pointerDrag";
import type { PointerEvent } from "react";

/**
 * The capsule that follows the pointer while something is dragged towards an
 * input box. DOM and WAAPI only, never React state: it moves every frame and
 * must outlive the drag for the landing flight.
 */

export type CapsuleLook = { readonly kind: ComposerChipKind; readonly label: string; readonly caption?: string | undefined; readonly muted?: boolean };

type Ghost = { element: HTMLElement; chip: HTMLElement; label: HTMLElement; caption: HTMLElement; kind: ComposerChipKind; x: number; y: number; leaving: boolean };
const ghosts = new WeakMap<Document, Ghost>();

/** The pointer sits on the capsule's icon, so the pill reads as held, not pushed. */
const GRAB = { x: 14, y: 14 };

function create(surface: Document, look: CapsuleLook, x: number, y: number): Ghost {
  const element = surface.createElement("div");
  element.className = "capsule-ghost";
  element.setAttribute("aria-hidden", "true");
  const chip = surface.createElement("span");
  const label = surface.createElement("span");
  label.className = "capsule-ghost-label";
  const caption = surface.createElement("span");
  caption.className = "capsule-ghost-caption";
  // Capsule tints are translucent; the pill gives them an opaque ground over any surface.
  const pill = surface.createElement("span");
  pill.className = "capsule-ghost-pill";
  pill.append(chip);
  element.append(pill, caption);
  surface.body.append(element);
  const ghost: Ghost = { element, chip, label, caption, kind: look.kind, x, y, leaving: false };
  paintKind(ghost, look.kind);
  element.style.transform = translate(ghost);
  if (!motionReduced() && typeof element.animate === "function") {
    element.animate([{ opacity: 0, transform: `${translate(ghost)} scale(0.9)` }, { opacity: 1, transform: `${translate(ghost)} scale(1)` }], { duration: MOTION_MS.fast, easing: MOTION_EASE.out });
  }
  return ghost;
}

function paintKind(ghost: Ghost, kind: ComposerChipKind) {
  ghost.kind = kind;
  ghost.chip.className = `cm-chip cm-chip-${kind}`;
  ghost.chip.innerHTML = iconSvg(chipIconName(kind), "sm");
  ghost.chip.append(ghost.label);
}

function translate(ghost: Ghost) { return `translate(${ghost.x}px, ${ghost.y}px)`; }

/** Shows or moves the ghost; returns the pill's viewport box. */
export function showCapsuleGhost(surface: Document, look: CapsuleLook, point: DropPoint): DOMRect {
  let ghost = ghosts.get(surface);
  if (ghost?.leaving) { ghost.element.remove(); ghost = undefined; }
  if (!ghost) {
    ghost = create(surface, look, point.x - GRAB.x, point.y - GRAB.y);
    ghosts.set(surface, ghost);
  }
  if (ghost.kind !== look.kind) paintKind(ghost, look.kind);
  if (ghost.label.textContent !== look.label) ghost.label.textContent = look.label;
  const caption = look.caption ?? "";
  if (ghost.caption.textContent !== caption) ghost.caption.textContent = caption;
  ghost.caption.hidden = caption === "";
  ghost.element.classList.toggle("is-muted", !!look.muted);
  ghost.x = point.x - GRAB.x; ghost.y = point.y - GRAB.y;
  ghost.element.style.transform = translate(ghost);
  return ghost.chip.getBoundingClientRect();
}

export function capsuleGhostRect(surface: Document): DOMRect | null {
  const ghost = ghosts.get(surface);
  return ghost && !ghost.leaving ? ghost.chip.getBoundingClientRect() : null;
}

export function hideCapsuleGhost(surface: Document): void {
  const ghost = ghosts.get(surface);
  if (!ghost || ghost.leaving) return;
  ghosts.delete(surface);
  ghost.leaving = true;
  if (motionReduced() || typeof ghost.element.animate !== "function") { ghost.element.remove(); return; }
  const animation = ghost.element.animate([{ opacity: 1, transform: translate(ghost) }, { opacity: 0, transform: `${translate(ghost)} scale(0.9)` }], { duration: MOTION_MS.tactile, easing: MOTION_EASE.in, fill: "forwards" });
  animation.onfinish = () => ghost.element.remove();
}

/**
 * Flies the ghost onto `target` (a capsule just inserted, or the one the drag
 * started from) and reveals it on landing. Without a target the ghost fades.
 */
export function landCapsuleGhost(surface: Document, target: HTMLElement | null): void {
  const ghost = ghosts.get(surface);
  if (!ghost || ghost.leaving) { target?.classList.remove("is-landing"); return; }
  if (!target || !target.isConnected) { hideCapsuleGhost(surface); return; }
  ghosts.delete(surface);
  ghost.leaving = true;
  const reveal = () => { target.classList.remove("is-landing"); ghost.element.remove(); };
  if (motionReduced() || typeof ghost.element.animate !== "function") { reveal(); return; }
  target.classList.add("is-landing");
  const from = ghost.chip.getBoundingClientRect(), to = target.getBoundingClientRect();
  if (!from.width || !to.width) { reveal(); return; }
  const origin = { x: from.left - ghost.x, y: from.top - ghost.y };
  ghost.caption.hidden = true;
  ghost.element.classList.add("is-landing");
  ghost.element.style.transformOrigin = `${origin.x}px ${origin.y}px`;
  const landed = `translate(${to.left - origin.x}px, ${to.top - origin.y}px) scale(${to.width / from.width}, ${to.height / from.height})`;
  const animation = ghost.element.animate([{ transform: translate(ghost) }, { transform: landed }], { duration: MOTION_MS.slow, easing: MOTION_EASE.ios, fill: "forwards" });
  animation.onfinish = reveal;
  animation.oncancel = reveal;
}

export function capsuleCaptions(zh: boolean) {
  return {
    insert: zh ? "插入到输入框" : "Insert into input",
    move: zh ? "移动胶囊" : "Move capsule",
    cancel: zh ? "松手取消" : "Release to cancel",
    unknown: zh ? "无法打开：来源未确定" : "Can't open: source unknown",
    locked: zh ? "布局已锁定，松手取消" : "Layout locked: release to cancel",
  };
}

/**
 * A capsule that has nowhere to open (a folder, an image, a skill…): it only
 * travels between input boxes. Outside them it says "release to cancel" and
 * flies back to where it came from.
 */
export function dragCapsuleOnly(event: PointerEvent<HTMLElement>, chip: DroppedChip, zh: boolean, origin?: CapsuleOrigin, fileScope?: ComposerFileScope) {
  const surface = event.currentTarget.ownerDocument;
  const captions = capsuleCaptions(zh);
  let hovered: ComposerDropTarget | null = null;
  const finish = () => { hovered?.hideCaret(); origin?.element.classList.remove("is-drag-origin"); };
  const back = () => origin ? landCapsuleGhost(surface, origin.element) : hideCapsuleGhost(surface);
  return beginPointerDrag(event, {
    onStart: () => origin?.element.classList.add("is-drag-origin"),
    onMove: point => {
      if (origin && !origin.element.isConnected) return;
      const candidate = composerDropAt(surface, point);
      const next = candidate && acceptsFileScope(candidate, fileScope) ? candidate : null;
      if (next !== hovered) hovered?.hideCaret();
      hovered = next;
      hovered?.showCaret(point);
      const caption = !hovered ? captions.cancel : origin && hovered === origin.target ? captions.move : captions.insert;
      showCapsuleGhost(surface, { kind: chip.kind, label: chip.label, caption, muted: !hovered }, point);
    },
    onDrop: point => {
      const into = origin && !origin.element.isConnected ? null : hovered;
      finish();
      if (!into) { back(); return; }
      const landed = origin && into === origin.target ? into.moveTo(origin.element, point) : into.insertAt(chip, point);
      if (landed && origin && into !== origin.target) origin.target.remove(origin.chipId);
      landCapsuleGhost(surface, landed);
    },
    onCancel: () => { finish(); back(); },
  });
}
