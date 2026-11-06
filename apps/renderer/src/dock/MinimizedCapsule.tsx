import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { beginPointerDrag, type DragPoint } from "./pointerDrag";

// UI positions last for this workspace's lifetime; real and preview stores have separate owners.
const positions = new WeakMap<object, Map<string, DragPoint>>();

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  owner: object;
  capsuleId: string;
  locked?: boolean;
  "data-tip"?: string;
};

export function MinimizedCapsule({ owner, capsuleId, locked = false, children, className = "", "data-tip": tip, ...props }: Props) {
  const { resolvedLanguage } = useI18n();
  const anchor = useRef<HTMLSpanElement>(null);
  const [host] = useState(() => document.createElement("span"));
  const position = useRef<DragPoint | null>(null);
  const drag = useRef<ReturnType<typeof beginPointerDrag> | null>(null);
  const top = useRef(8);
  const measureTop = () => { top.current = (anchor.current!.ownerDocument.querySelector(".app-titlebar")?.getBoundingClientRect().bottom ?? 0) + 8; };

  const place = (next: DragPoint | null, size?: { width: number; height: number }) => {
    const slot = anchor.current!, surface = slot.ownerDocument, view = surface.defaultView!;
    const parent = next ? surface.body : slot;
    // Keep the button itself alive when leaving an overflow/transform container, including during pointerup.
    host.classList.toggle("is-detached", !!next);
    if (host.parentNode !== parent) parent.append(host);
    if (!next) { position.current = null; host.removeAttribute("style"); return; }
    const box = size ?? host.getBoundingClientRect();
    position.current = {
      x: Math.max(8, Math.min(next.x, view.innerWidth - box.width - 8)),
      y: Math.max(top.current, Math.min(next.y, view.innerHeight - box.height - 8)),
    };
    Object.assign(host.style, { left: `${position.current.x}px`, top: `${position.current.y}px` });
  };
  const remember = () => {
    let saved = positions.get(owner);
    if (!saved) { saved = new Map(); positions.set(owner, saved); }
    saved.set(capsuleId, position.current!);
  };

  useLayoutEffect(() => {
    host.className = "dock-capsule-host";
    measureTop();
    place(positions.get(owner)?.get(capsuleId) ?? null);
    const view = host.ownerDocument.defaultView!;
    const resize = () => { measureTop(); if (position.current) { place(position.current); if (!drag.current) remember(); } };
    view.addEventListener("resize", resize);
    return () => { drag.current?.cancel(); view.removeEventListener("resize", resize); host.remove(); };
  }, [host, owner, capsuleId]);
  // A live conversation title can change the capsule's width after it has been placed.
  useLayoutEffect(() => { if (position.current && !drag.current) place(position.current); });

  const begin = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || locked) return;
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY }, previous = position.current;
    drag.current = beginPointerDrag(event, {
      onStart: () => { measureTop(); place({ x: box.x, y: box.y }, box); host.classList.add("is-dragging"); },
      onMove: point => { place({ x: box.x + point.x - start.x, y: box.y + point.y - start.y }, box); },
      onDrop: () => { remember(); host.classList.remove("is-dragging"); drag.current = null; },
      onCancel: () => { place(previous); host.classList.remove("is-dragging"); drag.current = null; },
    });
  };
  const hint = resolvedLanguage === "zh" ? "拖动移动 · 点击还原" : "Drag to move · Click to restore";
  return <span className="dock-capsule-anchor" ref={anchor}>{createPortal(
    <button {...props} type="button" className={`dock-capsule ${className}`} data-locked={locked || undefined}
      data-tip={locked ? tip : tip ? `${tip} · ${hint}` : hint} onPointerDown={begin} onDragStart={event => event.preventDefault()}>
      {children}
    </button>, host,
  )}</span>;
}
