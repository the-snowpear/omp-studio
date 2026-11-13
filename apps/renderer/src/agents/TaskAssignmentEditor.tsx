import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../icons";
import { formatShortcut, isPrimaryModifier } from "../keyboard/shortcuts";
import { useWideLayout } from "../layout/useWideLayout";
import "./taskSteps.css";

export type TaskAssignmentMode = "single" | "steps";
export interface TaskStepDraft { id: string; text: string }
export function createTaskStep(text = ""): TaskStepDraft { return { id: crypto.randomUUID(), text }; }

interface TaskAssignmentEditorProps {
  mode: TaskAssignmentMode;
  onModeChange(mode: TaskAssignmentMode): void;
  assignment: string;
  onAssignmentChange(text: string): void;
  steps: readonly TaskStepDraft[];
  onStepsChange(steps: TaskStepDraft[]): void;
  disabled: boolean;
  stepsSupported: boolean;
  stepsAdvertised?: boolean;
  zh: boolean;
}

/** One local task draft. Choosing Steps never writes the Runtime's global settings. */
export function TaskAssignmentEditor({ mode, onModeChange, assignment, onAssignmentChange, steps, onStepsChange,
  disabled, stepsSupported, stepsAdvertised, zh,
}: TaskAssignmentEditorProps) {
  const id = useId();
  const [selectedId, setSelectedId] = useState<string | undefined>(steps[0]?.id);
  const [rootRef, wide] = useWideLayout<HTMLDivElement>(580);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const outlineRef = useRef<HTMLOListElement>(null);
  const pendingFocus = useRef<"editor" | "outline" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const selectedIndex = Math.max(0, steps.findIndex(step => step.id === selectedId));
  const selected = steps[selectedIndex];
  const activeId = selected?.id;
  const editingLocked = disabled || !stepsSupported;
  const addShortcut = formatShortcut({ key: "Enter", shift: true }, "hint");
  const deleteShortcut = formatShortcut({ key: "Backspace", shift: true }, "hint");
  const stepLabel = (index: number) => zh ? `第 ${index + 1} 步` : `Step ${index + 1}`;

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "editor") editorRef.current?.focus({ preventScroll: true });
    else if (target === "outline") outlineRef.current?.querySelector<HTMLButtonElement>(`[data-step-id="${activeId}"]`)?.focus({ preventScroll: true });
  }, [activeId, steps, mode]);

  function choose(index: number, focus: "editor" | "outline" | null = null) {
    const next = steps[index];
    if (!next) return;
    pendingFocus.current = focus;
    setSelectedId(next.id);
    if (next.id === activeId && focus === "editor") editorRef.current?.focus({ preventScroll: true });
  }
  function add() {
    if (editingLocked) return;
    const step = createTaskStep();
    const next = [...steps];
    next.splice(selected ? selectedIndex + 1 : 0, 0, step);
    pendingFocus.current = "editor";
    setSelectedId(step.id);
    onStepsChange(next);
    setAnnouncement(zh ? `已新增第 ${selectedIndex + 2} 步` : `Added step ${selectedIndex + 2}`);
  }
  function remove() {
    if (editingLocked || !selected || steps.length <= 1) return;
    const next = steps.filter(step => step.id !== selected.id);
    const index = Math.min(selectedIndex, next.length - 1);
    pendingFocus.current = "editor";
    setSelectedId(next[index]?.id);
    onStepsChange(next);
    setAnnouncement(zh ? `已删除第 ${selectedIndex + 1} 步` : `Removed step ${selectedIndex + 1}`);
  }
  function move(direction: -1 | 1) {
    const destination = selectedIndex + direction;
    if (editingLocked || !selected || destination < 0 || destination >= steps.length) return;
    const next = [...steps];
    next.splice(selectedIndex, 1);
    next.splice(destination, 0, selected);
    onStepsChange(next);
    setAnnouncement(zh ? `已移到第 ${destination + 1} 步` : `Moved to step ${destination + 1}`);
  }
  function onStepKey(event: KeyboardEvent<HTMLDivElement>) {
    if (mode !== "steps" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const inOutline = (event.target as HTMLElement).closest(".task-step-outline") !== null;
    let handled = true;
    if (isPrimaryModifier(event) && event.shiftKey && event.key === "Enter") add();
    else if (isPrimaryModifier(event) && event.shiftKey && event.key === "Backspace") remove();
    else if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === "ArrowUp") move(-1);
    else if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === "ArrowDown") move(1);
    else if (inOutline && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === "Insert") add();
      else if (event.key === "Delete") remove();
      else if (event.key === "ArrowUp") choose(Math.max(0, selectedIndex - 1), "outline");
      else if (event.key === "ArrowDown") choose(Math.min(steps.length - 1, selectedIndex + 1), "outline");
      else if (event.key === "Home") choose(0, "outline");
      else if (event.key === "End") choose(steps.length - 1, "outline");
      else handled = false;
    } else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }
  const textSize = steps.reduce((size, step) => size + step.text.length, 0);

  return <div className="task-assignment" ref={rootRef} onKeyDown={onStepKey}>
    <div className="task-assignment-head">
      <span className="tiny muted">{zh ? "任务形式" : "Assignment"}</span>
      <div className="seg" role="group" aria-label={zh ? "任务形式" : "Assignment mode"}>
        <button type="button" className={mode === "single" ? "active" : undefined} aria-pressed={mode === "single"} disabled={disabled} onClick={() => onModeChange("single")}>{zh ? "单一任务" : "Single"}</button>
        <button type="button" className={mode === "steps" ? "active" : undefined} aria-pressed={mode === "steps"} disabled={disabled || !stepsSupported} onClick={() => onModeChange("steps")}>{zh ? "分步任务" : "Steps"}</button>
      </div>
    </div>
    {!stepsSupported ? <p className="task-step-note" role="note">{zh ? "当前 Runtime 未提供原生步骤选项，仍可发送单一任务。" : "This Runtime has not provided native step options; single assignments remain available."}</p> : null}
    {mode === "single" ? <div className="field"><label className="tiny muted" htmlFor={`${id}-assignment`}>{zh ? "任务描述" : "Task instructions"}</label>
      <textarea id={`${id}-assignment`} className="input" rows={4} maxLength={65536} value={assignment} disabled={disabled} placeholder={zh ? "描述代理需要完成的工作…" : "Describe the work for this agent…"} onChange={event => onAssignmentChange(event.target.value)} />
    </div> : <>
      <p className="task-step-note">{zh ? "一次创建同一个 Agent。原生按顺序发送最多 4 组提示；更多步骤会合并，完成一组才续发。" : "One agent, at most four native prompt groups. More steps share groups; the next group follows a clean result."}</p>
      <div className={`task-step-layout${wide ? " is-wide" : ""}`}>
        <div className="task-step-outline-wrap">
          <div className="task-step-outline-head"><span>{zh ? `${steps.length} 个有序步骤` : `${steps.length} ordered steps`}</span><button type="button" className="btn small ghost" disabled={editingLocked} aria-label={zh ? "新增步骤" : "Add step"} data-tip={addShortcut} onClick={add}><Icon name="plus" extra="sm" /><span>{zh ? "新增" : "Add"}</span></button></div>
          <ol className="task-step-outline" ref={outlineRef} aria-label={zh ? "任务步骤顺序" : "Ordered task steps"}>
            {steps.map((step, index) => <li key={step.id}><button type="button" data-step-id={step.id} aria-current={activeId === step.id ? "step" : undefined} aria-label={`${stepLabel(index)}: ${step.text.trim() || (zh ? "待填写" : "Empty")}`} tabIndex={activeId === step.id ? 0 : -1} onClick={() => choose(index)}>
              <span className="task-step-number">{index + 1}</span><span className="task-step-caption">{step.text.trim().split(/\r?\n/u)[0] || (zh ? "待填写步骤" : "Empty step")}</span>
            </button></li>)}
          </ol>
        </div>
        <div className="task-step-editor">
          <div className="task-step-editor-head"><label htmlFor={`${id}-step`}>{stepLabel(selectedIndex)}</label><div className="task-step-actions">
            <button type="button" className="icon-btn small" disabled={editingLocked || selectedIndex === 0} aria-label={zh ? "上移步骤" : "Move step up"} data-tip={zh ? "上移 · Alt+↑" : "Move up · Alt+↑"} onClick={() => move(-1)}><Icon name="chevron-u" extra="sm" /></button>
            <button type="button" className="icon-btn small" disabled={editingLocked || selectedIndex >= steps.length - 1} aria-label={zh ? "下移步骤" : "Move step down"} data-tip={zh ? "下移 · Alt+↓" : "Move down · Alt+↓"} onClick={() => move(1)}><Icon name="chevron-d" extra="sm" /></button>
            <button type="button" className="icon-btn small" disabled={editingLocked || steps.length <= 1} aria-label={zh ? "删除步骤" : "Remove step"} data-tip={deleteShortcut} onClick={remove}><Icon name="trash" extra="sm" /></button>
          </div></div>
          <textarea id={`${id}-step`} className="input" ref={editorRef} rows={7} maxLength={65536} disabled={editingLocked || !selected} value={selected?.text ?? ""} placeholder={zh ? "写出这一步的目标、约束和交付…" : "Describe this step's goal, constraints and handoff…"} onChange={event => onStepsChange(steps.map(step => step.id === activeId ? { ...step, text: event.target.value } : step))} />
          <p className="task-step-note">{zh ? `新增 ${addShortcut} · 删除 ${deleteShortcut} · 排序 Alt+↑/↓` : `Add ${addShortcut} · Remove ${deleteShortcut} · Reorder Alt+↑/↓`}</p>
        </div>
      </div>
      {steps.some(step => !step.text.trim()) ? <p className="task-step-note">{zh ? "填写每一步后即可创建；模型、思考强度和解题范围对整条任务生效。" : "Fill every step to create the task. Model, effort and solution space apply to the whole task."}</p> : null}
      {textSize > 65536 ? <p className="task-step-error" role="alert">{zh ? "步骤正文合计超过 64 KiB，请缩短后再创建。" : "Step instructions exceed 64 KiB in total. Shorten them before creating the task."}</p> : null}
      {stepsAdvertised === false ? <p className="task-step-note">{zh ? "原生步骤广告当前关闭。本次选择只影响这条任务，不会修改全局委派策略。" : "Native step advertising is off. This choice affects only this task, not the global delegation policy."}</p> : null}
    </>}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </div>;
}
