import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MarkdownText } from "../conversation/markdown";
import { Icon } from "../icons";
import { PlanAnnotatedBody, type PlanAnnotatedBodyHandle } from "./PlanAnnotatedBody";
import { formatPlanRefineFeedback, type PlanNotesBySection } from "./planFeedback";
import { parsePlanSections } from "./planSections";
import { PromptHead } from "./PromptHead";
import { PLAN_ACTIONS, type PlanActionDetail, type PlanActionId } from "./types";

function PlanHeadActions({
  expanded,
  disabled,
  collapseRef,
  onToggle,
  onDismiss,
}: {
  expanded: boolean;
  disabled?: boolean;
  collapseRef?: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  if (expanded) {
    return (
      <span className="plan-head-actions">
        <button
          {...(collapseRef ? { ref: collapseRef } : {})}
          type="button"
          className="icon-btn small"
          aria-label="收起计划"
          disabled={disabled === true}
          onClick={onToggle}
        >
          <Icon name="x" extra="sm" />
        </button>
      </span>
    );
  }
  return (
    <span className="plan-head-actions">
      <button
        type="button"
        className="icon-btn small"
        aria-label="放大计划"
        disabled={disabled === true}
        onClick={onToggle}
      >
        <Icon name="expand" extra="sm" />
      </button>
      <button
        type="button"
        className="icon-btn small"
        aria-label="关闭计划"
        disabled={disabled === true}
        onClick={onDismiss}
      >
        <Icon name="x" extra="sm" />
      </button>
    </span>
  );
}

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
const PLAN_MORPH_LEAVE_MS = 200;
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

function readOrigin(
  originRef: RefObject<HTMLElement | null>,
  fallbackRef?: RefObject<HTMLElement | null>,
): Box | undefined {
  return readBox(originRef.current) ?? readBox(fallbackRef?.current ?? null);
}

function PlanReviewDialog({
  title,
  body,
  notes,
  overallNote,
  viewOnly,
  originRef,
  fallbackOriginRef,
  annotateRef,
  disabled,
  onClose,
  onAction,
  onPrepareAction,
  onNotesChange,
  onOverallNoteChange,
}: {
  title: string;
  body: string;
  notes: PlanNotesBySection;
  overallNote: string;
  viewOnly?: boolean;
  originRef: RefObject<HTMLElement | null>;
  fallbackOriginRef?: RefObject<HTMLElement | null>;
  annotateRef: RefObject<PlanAnnotatedBodyHandle | null>;
  disabled?: boolean;
  onClose: () => void;
  onAction: (id: PlanActionId, detail?: PlanActionDetail) => void;
  onPrepareAction?: (id: PlanActionId) => void;
  onNotesChange: (notes: Record<number, string[]>) => void;
  onOverallNoteChange: (note: string) => void;
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
    const origin = readOrigin(originRef, fallbackOriginRef);
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
    window.setTimeout(done, PLAN_MORPH_LEAVE_MS + 40);
  }, [fallbackOriginRef, onClose, originRef]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const overlay = overlayRef.current;
    if (!dialog || !overlay) return;
    const origin = readOrigin(originRef, fallbackOriginRef);
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
  }, [fallbackOriginRef, originRef]);

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
          <PlanHeadActions
            expanded
            collapseRef={closeRef}
            onToggle={() => requestClose()}
            onDismiss={() => requestClose()}
            {...(disabled === true ? { disabled: true } : {})}
          />
        </div>
        <div className="plan-review-dialog-body">
          {viewOnly === true ? (
            body.trim().length > 0 ? (
              <div className="plan-md-preview">
                <MarkdownText text={body} />
              </div>
            ) : (
              <p className="dk-sub">当前会话里没有找到计划正文。</p>
            )
          ) : (
            <PlanAnnotatedBody
              ref={annotateRef}
              body={body}
              notes={notes}
              onNotesChange={onNotesChange}
              {...(disabled === true ? { disabled: true } : {})}
            />
          )}
        </div>
        {viewOnly === true ? null : (
        <div className="plan-review-overall">
          <label className="plan-review-overall-label" htmlFor="planOverallNote">全文批注</label>
          <textarea
            id="planOverallNote"
            className="input"
            rows={3}
            value={overallNote}
            disabled={disabled === true}
            aria-label="全文批注"
            placeholder="对整份计划的修改意见…"
            onChange={(event) => onOverallNoteChange(event.target.value)}
          />
        </div>
        )}
        {viewOnly === true ? null : (
        <PlanActions
          onPick={(id) => {
            onPrepareAction?.(id);
            requestClose(() => onAction(id));
          }}
          large
          {...(disabled === true ? { disabled: true } : {})}
        />
        )}
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
  expanded: expandedProp,
  onExpandedChange,
  originRef,
  onAction,
}: {
  title: string;
  body: string;
  demo?: boolean;
  meta?: string;
  disabled?: boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  originRef?: RefObject<HTMLElement | null>;
  onAction: (id: PlanActionId, detail?: PlanActionDetail) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const controlled = expandedProp !== undefined;
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = controlled ? expandedProp : internalExpanded;
  const setExpanded = useCallback((open: boolean) => {
    if (!controlled) setInternalExpanded(open);
    onExpandedChange?.(open);
  }, [controlled, onExpandedChange]);
  const revealFromCard = useCallback(() => {
    if (originRef) originRef.current = cardRef.current;
    setExpanded(true);
  }, [originRef, setExpanded]);
  const [notes, setNotes] = useState<Record<number, string[]>>({});
  const [overallNote, setOverallNote] = useState("");
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const overallNoteRef = useRef(overallNote);
  overallNoteRef.current = overallNote;
  const annotateRef = useRef<PlanAnnotatedBodyHandle>(null);
  const refineNotesRef = useRef<PlanNotesBySection | undefined>(undefined);
  const sections = useMemo(() => parsePlanSections(body), [body]);
  const captureRefineNotes = useCallback(() => {
    refineNotesRef.current = annotateRef.current?.flushDraft() ?? notesRef.current;
  }, []);
  const emitAction = useCallback((id: PlanActionId) => {
    if (id !== "refine") {
      onAction(id);
      return;
    }
    const latest = refineNotesRef.current ?? annotateRef.current?.flushDraft() ?? notesRef.current;
    refineNotesRef.current = undefined;
    const feedback = formatPlanRefineFeedback(sections, latest, overallNoteRef.current);
    if (feedback === undefined) onAction("refine");
    else onAction("refine", { feedback });
  }, [onAction, sections]);
  const closeDialog = useCallback(() => {
    annotateRef.current?.flushDraft();
    setExpanded(false);
  }, [setExpanded]);
  return (
    <div className="approval-card" ref={cardRef}>
      <PromptHead
        icon="alert"
        title="Plan Review"
        {...(demo === true ? { demo: true } : {})}
        {...(meta ? { meta } : {})}
        end={(
          <PlanHeadActions
            expanded={false}
            onToggle={revealFromCard}
            onDismiss={() => emitAction("dismiss")}
            {...(disabled === true ? { disabled: true } : {})}
          />
        )}
      />
      <div
        className="approval-body plan-preview-hit"
        role="button"
        tabIndex={disabled === true ? -1 : 0}
        aria-label="展开完整计划"
        aria-disabled={disabled === true}
        onClick={(event) => {
          if (disabled === true) return;
          if (event.target instanceof Element && event.target.closest("a")) return;
          revealFromCard();
        }}
        onKeyDown={(event) => {
          if (disabled === true) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          revealFromCard();
        }}
      >
        <p className="dk-sub">{title}</p>
        <div className="plan-md-preview">
          <MarkdownText text={body} />
        </div>
      </div>
      <PlanActions onPick={emitAction} {...(disabled === true ? { disabled: true } : {})} />
      {expanded ? (
        <PlanReviewDialog
          title={title}
          body={body}
          notes={notes}
          overallNote={overallNote}
          originRef={originRef ?? cardRef}
          fallbackOriginRef={cardRef}
          annotateRef={annotateRef}
          onClose={closeDialog}
          onAction={emitAction}
          onPrepareAction={(id) => {
            if (id === "refine") captureRefineNotes();
          }}
          onNotesChange={setNotes}
          onOverallNoteChange={setOverallNote}
          {...(disabled === true ? { disabled: true } : {})}
        />
      ) : null}
    </div>
  );
}

export function PlanViewDialog({
  title,
  body,
  originRef,
  onClose,
}: {
  title: string;
  body: string;
  originRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  return (
    <PlanReviewDialog
      title={title}
      body={body}
      notes={{}}
      overallNote=""
      viewOnly
      originRef={originRef}
      annotateRef={{ current: null }}
      onClose={onClose}
      onAction={() => {}}
      onNotesChange={() => {}}
      onOverallNoteChange={() => {}}
    />
  );
}

export function PlanReviewDeck({
  title,
  body,
  meta,
  disabled,
  expanded,
  onExpandedChange,
  originRef,
  onAction,
}: {
  title: string;
  body: string;
  meta?: string;
  disabled?: boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  originRef?: RefObject<HTMLElement | null>;
  onAction: (id: PlanActionId, detail?: PlanActionDetail) => void;
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
          {...(expanded === undefined ? {} : { expanded })}
          {...(onExpandedChange === undefined ? {} : { onExpandedChange })}
          {...(originRef === undefined ? {} : { originRef })}
        />
      </div>
    </div>
  );
}
