import type { NativePlanOption } from "@omp-studio/studio-protocol";
import { PlanExecutionPicker } from "./PlanExecutionPicker";
import { getPreviewPlanExecution } from "../preview/planExecutionPreview";
import { usePreviewMode } from "../preview/PreviewContext";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MarkdownText } from "../conversation/markdown";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { PlanWorkspace } from "./PlanWorkspace";
import { PlanDocument } from "./planDocument";
import { QuestionHeightHandle } from "./QuestionHeightHandle";
import { formatPlanRefineFeedback } from "./planFeedback";
import { parsePlanSections } from "./planSections";
import { PromptHead } from "./PromptHead";
import { PLAN_ACTIONS, type PlanActionDetail, type PlanActionId } from "./types";
import { MOTION_MS, MOTION_SLACK_MS, motionReduced } from "../motion";
import "./planEditor.css";

export type PlanOperationResult = boolean | void | { ok: boolean; error?: string; cancelled?: boolean };
type PlanActionHandler = (id: PlanActionId, detail?: PlanActionDetail) => PlanOperationResult | Promise<PlanOperationResult>;
type PlanSaveHandler = () => PlanOperationResult | Promise<PlanOperationResult>;

function PlanHeadActions({
  expanded,
  disabled,
  collapseRef,
  onSaveAndQuit,
  onToggle,
  onDismiss,
}: {
  expanded: boolean;
  disabled?: boolean;
  collapseRef?: RefObject<HTMLButtonElement | null>;
  onSaveAndQuit?: () => void;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  if (expanded) {
    return (
      <span className="plan-head-actions">
        <PlanSaveAndQuitButton
          {...(onSaveAndQuit === undefined ? {} : { onSaveAndQuit })}
          {...(disabled === true ? { disabled: true } : {})}
        />
        <button
          {...(collapseRef ? { ref: collapseRef } : {})}
          type="button"
          className="icon-btn small"
          aria-label={zh ? "收起计划" : "Collapse plan"}
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
      <PlanSaveAndQuitButton
        {...(onSaveAndQuit === undefined ? {} : { onSaveAndQuit })}
        {...(disabled === true ? { disabled: true } : {})}
      />
      <button
        type="button"
        className="icon-btn small"
        aria-label={zh ? "放大计划" : "Expand plan"}
        disabled={disabled === true}
        onClick={onToggle}
      >
        <Icon name="expand" extra="sm" />
      </button>
      <button
        type="button"
        className="icon-btn small"
        aria-label={zh ? "关闭计划" : "Dismiss plan"}
        disabled={disabled === true}
        onClick={onDismiss}
      >
        <Icon name="x" extra="sm" />
      </button>
    </span>
  );
}

function PlanSaveAndQuitButton({
  onSaveAndQuit,
  disabled,
}: {
  onSaveAndQuit?: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  if (!onSaveAndQuit) return null;
  /* 路径获取在 App 侧（桌面原生另存为对话框 / 浏览器 prompt 回退），
     按钮只负责触发——Electron 渲染进程不支持 window.prompt，不能在这里收集输入。 */
  return (
    <button
      type="button"
      className="icon-btn small plan-save-and-quit"
      aria-label={t("deck.saveAndQuit")}
      data-tip={t("deck.saveAndQuit")}
      disabled={disabled}
      onClick={() => onSaveAndQuit()}
    >
      <Icon name="save-exit" extra="sm" />
    </button>
  );
}

function PlanActions({
  options,
  onPick,
  large,
  disabled,
}: {
  options?: readonly NativePlanOption[] | undefined;
  onPick: (id: PlanActionId) => void;
  large?: boolean;
  disabled?: boolean;
}) {
  const zh = useI18n().resolvedLanguage === "zh";
  const labels = { execute: "批准并执行", keep: "批准并保留上下文", compact: "批准并压缩上下文", refine: "请求修改", dismiss: "关闭" };
  return (
    <div className="dk-actions">
      {PLAN_ACTIONS.filter(action => !options || options.some(option => option.kind === action.id)).map((action) => (
        <button
          key={action.id}
          type="button"
          className={`btn ${large ? "lg" : "small"}${action.primary ? " primary" : " outline"}`}
          disabled={disabled || options?.find(option => option.kind === action.id)?.disabled}
          title={options?.find(option => option.kind === action.id)?.description}
          onClick={() => onPick(action.id)}
        >
          {zh ? labels[action.id] : action.label}
        </button>
      ))}
    </div>
  );
}

type Box = { top: number; left: number; width: number; height: number };
/** `.plan-review-overlay.is-leave`：大卡收回原位（--dur-slow）。 */
const PLAN_MORPH_LEAVE_MS = MOTION_MS.slow;
const PLAN_CLIP_FULL = "inset(0px 0px 0px 0px round var(--r-10))";

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
  overallNote,
  overallExpanded = false,
  viewOnly,
  originRef,
  fallbackOriginRef,
  disabled,
  onClose,
  onAction,
  onSaveAndQuit,
  executionControl,
  options,
  editor,
  content,
  onOverallNoteChange,
  onOverallExpandedChange,
}: {
  title: string;
  body: string;
  overallNote: string;
  overallExpanded?: boolean;
  viewOnly?: boolean;
  originRef: RefObject<HTMLElement | null>;
  fallbackOriginRef?: RefObject<HTMLElement | null>;
  disabled?: boolean;
  onClose: () => void;
  onAction: (id: PlanActionId) => Promise<boolean>;
  onSaveAndQuit?: () => void;
  executionControl?: ReactNode;
  options?: readonly NativePlanOption[] | undefined;
  editor?: ReactNode;
  content?: ReactNode;
  onOverallNoteChange: (note: string) => void;
  onOverallExpandedChange?: (open: boolean) => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
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
    if (!dialog || !overlay || !origin || motionReduced()) {
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
    window.setTimeout(done, PLAN_MORPH_LEAVE_MS + MOTION_SLACK_MS);
  }, [fallbackOriginRef, onClose, originRef]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const overlay = overlayRef.current;
    if (!dialog || !overlay) return;
    const origin = readOrigin(originRef, fallbackOriginRef);
    if (!origin || motionReduced()) {
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
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
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
          {viewOnly === true ? <Icon name="file-code" extra="sm plan-review-dialog-ic" /> : null}
          <span id="planReviewDialogTitle" className="plan-review-dialog-title">
            {viewOnly === true ? `${zh ? "计划详情" : "Plan"} · ${title}` : `Plan Review · ${title}`}
          </span>
          {viewOnly === true ? (
            <span className="chip green xs">{zh ? "已批准" : "Approved"}</span>
          ) : null}
          <PlanHeadActions
            expanded
            collapseRef={closeRef}
            {...(onSaveAndQuit === undefined ? {} : { onSaveAndQuit })}
            onToggle={() => requestClose()}
            onDismiss={() => requestClose()}
            {...(disabled === true ? { disabled: true } : {})}
          />
        </div>
        {editor}
        {viewOnly === true ? <div className="plan-review-dialog-body">
          {body.trim().length > 0 ? (
              <div className="plan-view-doc">
                <MarkdownText text={body} />
              </div>
            ) : (
              <p className="dk-sub">{zh ? "当前会话里没有找到计划正文。" : "No plan content found in the current session."}</p>
            )}
        </div> : content}
        {viewOnly === true ? null : (
        <div className="plan-review-overall">
          <button type="button" className="plan-overall-toggle" aria-expanded={overallExpanded}
            aria-controls="planOverallNote" onClick={() => onOverallExpandedChange?.(!overallExpanded)}>
            <Icon name="message" extra="sm" />
            <span>{zh ? "全文批注" : "Overall annotations"}</span>
            {overallNote.trim() ? <span className="plan-overall-filled">{zh ? "有批注" : "Has notes"}</span> : null}
            <Icon name="chevron-d" extra={`sm plan-overall-chevron${overallExpanded ? " is-open" : ""}`} />
          </button>
          <textarea
            id="planOverallNote"
            className="input"
            hidden={!overallExpanded}
            rows={3}
            value={overallNote}
            disabled={disabled === true}
            aria-label={zh ? "全文批注" : "Overall annotations"}
            placeholder={zh ? "对整份计划的修改意见…" : "Suggested edits for the entire plan…"}
            onChange={(event) => onOverallNoteChange(event.target.value)}
          />
        </div>
        )}
        {viewOnly === true ? null : (
        <>
        {executionControl ? <fieldset className="plan-execution-lock" disabled={disabled === true}>{executionControl}</fieldset> : null}
        <PlanActions options={options}
          onPick={(id) => {
            void onAction(id).then(ok => { if (ok) requestClose(); });
          }}
          large
          {...(disabled === true ? { disabled: true } : {})}
        />
        </>
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
  onSaveAndQuit,
  executionControl,
  options,
  onSaveMarkdown,
}: {
  title: string;
  body: string;
  demo?: boolean;
  meta?: string;
  disabled?: boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  originRef?: RefObject<HTMLElement | null>;
  onAction: PlanActionHandler;
  onSaveAndQuit?: PlanSaveHandler;
  executionControl?: ReactNode;
  options?: readonly NativePlanOption[] | undefined;
  onSaveMarkdown?: ((markdown: string) => Promise<PlanOperationResult>) | undefined;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview } = usePreviewMode();
  const [document] = useState(() => new PlanDocument(body));
  const { markdown: displayedBody, notes } = useSyncExternalStore(document.subscribe, document.getSnapshot);
  const [savedMarkdown, setSavedMarkdown] = useState(body);
  const baseline = useRef(savedMarkdown);
  baseline.current = savedMarkdown;
  const lastBody = useRef(body);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const operationLock = useRef(false);
  const [operationError, setOperationError] = useState<{ kind: "save" | "submit"; message?: string }>();
  const [hasSaved, setHasSaved] = useState(false);
  const dirty = displayedBody !== savedMarkdown;
  const locked = disabled === true || saving;
  const canEdit = Boolean(onSaveMarkdown || preview || demo);
  useEffect(() => {
    if (body === lastBody.current) return;
    lastBody.current = body;
    if (document.getSnapshot().markdown === baseline.current) document.replaceMarkdown(body);
    baseline.current = body;
    setSavedMarkdown(body);
  }, [body, document]);
  const checkResult = (result: PlanOperationResult, kind: "save" | "submit"): boolean => {
    if (result === false) { setOperationError({ kind }); return false; }
    if (result && typeof result === "object" && !result.ok) {
      if (result.cancelled) return false;
      setOperationError({ kind, ...(result.error ? { message: result.error } : {}) });
      return false;
    }
    return true;
  };
  const saveCurrent = async () => {
    const markdown = document.getSnapshot().markdown;
    if (markdown === baseline.current) return true;
    if (!canEdit) { setOperationError({ kind: "save" }); return false; }
    const result = onSaveMarkdown ? await onSaveMarkdown(markdown) : true;
    if (!checkResult(result, "save")) return false;
    baseline.current = markdown;
    setSavedMarkdown(markdown);
    setHasSaved(true);
    return true;
  };
  const perform = async (operation?: () => PlanOperationResult | Promise<PlanOperationResult>) => {
    if (disabled || operationLock.current) return false;
    operationLock.current = true;
    setSaving(true);
    setOperationError(undefined);
    let kind: "save" | "submit" = "save";
    try {
      if (!await saveCurrent()) return false;
      kind = "submit";
      return operation ? checkResult(await operation(), kind) : true;
    } catch (error) {
      setOperationError({ kind, message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally { operationLock.current = false; setSaving(false); }
  };
  const savePlan = () => { void perform(); };
  const saveAndQuit = onSaveAndQuit ? () => { void perform(onSaveAndQuit); } : undefined;
  const errorMessage = operationError?.message ?? (operationError?.kind === "save"
    ? (zh ? "保存计划失败，请重试。" : "Could not save the plan. Please try again.")
    : (zh ? "提交失败，请重试。" : "Could not submit. Please try again."));
  const editor = <>
    {canEdit ? <div className="plan-editor-toolbar">
      <div className="plan-view-switch" role="group" aria-label={zh ? "计划视图" : "Plan view"}>
        <button type="button" aria-pressed={!editing} onClick={() => setEditing(false)}><Icon name="eye" extra="sm" />{zh ? "阅读" : "Read"}</button>
        <button type="button" aria-pressed={editing} onClick={() => setEditing(true)}><Icon name="pencil" extra="sm" />{zh ? "编辑" : "Edit"}</button>
      </div>
      <span className={`plan-save-status${dirty ? " is-dirty" : ""}`} role="status">
        {saving ? (zh ? "正在处理…" : "Working…") : dirty ? (zh ? "未保存" : "Unsaved") : hasSaved ? (zh ? "已保存" : "Saved") : (zh ? "计划正文" : "Plan document")}
      </span>
      {/* 文字标签收进 data-tip（通用悬停提示），快捷键提示撤掉——工具栏只留一个方形主操作按钮。 */}
      <button
        type="button"
        className="icon-btn plan-save-button"
        aria-label={zh ? "保存计划" : "Save plan"}
        data-tip={zh ? "保存计划" : "Save plan"}
        disabled={locked || !dirty}
        onClick={savePlan}
      >
        <Icon name="save" />
      </button>
    </div> : null}
    {operationError ? <div className="plan-operation-error" role="alert"><Icon name="alert" extra="sm" />{errorMessage}</div> : null}
  </>;
  const [demoRole, setDemoRole] = useState("default");
  const tierControl = executionControl ?? ((demo || preview) ? <PlanExecutionPicker details={getPreviewPlanExecution(zh)} role={demoRole} onChange={setDemoRole} disabled={disabled} /> : null);
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
  const [overallNote, setOverallNote] = useState("");
  const [overallExpanded, setOverallExpanded] = useState(false);
  const emitAction = (id: PlanActionId) => perform(() => {
    if (id !== "refine") return onAction(id);
    const latest = document.flushNotes();
    const feedback = formatPlanRefineFeedback(parsePlanSections(document.getSnapshot().markdown), latest, overallNote);
    return feedback === undefined ? onAction("refine") : onAction("refine", { feedback });
  });
  const closeDialog = useCallback(() => {
    setExpanded(false);
  }, [setExpanded]);
  return (
    <div className="approval-card plan-card" ref={cardRef} data-expanded={expanded} aria-hidden={expanded || undefined}>
      <QuestionHeightHandle kind="plan" />
      <PromptHead
        icon="alert"
        title="Plan Review"
        {...(demo === true ? { demo: true } : {})}
        {...(meta ? { meta } : {})}
        end={(
          <PlanHeadActions
            expanded={false}
            {...(saveAndQuit === undefined ? {} : { onSaveAndQuit: saveAndQuit })}
            onToggle={revealFromCard}
            onDismiss={() => emitAction("dismiss")}
            disabled={locked}
          />
        )}
      />
      <div
        className="approval-body plan-preview-hit"
        role="button"
        tabIndex={locked ? -1 : 0}
        aria-label={zh ? "展开完整计划" : "Expand full plan"}
        aria-disabled={locked}
        onClick={(event) => {
          if (locked) return;
          if (event.target instanceof Element && event.target.closest("a")) return;
          revealFromCard();
        }}
        onKeyDown={(event) => {
          if (locked) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          revealFromCard();
        }}
      >
        <div className="plan-preview-content">
          <p className="dk-sub">{title}</p>
          <div className="plan-md-preview">
            <MarkdownText text={expanded ? savedMarkdown : displayedBody} />
          </div>
        </div>
      </div>
      {canEdit ? <div className="plan-compact-editor">
        <span className={dirty ? "plan-save-status is-dirty" : "plan-save-status"}>{dirty ? (zh ? "未保存" : "Unsaved") : "Markdown"}</span>
        <button type="button" className="btn small ghost" disabled={locked} onClick={() => { setEditing(true); revealFromCard(); }}>
          <Icon name="pencil" extra="sm" />{zh ? "编辑计划" : "Edit plan"}
        </button>
      </div> : null}
      {!expanded && operationError ? <div className="plan-operation-error" role="alert">{errorMessage}</div> : null}
      {tierControl ? <fieldset className="plan-execution-lock" disabled={locked}>{tierControl}</fieldset> : null}
      <PlanActions options={options}
        onPick={emitAction}
        disabled={locked}
      />
      {expanded ? (
        <PlanReviewDialog
          options={options}
          executionControl={tierControl}
          title={title}
          editor={editor}
          body={displayedBody}
          content={<PlanWorkspace document={document} markdown={displayedBody} notes={notes} editing={editing} disabled={locked} onSave={savePlan} />}
          overallNote={overallNote}
          overallExpanded={overallExpanded}
          onOverallExpandedChange={setOverallExpanded}
          originRef={originRef ?? cardRef}
          fallbackOriginRef={cardRef}
          onClose={closeDialog}
          onAction={emitAction}
          {...(saveAndQuit === undefined ? {} : { onSaveAndQuit: saveAndQuit })}
          onOverallNoteChange={setOverallNote}
          disabled={locked}
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
      overallNote=""
      viewOnly
      originRef={originRef}
      onClose={onClose}
      onAction={async () => true}
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
  onSaveAndQuit,
  executionControl,
  options,
  onSaveMarkdown,
}: {
  title: string;
  body: string;
  meta?: string;
  disabled?: boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  originRef?: RefObject<HTMLElement | null>;
  onAction: PlanActionHandler;
  onSaveAndQuit?: PlanSaveHandler;
  executionControl?: ReactNode;
  options?: readonly NativePlanOption[] | undefined;
  onSaveMarkdown?: ((markdown: string) => Promise<PlanOperationResult>) | undefined;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  return (
    <div className="deck active preview-queue" role="region" aria-label={zh ? "待审核的计划" : "Plan pending review"} aria-live="polite">
      <div className="deck-card">
        <PlanCard
          options={options}
          executionControl={executionControl}
          onSaveMarkdown={onSaveMarkdown}
          title={title}
          body={body}
          onAction={onAction}
          {...(onSaveAndQuit === undefined ? {} : { onSaveAndQuit })}
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
