import { useId, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Icon } from "../icons";
import {
  groupTodosByPhase,
  isTodoPhaseComplete,
  todoPhaseHeadersVisible,
  todoPhaseOpenByDefault,
  todoStepProgress,
  type TodoPhaseGroup,
  type TodoStatus,
  type TodoTask,
  type TurnFileChange,
} from "./toolMeta";

const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|css|scss|html?|json|md|py|rs|go|vue|svelte)$/i;

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Identity of the todo snapshot; a new array of the same tasks must not retrigger scroll. */
export function todoListEpoch(todos: readonly TodoTask[]): string {
  return todos.map((todo) => `${todo.id}:${todo.status}:${todo.phase ?? ""}:${todo.content}`).join("\n");
}

/** Scroll only the task list, so the conversation behind the overlay does not jump. */
export function scrollCurrentTodoIntoList(list: HTMLElement, row: HTMLElement): void {
  const port = list.getBoundingClientRect();
  const item = row.getBoundingClientRect();
  const view = list.clientHeight || port.height;
  if (view <= 0) return;
  const rowSize = row.offsetHeight || item.height;
  const top = item.top - port.top + list.scrollTop - Math.max(0, (view - rowSize) / 2);
  const next = Math.max(0, top);
  if (typeof list.scrollTo === "function") {
    list.scrollTo({ top: next, behavior: reducedMotion() ? "auto" : "smooth" });
    return;
  }
  list.scrollTop = next;
}

function fileIcon(name: string): "file-code" | "file" {
  return CODE_FILE.test(name) ? "file-code" : "file";
}

function ProgressRing({ completed, total }: { completed: number; total: number }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const ratio = total <= 0 ? 0 : Math.min(1, completed / total);
  return (
    <svg className="task-dock-ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="task-dock-ring-track" cx="8" cy="8" r={radius} />
      <circle
        className="task-dock-ring-fill"
        cx="8"
        cy="8"
        r={radius}
        strokeDasharray={`${circumference * ratio} ${circumference}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

function TodoMark({ status }: { status: TodoStatus }) {
  if (status === "completed") {
    return (
      <span className="task-dock-mark done" aria-hidden="true">
        <Icon name="check" extra="sm" />
      </span>
    );
  }
  if (status === "in_progress") {
    return <span className="dot purple pulse" aria-hidden="true" />;
  }
  if (status === "blocked") {
    return <span className="dot amber" aria-hidden="true" />;
  }
  if (status === "abandoned") {
    return <span className="task-dock-mark abandoned" aria-hidden="true" />;
  }
  return <span className="task-dock-mark pending" aria-hidden="true" />;
}

function statusLabel(status: TodoStatus): string {
  if (status === "completed") return "已完成";
  if (status === "in_progress") return "进行中";
  if (status === "blocked") return "已阻塞";
  if (status === "abandoned") return "已放弃";
  return "待办";
}

function TodoRow({ todo, rowRef }: { todo: TodoTask; rowRef?: Ref<HTMLLIElement> }) {
  const current = todo.status === "in_progress";
  return (
    <li
      ref={rowRef}
      className={`task-dock-todo ${todo.status}`}
      aria-current={current ? "true" : undefined}
      data-current={current ? "true" : undefined}
    >
      <TodoMark status={todo.status} />
      <span className="task-dock-todo-text">
        <span className="sr-only">{statusLabel(todo.status)}，</span>
        {todo.content}
      </span>
    </li>
  );
}

function phaseKey(group: TodoPhaseGroup, index: number): string {
  return group.phase ?? `phase-${index}`;
}

function TodoPhaseBlock({
  group,
  index,
  open,
  panelId,
  currentTaskId,
  currentRef,
  onToggle,
}: {
  group: TodoPhaseGroup;
  index: number;
  open: boolean;
  panelId: string;
  currentTaskId: string | undefined;
  currentRef: Ref<HTMLLIElement>;
  onToggle: () => void;
}) {
  const tasksId = `${panelId}-p${index + 1}`;
  const label = group.phase ?? "任务";
  const complete = isTodoPhaseComplete(group);
  const total = group.tasks.filter((task) => task.status !== "abandoned").length;
  const done = group.tasks.filter((task) => task.status === "completed").length;
  return (
    <li
      className={`task-dock-phase${open ? " open" : ""}${complete ? " complete" : ""}`}
      role="group"
      aria-label={`P${index + 1} ${label}`}
    >
      <button
        type="button"
        className="task-dock-phase-toggle"
        aria-expanded={open}
        aria-controls={tasksId}
        aria-label={`P${index + 1} ${label}，${done}/${total}，${open ? "收起" : "展开"}`}
        onClick={onToggle}
      >
        <span className="task-dock-phase-index" aria-hidden="true">P{index + 1}</span>
        <span className="task-dock-phase-main">
          <span className="task-dock-phase-name">{label}</span>
          {total > 0 ? <span className="task-dock-phase-meta">{done}/{total}</span> : null}
          <Icon name={open ? "chevron-d" : "chevron-r"} extra="sm" />
        </span>
      </button>
      <div
        className="task-dock-phase-fold"
        id={tasksId}
        aria-hidden={!open}
        {...(open ? {} : { inert: true })}
      >
        <div className="task-dock-phase-fold-inner">
          <ul className="task-dock-phase-tasks">
            {group.tasks.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                {...(todo.id === currentTaskId ? { rowRef: currentRef } : {})}
              />
            ))}
          </ul>
        </div>
      </div>
    </li>
  );
}

export function TaskProgressDock({
  todos,
  files,
  demo,
  onReview,
  onOpen,
}: {
  todos: readonly TodoTask[];
  files: readonly TurnFileChange[];
  demo?: boolean;
  onReview?: () => void;
  onOpen?: (path: string) => void;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [phaseOpen, setPhaseOpen] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLUListElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);
  const userPausedRef = useRef(false);
  const seenEpochRef = useRef<string | undefined>(undefined);
  const currentTaskId = todos.find((todo) => todo.status === "in_progress")?.id;
  const todoEpoch = todoListEpoch(todos);

  useLayoutEffect(() => {
    const current = todos.find((todo) => todo.status === "in_progress");
    if (current === undefined) return;
    const nextGroups = groupTodosByPhase(todos);
    const index = nextGroups.findIndex((group) => group.tasks.some((task) => task.id === current.id));
    if (index < 0) return;
    const key = phaseKey(nextGroups[index]!, index);
    setPhaseOpen((prev) => (prev[key] === true ? prev : { ...prev, [key]: true }));
  }, [currentTaskId, todos]);

  useLayoutEffect(() => {
    if (!open) {
      seenEpochRef.current = undefined;
      userPausedRef.current = false;
      return;
    }
    if (seenEpochRef.current !== todoEpoch) {
      userPausedRef.current = false;
      seenEpochRef.current = todoEpoch;
    }
    if (userPausedRef.current) return;
    let cancelled = false;
    const run = () => {
      if (cancelled || userPausedRef.current) return;
      const list = listRef.current;
      const row = currentRef.current;
      if (list === null || row === null) return;
      scrollCurrentTodoIntoList(list, row);
    };
    run();
    const frame = requestAnimationFrame(run);
    const timer = window.setTimeout(run, 260);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [open, todoEpoch]);

  const pauseTodoAutoScroll = () => {
    userPausedRef.current = true;
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollTop;
  };

  if (todos.length === 0 && files.length === 0) return null;

  const steps = todoStepProgress(todos);
  const add = files.reduce((sum, file) => sum + file.add, 0);
  const del = files.reduce((sum, file) => sum + file.del, 0);
  const stepText = steps.total > 0 ? `第 ${steps.current} / ${steps.total} 步` : "";
  const fileText = files.length > 0 ? `${files.length} 个文件已更改` : "";
  const summary = [stepText, fileText].filter(Boolean).join(" · ");
  const toggleLabel = `${summary || "任务进度"}，${open ? "收起" : "展开"}任务与文件修改`;
  const both = todos.length > 0 && files.length > 0;
  const groups = groupTodosByPhase(todos);
  const showPhases = todoPhaseHeadersVisible(groups);
  const phaseDefaults = todoPhaseOpenByDefault(groups);

  return (
    <div className={`task-dock${open ? " open" : ""}${both ? " both" : " single"}`}>
      <div className="task-dock-shell">
        <div
          className="task-dock-collapse"
          id={panelId}
          aria-hidden={!open}
          inert={open ? undefined : true}
        >
        <div className="task-dock-collapse-inner">
          <div className="task-dock-panel">
            {todos.length > 0 ? (
              <section className="task-dock-col" aria-label="任务列表">
                <ul
                  ref={listRef}
                  className={`task-dock-todos${showPhases ? " phased" : ""}`}
                  onWheel={pauseTodoAutoScroll}
                  onTouchMove={pauseTodoAutoScroll}
                  onPointerDown={pauseTodoAutoScroll}
                >
                  {showPhases
                    ? groups.map((group, index) => {
                        const key = phaseKey(group, index);
                        const phaseExpanded = Object.hasOwn(phaseOpen, key) ? phaseOpen[key] === true : phaseDefaults[index] === true;
                        return (
                          <TodoPhaseBlock
                            key={key}
                            group={group}
                            index={index}
                            open={phaseExpanded}
                            panelId={panelId}
                            currentTaskId={currentTaskId}
                            currentRef={currentRef}
                            onToggle={() => {
                              setPhaseOpen((current) => ({ ...current, [key]: !phaseExpanded }));
                            }}
                          />
                        );
                      })
                    : todos.map((todo) => (
                        <TodoRow
                          key={todo.id}
                          todo={todo}
                          {...(todo.id === currentTaskId ? { rowRef: currentRef } : {})}
                        />
                      ))}
                </ul>
              </section>
            ) : null}
            {files.length > 0 ? (
              <section className="task-dock-col" aria-label="文件修改">
                <ul className="task-dock-file-list">
                  {files.map((file) => (
                    <li key={file.path} className="task-dock-file">
                      <span className="task-dock-file-icon" aria-hidden="true">
                        <Icon name={fileIcon(file.name)} extra="sm" />
                      </span>
                      <button
                        type="button"
                        className="task-dock-file-open"
                        aria-label={demo === true ? `打开 ${file.path}（演示）` : `打开 ${file.path}`}
                        data-tip={demo === true ? "打开（演示）" : "打开"}
                        onClick={() => onOpen?.(file.path)}
                      >
                        <span className="task-dock-file-name">{file.name}</span>
                        {file.dir ? <span className="task-dock-file-dir">{file.dir}</span> : null}
                      </button>
                      {file.add || file.del ? (
                        <span className="task-dock-file-stats" aria-hidden="true">
                          {file.add ? <span className="add">+{file.add}</span> : null}
                          {file.del ? <span className="del">-{file.del}</span> : null}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </div>
        </div>
        <div className={`task-dock-bar${open && files.length > 0 ? " has-review" : ""}`}>
          <button
            type="button"
            className="task-dock-pill"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={toggleLabel}
            onClick={() => setOpen((value) => !value)}
          >
            {steps.total > 0 ? <ProgressRing completed={steps.completed} total={steps.total} /> : null}
            {stepText ? <span className="task-dock-step">{stepText}</span> : null}
            {stepText && fileText ? <span className="task-dock-sep" aria-hidden="true">·</span> : null}
            {fileText ? <span className="task-dock-files">{fileText}</span> : null}
            {add || del ? (
              <span className="task-dock-stats" aria-hidden="true">
                <span className="add">+{add}</span>
                <span className="del">-{del}</span>
              </span>
            ) : null}
            {demo === true ? <span className="chip gray xs">演示</span> : null}
          </button>
          {open && files.length > 0 ? (
            <button
              type="button"
              className="btn small task-dock-review"
              onClick={onReview}
              data-tip={demo === true ? "Changes（演示）" : "Changes"}
            >
              <Icon name="diff" extra="sm" />
              审核
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
