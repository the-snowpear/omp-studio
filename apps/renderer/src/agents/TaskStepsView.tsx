import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { StudioTaskStepState } from "@omp-studio/studio-protocol";
import { Icon, type IconName } from "../icons";
import { StepCountBar, StepNode, StepRail, StepRailItem, type StepTone } from "../conversation/StepRail";
import "./taskSteps.css";

const PHASES: Record<StudioTaskStepState["phase"], { zh: string; en: string; icon: IconName; tone: StepTone }> = {
  running: { zh: "执行中", en: "Running", icon: "play", tone: "active" },
  completed: { zh: "已完成", en: "Completed", icon: "check", tone: "done" },
  interrupted: { zh: "已中断", en: "Interrupted", icon: "pause", tone: "warn" },
  failed: { zh: "失败", en: "Failed", icon: "alert-c", tone: "failed" },
  budget: { zh: "预算停止", en: "Budget stop", icon: "pause", tone: "warn" },
  unknown: { zh: "未记录执行结果", en: "Execution outcome not recorded", icon: "clock", tone: "muted" },
};

/** First non-empty line, so a group reads as its intent rather than "Group 2". */
function caption(prompt: string): string {
  return prompt.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? "";
}

/** Read-only native prompt groups. Never interprets Markdown or advances a task. */
export function TaskStepsView({ state, zh }: { state?: StudioTaskStepState | undefined; zh: boolean }) {
  const id = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const [picked, setPicked] = useState<number | null>(null);
  if (!state?.prompts.length) return <p className="task-step-note">{zh ? "暂无原生步骤记录。" : "No native task-step record is available."}</p>;
  const total = state.prompts.length;
  const selected = Math.min(total - 1, Math.max(0, picked ?? state.sent - 1));
  const phase = PHASES[state.phase];
  function choose(index: number, focus = false) {
    setPicked(index);
    if (focus) listRef.current?.querySelector<HTMLButtonElement>(`[data-prompt-group="${index}"]`)?.focus({ preventScroll: true });
  }
  function onKey(event: KeyboardEvent<HTMLOListElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    let index: number | undefined;
    if (event.key === "ArrowUp") index = Math.max(0, selected - 1);
    else if (event.key === "ArrowDown") index = Math.min(total - 1, selected + 1);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = total - 1;
    if (index === undefined) return;
    event.preventDefault(); event.stopPropagation(); choose(index, true);
  }
  function group(index: number): { label: string; tone: StepTone } {
    if (index < state!.completed) return { label: zh ? "已完成" : "Completed", tone: "done" };
    if (index === state!.sent - 1 && state!.phase !== "unknown") return { label: zh ? phase.zh : phase.en, tone: phase.tone };
    return index < state!.sent ? { label: zh ? "已发送" : "Sent", tone: "muted" } : { label: zh ? "未发送" : "Not sent", tone: "pending" };
  }
  const groupName = (index: number) => zh ? `第 ${index + 1} 组` : `Group ${index + 1}`;
  const inFlight = state.phase === "running" ? Math.max(0, state.sent - state.completed) : 0;
  return <section className="task-steps-view" aria-label={zh ? "原生任务阶段" : "Native task phases"}>
    <header className="task-steps-view-head">
      <h3>{zh ? "任务阶段" : "Task phases"}</h3>
      <StepCountBar done={state.completed} active={inFlight} total={total} label={zh ? `已完成 ${state.completed}/${total}` : `${state.completed}/${total} completed`} />
      <span className={`task-step-phase is-${state.phase}`} role="status"><Icon name={phase.icon} extra="sm" />{zh ? phase.zh : phase.en}</span>
    </header>
    <p className="task-step-note">{zh ? `已发送 ${state.sent}/${total} 组 · 已完成 ${state.completed}/${total} 组` : `Sent ${state.sent}/${total} groups · Completed ${state.completed}/${total} groups`}</p>
    <StepRail className="task-phase-rail" ref={listRef} onKeyDown={onKey} aria-label={zh ? "原生提示组" : "Native prompt groups"}>
      {state.prompts.map((prompt, index) => {
        const status = group(index);
        return <StepRailItem key={index} tone={status.tone} current={selected === index} node={<StepNode tone={status.tone} label={index + 1} icon={status.tone === "active" ? "play" : undefined} />}>
          <button type="button" className="task-phase-row" data-prompt-group={index} aria-label={`${groupName(index)} · ${status.label}`} aria-pressed={selected === index} aria-controls={`${id}-prompt`} tabIndex={selected === index ? 0 : -1} onClick={() => choose(index)}>
            <span className="task-phase-caption"><span className="task-phase-index">{groupName(index)}</span><span className="task-phase-text">{caption(prompt) || "—"}</span></span>
            <span className={`task-step-group-state is-${status.tone}`}>{status.label}</span>
          </button>
        </StepRailItem>;
      })}
    </StepRail>
    <figure className="task-step-prompt" id={`${id}-prompt`}>
      <figcaption>{zh ? `${groupName(selected)} · 原生提示` : `${groupName(selected)} · Native prompt`}</figcaption>
      <pre>{state.prompts[selected]}</pre>
    </figure>
    {state.reason ? <p className={`task-step-reason is-${phase.tone}`}>{state.reason}</p> : null}
    {state.phase === "unknown" ? <p className="task-step-note">{zh ? "历史记录只有发送计数；已发送不代表最后一组已经完成。" : "The historical record only tracks dispatch. Sent does not mean the last group completed."}</p> : state.completed < total && state.phase !== "running" ? <p className="task-step-note">{zh ? "剩余阶段保留在原任务记录中，不会自动续跑。" : "Remaining phases stay in the original task record and will not continue automatically."}</p> : null}
  </section>;
}
