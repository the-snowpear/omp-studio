import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { StudioTaskStepState } from "@omp-studio/studio-protocol";
import { Icon, type IconName } from "../icons";
import "./taskSteps.css";

const PHASES: Record<StudioTaskStepState["phase"], { zh: string; en: string; icon: IconName }> = {
  running: { zh: "执行中", en: "Running", icon: "play" },
  completed: { zh: "已完成", en: "Completed", icon: "check" },
  interrupted: { zh: "已中断", en: "Interrupted", icon: "pause" },
  failed: { zh: "失败", en: "Failed", icon: "alert-c" },
  budget: { zh: "预算停止", en: "Budget stop", icon: "pause" },
  unknown: { zh: "未记录执行结果", en: "Execution outcome not recorded", icon: "clock" },
};

/** Read-only native prompt groups. Never interprets Markdown or advances a task. */
export function TaskStepsView({ state, zh }: { state?: StudioTaskStepState | undefined; zh: boolean }) {
  const id = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const [picked, setPicked] = useState<number | null>(null);
  if (!state?.prompts.length) return <p className="task-step-note">{zh ? "暂无原生步骤记录。" : "No native task-step record is available."}</p>;
  const selected = Math.min(state.prompts.length - 1, Math.max(0, picked ?? state.sent - 1));
  const phase = PHASES[state.phase];
  function choose(index: number, focus = false) {
    setPicked(index);
    if (focus) listRef.current?.querySelector<HTMLButtonElement>(`[data-prompt-group="${index}"]`)?.focus({ preventScroll: true });
  }
  function onKey(event: KeyboardEvent<HTMLOListElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    let index: number | undefined;
    if (event.key === "ArrowUp") index = Math.max(0, selected - 1);
    else if (event.key === "ArrowDown") index = Math.min(state!.prompts.length - 1, selected + 1);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = state!.prompts.length - 1;
    if (index === undefined) return;
    event.preventDefault(); event.stopPropagation(); choose(index, true);
  }
  function group(index: number) {
    if (index < state!.completed) return { label: zh ? "已完成" : "Completed", icon: "check" as const };
    if (index === state!.sent - 1 && state!.phase !== "unknown") return { label: zh ? phase.zh : phase.en, icon: phase.icon };
    return { label: index < state!.sent ? zh ? "已发送" : "Sent" : zh ? "未发送" : "Not sent", icon: "clock" as const };
  }
  return <section className="task-steps-view" aria-label={zh ? "原生任务阶段" : "Native task phases"}>
    <header className="task-steps-view-head"><h3>{zh ? "任务阶段" : "Task phases"}</h3><span className={`task-step-phase is-${state.phase}`} role="status"><Icon name={phase.icon} extra="sm" />{zh ? phase.zh : phase.en}</span></header>
    <p className="task-step-note">{zh ? `已发送 ${state.sent}/${state.prompts.length} 组 · 已完成 ${state.completed}/${state.prompts.length} 组` : `Sent ${state.sent}/${state.prompts.length} groups · Completed ${state.completed}/${state.prompts.length} groups`}</p>
    <ol className="task-step-outline is-readonly" ref={listRef} onKeyDown={onKey} aria-label={zh ? "原生提示组" : "Native prompt groups"}>
      {state.prompts.map((_prompt, index) => { const status = group(index); return <li key={index}><button type="button" data-prompt-group={index} aria-current={selected === index ? "step" : undefined} aria-controls={`${id}-prompt`} tabIndex={selected === index ? 0 : -1} onClick={() => choose(index)}>
        <span className="task-step-number">{index + 1}</span><span className="task-step-caption">{zh ? `第 ${index + 1} 组` : `Group ${index + 1}`}</span><span className="task-step-group-state"><Icon name={status.icon} extra="sm" />{status.label}</span>
      </button></li>; })}
    </ol>
    <div className="task-step-prompt" id={`${id}-prompt`}><span className="tiny muted">{zh ? `第 ${selected + 1} 组原生提示` : `Native prompt · group ${selected + 1}`}</span><pre>{state.prompts[selected]}</pre></div>
    {state.reason ? <p className="task-step-reason">{state.reason}</p> : null}
    {state.phase === "unknown" ? <p className="task-step-note">{zh ? "历史记录只有发送计数；已发送不代表最后一组已经完成。" : "The historical record only tracks dispatch. Sent does not mean the last group completed."}</p> : state.completed < state.prompts.length && state.phase !== "running" ? <p className="task-step-note">{zh ? "剩余阶段保留在原任务记录中，不会自动续跑。" : "Remaining phases stay in the original task record and will not continue automatically."}</p> : null}
  </section>;
}
