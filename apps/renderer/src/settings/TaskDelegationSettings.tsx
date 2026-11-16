import { useId } from "react";
import type { FeatureSettingKey, FeatureSettingRow, FeatureSettingValue } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import type { Definition } from "./FeatureSettingsPane";
import { SettingRow, Switch, type SettingSource } from "./SettingRow";
import "./taskDelegationSettings.css";

export const TASK_DELEGATION_SETTINGS_DEFINITIONS: Definition[] = [
  { key: "task.steps", group: "tasks", zh: "向 Agent 提供分步任务", en: "Advertise sequential task steps", hint: "让原生 task 工具以 steps 接受有依赖的工作；同一个子 Agent 按顺序完成，超过 4 步会合并提示组。默认关闭。GUI 的单次选择不会修改此设置。", hintEn: "Advertise steps for dependent work in the native task tool. One agent runs in order; more than four steps share prompt groups. Off by default; a GUI task choice does not change this setting." },
  { key: "task.autoParallel", group: "tasks", zh: "自动并行委派", en: "Auto Parallel", hint: "原生 judge 判断新顶层请求中的独立工作。只建议不执行；开启时向 Agent 提供并行委派指导，而不是在 GUI 再运行一个调度器。需要 judge 角色与 task 工具，会额外调用模型。默认关闭。", hintEn: "The native judge identifies independent work in new top-level prompts. Suggest reports only; On guides the agent to delegate in parallel. Requires the judge role and task tool and makes an extra model request. Off by default.", options: [["off", "关闭", "Off"], ["suggest", "只建议", "Suggest only"], ["on", "并行委派指导", "On · delegation guidance"]] },
];

function source(row?: FeatureSettingRow): SettingSource {
  if (!row) return "unavailable";
  return row.source === "global" ? "user" : row.source === "project" ? "project" : row.source === "default" ? "default" : "runtime";
}

/** Shares its owner's settings read, save scope and submit lock; it owns no scheduler. */
export function TaskDelegationSettings({ rows, disabled, zh, save, clear, keys, excludeKeys }: {
  rows: readonly FeatureSettingRow[];
  keys?: readonly FeatureSettingKey[];
  excludeKeys?: readonly FeatureSettingKey[];
  disabled: boolean;
  zh: boolean;
  save(key: FeatureSettingKey, value: FeatureSettingValue): void;
  clear(key: FeatureSettingKey): void;
}) {
  const id = useId();
  const steps = rows.find(row => row.key === "task.steps");
  const parallel = rows.find(row => row.key === "task.autoParallel");
  const missing = zh ? "当前 Runtime 未返回此委派设置。" : "This Runtime has not returned this delegation setting.";
  const describe = !steps || !parallel ? (zh ? "连接支持这些设置的 Runtime 后可查看实际委派策略。" : "Connect a Runtime that provides these settings to read the effective delegation policy.")
    : parallel.value === "suggest" ? (zh ? "只建议：原生 judge 报告可并行的部分，不会因此启动任务。相关建议沿用对话中的原生呈现。" : "Suggest only: the native judge reports a possible split without launching tasks. Suggestions stay in the native conversation flow.")
    : parallel.value === "on" ? (zh ? "并行指导只针对独立工作；有前后依赖的 steps 仍在同一个 Agent 内按顺序执行。" : "Parallel guidance is for independent work. Dependent steps still execute in order within one agent.")
    : steps.value === true ? (zh ? "适合有依赖的接力工作：每组有真实结果后才交接下一组，中断、错误或预算停止都不会自动续发。" : "For dependent handoffs: each group needs a real result before the next starts. Abort, errors and budget stops do not advance the chain.")
    : (zh ? "保持原生默认委派行为。创建任务时仍可单次选择 Steps，这不会更改全局设置。" : "Keep native default delegation. You can still choose Steps for one GUI task without changing the global settings.");
  return <section className="task-delegation-settings" aria-labelledby={`${id}-heading`}>
    <header><h4 id={`${id}-heading`}>{zh ? "委派策略" : "Delegation policy"}</h4><p className="set-section-desc">{zh ? "顺序步骤用于有依赖的工作，并行判断用于相互独立的工作。两者沿用原生 task 执行与授权。" : "Sequential steps serve dependent work; parallel judgment serves independent work. Both keep native task execution and authorization."}</p></header>
    {TASK_DELEGATION_SETTINGS_DEFINITIONS.filter(definition => (!keys || keys.includes(definition.key)) && !excludeKeys?.includes(definition.key)).map(definition => {
      const row = definition.key === "task.steps" ? steps : parallel;
      const label = zh ? definition.zh : definition.en;
      return <SettingRow key={definition.key} label={label} desc={zh ? definition.hint : definition.hintEn} source={source(row)} {...(!row ? { reason: missing } : {})}>
        <div className="feature-control">
          {definition.key === "task.steps" ? <Switch label={label} checked={row?.value === true} disabled={disabled || !row} onChange={value => save(definition.key, value)} />
            : <AppSelect className="select" aria-label={label} disabled={disabled || !row} value={row ? String(row.value) : ""} onChange={event => save(definition.key, event.target.value)}>
              {!row ? <option value="">—</option> : null}
              {definition.options?.map(([value, cn, en]) => <option key={value} value={value}>{zh ? cn : en}</option>)}
            </AppSelect>}
          {row?.source === "runtime" ? <button type="button" className="btn small ghost" disabled={disabled} onClick={() => clear(definition.key)}>{zh ? "清除会话覆盖" : "Clear session override"}</button> : null}
        </div>
      </SettingRow>;
    })}
    <p className="task-delegation-context" role="note">{describe}</p>
  </section>;
}
