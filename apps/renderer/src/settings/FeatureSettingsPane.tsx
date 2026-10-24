import { useEffect, useState } from "react";
import type { FeatureSettingKey, FeatureSettingRow, FeatureSettingValue } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { SettingRow, Switch } from "./SettingRow";
import { useFeatureSettings, type FeatureSettingsProps } from "./useFeatureSettings";
import "./featureSettings.css";

type Group = "interaction" | "context" | "tasks" | "voice" | "maintenance";
type Definition = { key: FeatureSettingKey; group: Group; zh: string; en: string; hint: string; hintEn: string; options?: Array<[string, string, string]>; text?: boolean; min?: number; max?: number; step?: number };
const DEFINITIONS: Definition[] = [
  { key: "composer.predictions", group: "interaction", zh: "下一条消息建议", en: "Next-message suggestions", hint: "回答结束后，用当前模型预测下一条消息。会额外调用模型并计入用量；接受建议只填入草稿。", hintEn: "After a reply, predict your next message with the current model. Billed separately; accepting only fills the draft." },
  { key: "contextFiles.extra", group: "context", zh: "额外指令文件", en: "Extra instruction files", hint: "每行一个文件名，与原有项目指令一起加载；下次重新加载上下文时生效。", hintEn: "One filename per line, loaded alongside project instructions when context is reloaded." },
  { key: "retry.fallbackOn", group: "context", zh: "何时切换备用模型", en: "When to use fallbacks", hint: "限制模型候选链的切换条件，不改变当前配置的候选模型。", hintEn: "Limit fallback triggers without changing your model chain.", options: [["any", "所有可回退错误", "Any eligible error"], ["usage-limit", "仅配额不足", "Quota errors only"], ["except-usage-limit", "除配额不足之外", "Except quota errors"]] },
  { key: "task.structured", group: "tasks", zh: "结构化任务结果", en: "Structured task results", hint: "允许 task 使用结果 schema 和 yield；关闭时任务返回普通文本。", hintEn: "Enable task schemas and yield. When off, tasks return plain text." },
  { key: "bash.gitGuard", group: "tasks", zh: "保护共享 Git 工作区", en: "Protect shared Git checkouts", hint: "由原生 Bash 检查可能覆盖工作区文件的 Git 操作。", hintEn: "Native Bash checks Git operations that could overwrite workspace files." },
  { key: "worktree.onStart", group: "tasks", zh: "新会话工作目录", en: "New session directory", hint: "在当前目录开始，或创建独立 Worktree。已有会话不受影响。", hintEn: "Start here or create a dedicated worktree. Existing sessions are unchanged.", options: [["off", "当前工作区", "Current checkout"], ["ask", "创建时询问", "Ask when starting"], ["create", "创建独立 Worktree", "Create worktree"]] },
  { key: "worktree.onExit", group: "tasks", zh: "结束时的 Worktree", en: "Worktree on exit", hint: "清理前检查改动与提交。退出应用后无法确认的目录会保留；可在下方检查移除。", hintEn: "Check changes and commits before cleanup. If the app exits before confirmation, keep the directory; review removal below.", options: [["keep", "保留", "Keep"], ["ask", "询问", "Ask"], ["remove", "清理安全项，其余询问", "Remove clean; ask otherwise"]] },
  { key: "prewalk.auto", group: "tasks", zh: "自动 Prewalk", en: "Automatic prewalk", hint: "用 judge 角色判断每个新任务是否把难点集中在前面；开启后在第一次编辑时交给目标模型继续。需要原生 judge，会额外调用模型。", hintEn: "The judge role classifies whether each new task front-loads its hard reasoning; when on, the turn hands off to the target model at the first edit. Needs a native judge; billed separately.", options: [["off", "关闭", "Off"], ["suggest", "只判断不切换", "Suggest only"], ["on", "自动切换", "On"]] },
  { key: "prewalk.autoTarget", group: "tasks", zh: "Prewalk 目标模型", en: "Prewalk target", hint: "自动 Prewalk 在第一次编辑/写入时交接的模型或角色，例如 @smol 或 provider/model。", hintEn: "Model or role auto-prewalk hands off to at the first edit/write, e.g. @smol or provider/model.", text: true },
  { key: "async.widgets", group: "tasks", zh: "后台任务实时小组件", en: "Live job widgets", hint: "为运行中的后台任务绘制实时图表/进度；由 widget 角色模型（默认 smol）为每个任务生成一次规格。", hintEn: "Draw live charts and meters for running background jobs. The widget model role (default smol) writes one spec per job." },
  { key: "computer.backgroundFallback", group: "tasks", zh: "电脑操作的后台回退", en: "Computer-use background fallback", hint: "后台输入不可用时：接管前台执行，或拒绝（同时禁止 Agent 自行抢占前台）。", hintEn: "When background window input is unavailable: take over the foreground, or refuse (which also keeps the agent from taking the foreground).", options: [["takeover", "接管前台", "Take over"], ["refuse", "拒绝", "Refuse"]] },
  { key: "speech.speed", group: "voice", zh: "实时朗读速度", en: "Live speech speed", hint: "本地 Kokoro 朗读速度，1× 为正常速度。", hintEn: "Local Kokoro speech speed; 1× is normal.", min: .5, max: 2.5, step: .1 },
  { key: "tts.localSpeed", group: "voice", zh: "本地语音生成速度", en: "Local TTS speed", hint: "用于本地 TTS 生成，不改变云端语音服务。", hintEn: "Applies to local TTS, leaving cloud speech settings unchanged.", min: .5, max: 2.5, step: .1 },
  { key: "gc.compress", group: "maintenance", zh: "维护时压缩闲置会话", en: "Compress idle sessions during maintenance", hint: "使用 NTFS/APFS 透明压缩，压缩后仍可恢复和搜索；启用不会立即开始扫描。", hintEn: "Use NTFS/APFS compression. Sessions remain resumable and searchable; enabling does not start a scan." },
  { key: "gc.compressAfterDays", group: "maintenance", zh: "闲置天数", en: "Idle days", hint: "只处理超过此天数未活动的会话。", hintEn: "Only consider sessions idle for this many days.", min: 1, max: 3650, step: 1 },
];
const TITLES: Record<Group, [string, string]> = { interaction: ["消息建议", "Message suggestions"], context: ["上下文与回退", "Context and fallback"], tasks: ["任务与工作区策略", "Task and workspace policy"], voice: ["本地语音速度", "Local speech speed"], maintenance: ["会话存储策略", "Session storage policy"] };

export function FeatureSettingsPane(props: FeatureSettingsProps & { group: Group }) {
  const state = useFeatureSettings(props), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [scope, setScope] = useState<"session" | "global">("global");
  return <section className="feature-settings" aria-label={TITLES[props.group][zh ? 0 : 1]}>
    <header className="feature-settings-head"><div><span className="feature-eyebrow">{zh ? "运行偏好" : "RUNTIME PREFERENCES"}{state.preview ? zh ? " · 演示" : " · DEMO" : ""}</span><h3>{TITLES[props.group][zh ? 0 : 1]}</h3></div>
      <label className="small muted">{zh ? "保存到" : "Save to"}<select className="select" aria-label={zh ? "新功能设置保存范围" : "Feature settings scope"} value={scope} disabled={state.busy} onChange={event => setScope(event.target.value as typeof scope)}><option value="global">{zh ? "用户配置" : "User settings"}</option><option value="session">{zh ? "当前会话" : "This session"}</option></select></label>
    </header>
    {!state.enabled ? <p className="feature-status">{zh ? "连接支持此功能的 Runtime 后可配置。" : "Connect a compatible Runtime to configure these features."}</p> : state.loading ? <p className="feature-status" role="status">{zh ? "正在读取生效配置…" : "Reading effective settings…"}</p> : null}
    {DEFINITIONS.filter(item => item.group === props.group).map(definition => <FeatureRow key={definition.key} definition={definition} row={state.rows.find(row => row.key === definition.key)} disabled={!state.enabled || state.busy || state.loading} zh={zh} save={value => void state.save(definition.key, value, scope)} clear={() => void state.clear(definition.key)} />)}
    {state.error ? <p role="alert" className="feature-error">{state.error}</p> : null}
    {state.notice ? <p role="status" className="feature-status">{state.preview ? zh ? "演示设置已更新。" : "Demo settings updated." : zh ? "已保存。界面显示当前生效值；项目或会话覆盖仍优先。" : "Saved. Effective values are shown; project and session overrides still take precedence."}</p> : null}
  </section>;
}
function FeatureRow({ definition: d, row, disabled, zh, save, clear }: { definition: Definition; row?: FeatureSettingRow | undefined; disabled: boolean; zh: boolean; save(value: FeatureSettingValue): void; clear(): void }) {
  const [draft, setDraft] = useState("");
  useEffect(() => { setDraft(Array.isArray(row?.value) ? row.value.join("\n") : String(row?.value ?? "")); }, [row?.value]);
  const label = zh ? d.zh : d.en;
  return <SettingRow label={label} desc={zh ? d.hint : d.hintEn} source={row ? row.source === "global" ? "user" : row.source === "project" ? "project" : row.source === "default" ? "default" : "runtime" : "unavailable"}>
    <div className="feature-control">
      {d.key === "contextFiles.extra" ? <><textarea className="input" rows={3} aria-label={label} value={draft} disabled={disabled || !row} placeholder="AGENTS.local.md" onChange={event => setDraft(event.target.value)} /><button className="btn small outline" disabled={disabled || !row} onClick={() => save(draft.split(/\r?\n/u).map(line => line.trim()).filter(Boolean))}>{zh ? "保存文件名" : "Save filenames"}</button></> : d.text ? <div className="feature-number"><input className="input" aria-label={label} disabled={disabled || !row} value={draft} onChange={event => setDraft(event.target.value)} /><button className="btn small outline" disabled={disabled || !row || !draft.trim() || draft.trim() === row?.value} onClick={() => save(draft.trim())}>{zh ? "应用" : "Apply"}</button></div> : d.options ? <select className="select" aria-label={label} disabled={disabled || !row} value={String(row?.value ?? "")} onChange={event => save(event.target.value)}>{!row ? <option value="">—</option> : null}{d.options.map(([value, cn, en]) => <option key={value} value={value}>{zh ? cn : en}</option>)}</select> : d.min !== undefined ? <div className="feature-number"><input className="input" type="number" aria-label={label} min={d.min} max={d.max} step={d.step} disabled={disabled || !row} value={draft} onChange={event => setDraft(event.target.value)} /><button className="btn small outline" disabled={disabled || !row || !draft || !Number.isFinite(Number(draft)) || Number(draft) < d.min || Number(draft) > d.max!} onClick={() => save(Number(draft))}>{zh ? "应用" : "Apply"}</button></div> : <Switch label={label} disabled={disabled || !row} checked={row?.value === true} onChange={save} />}
      {row?.source === "runtime" ? <button className="btn small ghost" disabled={disabled} onClick={clear}>{zh ? "清除会话覆盖" : "Clear session override"}</button> : null}
    </div>
  </SettingRow>;
}
