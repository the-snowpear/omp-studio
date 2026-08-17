import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MarkdownText } from "../conversation/markdown";
import { Icon } from "../icons";
import { PromptHead } from "./PromptHead";
import { PLAN_ACTIONS, type PlanActionId } from "./types";

function PlanActions({
  onPick,
  large,
  disabled,
}: {
  onPick: (id: PlanActionId) => void;
  large?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="dk-actions">
      {PLAN_ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          className={`btn ${large ? "lg" : "small"}${action.primary ? " primary" : " outline"}`}
          disabled={disabled}
          onClick={() => onPick(action.id)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

type Box = { top: number; left: number; width: number; height: number };

const PLAN_MORPH_MS = 340;
const PLAN_CLIP_FULL = "inset(0px 0px 0px 0px round var(--r-10))";

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function readBox(el: HTMLElement | null): Box | undefined {
  if (!el) return undefined;
  const rect = el.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return undefined;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function morphToOrigin(dialog: HTMLElement, origin: Box) {
  const target = dialog.getBoundingClientRect();
  const top = Math.max(0, origin.top - target.top);
  const right = Math.max(0, target.right - origin.left - origin.width);
  const bottom = Math.max(0, target.bottom - origin.top - origin.height);
  const left = Math.max(0, origin.left - target.left);
  dialog.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px round var(--r-10))`;
  dialog.style.transformOrigin =
    `${origin.left + origin.width / 2 - target.left}px ${origin.top + origin.height / 2 - target.top}px`;
  dialog.style.transform = "scale(0.985)";
  dialog.style.opacity = "0";
}

function morphToFull(dialog: HTMLElement) {
  dialog.style.clipPath = PLAN_CLIP_FULL;
  dialog.style.transform = "none";
  dialog.style.opacity = "1";
}

function PlanReviewDialog({
  title,
  body,
  originRef,
  disabled,
  onClose,
  onAction,
}: {
  title: string;
  body: string;
  originRef: RefObject<HTMLElement | null>;
  disabled?: boolean;
  onClose: () => void;
  onAction: (id: PlanActionId) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const leavingRef = useRef(false);
  const host = typeof document === "object" ? document.body : null;

  const requestClose = useCallback((after?: () => void) => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    const dialog = dialogRef.current;
    const overlay = overlayRef.current;
    const origin = readBox(originRef.current);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (after) after();
      else onClose();
    };
    if (!dialog || !overlay || !origin || prefersReducedMotion()) {
      done();
      return;
    }
    overlay.classList.remove("is-open");
    overlay.classList.add("is-leave");
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== dialog || event.propertyName !== "clip-path") return;
      dialog.removeEventListener("transitionend", onEnd);
      done();
    };
    dialog.addEventListener("transitionend", onEnd);
    morphToOrigin(dialog, origin);
    window.setTimeout(done, PLAN_MORPH_MS + 80);
  }, [onClose, originRef]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const overlay = overlayRef.current;
    if (!dialog || !overlay) return;
    const origin = readBox(originRef.current);
    if (!origin || prefersReducedMotion()) {
      overlay.classList.add("is-open");
      closeRef.current?.focus();
      return;
    }
    dialog.classList.add("no-anim");
    morphToOrigin(dialog, origin);
    dialog.getBoundingClientRect();
    dialog.classList.remove("no-anim");
    overlay.classList.add("is-open");
    morphToFull(dialog);
    closeRef.current?.focus();
  }, [originRef]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  if (!host) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="plan-review-overlay"
      role="presentation"
      onMouseDown={() => requestClose()}
    >
      <div
        ref={dialogRef}
        className="plan-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="planReviewDialogTitle"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="plan-review-dialog-head">
          <span id="planReviewDialogTitle" className="plan-review-dialog-title">
            Plan Review · {title}
          </span>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn small"
            aria-label="关闭计划"
            onClick={() => requestClose()}
          >
            <Icon name="x" extra="sm" />
          </button>
        </div>
        <div className="plan-review-dialog-body">
          <MarkdownText text={body} />
        </div>
        <PlanActions onPick={(id) => requestClose(() => onAction(id))} large {...(disabled === true ? { disabled: true } : {})} />
      </div>
    </div>,
    host,
  );
}

export function PlanCard({
  title,
  body,
  demo,
  meta,
  disabled,
  onAction,
}: {
  title: string;
  body: string;
  demo?: boolean;
  meta?: string;
  disabled?: boolean;
  onAction: (id: PlanActionId) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="approval-card" ref={cardRef}>
      <PromptHead
        icon="alert"
        title="Plan Review"
        {...(demo === true ? { demo: true } : {})}
        {...(meta ? { meta } : {})}
        end={(
          <button
            type="button"
            className="icon-btn small"
            aria-label="放大计划"
            onClick={() => setExpanded(true)}
          >
            <Icon name="expand" extra="sm" />
          </button>
        )}
      />
      <div className="approval-body">
        <p className="dk-sub">{title}</p>
        <div className="plan-md-preview">
          <MarkdownText text={body} />
        </div>
      </div>
      <PlanActions onPick={onAction} {...(disabled === true ? { disabled: true } : {})} />
      {expanded ? (
        <PlanReviewDialog
          title={title}
          body={body}
          originRef={cardRef}
          onClose={() => setExpanded(false)}
          onAction={onAction}
          {...(disabled === true ? { disabled: true } : {})}
        />
      ) : null}
    </div>
  );
}

export function PlanReviewDeck({
  title,
  body,
  meta,
  disabled,
  onAction,
}: {
  title: string;
  body: string;
  meta?: string;
  disabled?: boolean;
  onAction: (id: PlanActionId) => void;
}) {
  return (
    <div className="deck active preview-queue" role="region" aria-label="待审核的计划" aria-live="polite">
      <div className="deck-card">
        <PlanCard
          title={title}
          body={body}
          onAction={onAction}
          {...(meta ? { meta } : {})}
          {...(disabled === true ? { disabled: true } : {})}
        />
      </div>
    </div>
  );
}
