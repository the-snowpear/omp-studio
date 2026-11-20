import { useLayoutEffect, useRef } from "react";
import { useI18n } from "../i18n";

function surfaceOf(handle: HTMLElement) {
  return handle.closest<HTMLElement>(".deck") ?? handle.parentElement!;
}

function heightBounds(handle: HTMLElement, surface: HTMLElement) {
  const top = surface.closest(".convo-wrap")?.getBoundingClientRect().top ?? 0;
  const max = Math.max(0, Math.floor(surface.getBoundingClientRect().bottom - top - 8));
  const card = handle.parentElement!;
  const header = card.querySelector(".form-head, .ask-head, .approval-head")?.getBoundingClientRect().height ?? 0;
  const footer = card.querySelector(".dk-actions")?.getBoundingClientRect().height ?? 0;
  const controls = Array.from(card.querySelectorAll<HTMLElement>(":scope > .plan-compact-editor, :scope > .plan-execution-lock, :scope > .plan-operation-error"))
    .reduce((height, element) => height + element.getBoundingClientRect().height, 0);
  return { min: Math.min(max, Math.ceil(header + footer + controls + 48)), max };
}

/** The bottom of the deck stays anchored. Only the active card owns its height. */
export function QuestionHeightHandle({ visible = true, kind = "question" }: { visible?: boolean; kind?: "question" | "plan" }) {
  const zh = useI18n().resolvedLanguage === "zh";
  const handle = useRef<HTMLDivElement>(null);
  const height = useRef<number | null>(null);
  const drag = useRef<{ y: number; height: number; min: number; max: number } | null>(null);

  function apply(deck: HTMLElement, px: number | null) {
    height.current = px;
    deck.classList.toggle("is-question-sized", px !== null);
    if (px === null) deck.style.removeProperty("--question-height");
    else deck.style.setProperty("--question-height", `${px}px`);
  }
  useLayoutEffect(() => {
    const node = handle.current;
    if (!node || !visible) return;
    const deck = surfaceOf(node);
    apply(deck, height.current);
    const measure = () => {
      const { min, max } = heightBounds(node, deck);
      const current = deck.offsetHeight;
      node.setAttribute("aria-valuemin", String(Math.min(min, current)));
      node.setAttribute("aria-valuemax", String(Math.max(max, current)));
      node.setAttribute("aria-valuenow", String(current));
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : undefined;
    observer?.observe(deck);
    return () => {
      observer?.disconnect();
      drag.current = null;
      deck.style.removeProperty("--question-height");
      deck.classList.remove("is-question-sized");
    };
  }, [visible]);

  const label = kind === "plan" ? (zh ? "调整计划卡高度" : "Resize plan card") : (zh ? "调整提问卡高度" : "Resize question card");
  return <div ref={handle} hidden={!visible} className="question-height-handle" role="separator" tabIndex={0}
    aria-orientation="horizontal" aria-label={label} title={zh ? "上下拖动调整高度，双击恢复自动高度" : "Drag to resize. Double-click for automatic height."}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      const deck = surfaceOf(event.currentTarget);
      drag.current = { y: event.clientY, height: deck.offsetHeight, ...heightBounds(event.currentTarget, deck) };
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const px = Math.round(start.height + start.y - event.clientY);
      apply(surfaceOf(event.currentTarget), Math.max(start.min, Math.min(start.max, px)));
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={event => apply(surfaceOf(event.currentTarget), null)}
    onKeyDown={event => {
      if (!["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const deck = surfaceOf(event.currentTarget);
      if (event.key === "Home") { apply(deck, null); return; }
      const { min, max } = heightBounds(event.currentTarget, deck);
      const px = deck.offsetHeight + (event.key === "ArrowUp" ? 24 : -24);
      apply(deck, Math.max(min, Math.min(max, px)));
    }}
  />;
}
