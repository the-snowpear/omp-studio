/**
 * 设置页 7 个标签面板（Phase 1）。
 *
 * 职责边界：这里只放「改变全局行为」的设置。模型 / Provider / 角色 /
 * Fallback 归模型配置页；Skills / Plugins / MCP 启停归能力中心；子代理
 * 定义归模型配置 · 子代理；会话列表 / 归档 / 导出归历史页；Runtime /
 * Bridge / 日志归诊断页。
 *
 * 真实可写的只有 App 级设置（appSettings）与审批模式（permissions.mode.set）。
 * 其余 Runtime 设置以「尚未接入」的禁用枚举呈现，枚举文案取自 OMP
 * settings-schema（compaction.strategy / memory.backend / edit.mode /
 * task.* 等），等 settings contract 接入后逐行换成真实控件。
 * 预览模式下这些行改绑演示状态（见 preview/settingsPreview.ts）。
 */

import type { AppSettings } from "./appSettings";
import { DEFAULT_APP_SETTINGS } from "./appSettings";
import { SettingRow, SettingSection, StaticSelect, Switch, type SettingSource } from "./SettingRow";

export type ApprovalModeId = "always-ask" | "write" | "yolo";

/** 由 SettingsPage 提供的控制器；预览模式替换为演示实现。 */
export interface SettingsCtl {
  readonly preview: boolean;
  readonly app: AppSettings;
  readonly updateApp: (patch: Partial<AppSettings>) => void;
  readonly resetApp: (keys: readonly (keyof AppSettings)[]) => void;
  readonly approvalMode: ApprovalModeId | undefined;
  readonly setApprovalMode: (mode: ApprovalModeId) => void;
}

/** 预览模式下「尚未接入」行的演示读写面。 */
export interface RuntimeDemoApi {
  value(key: string): string;
  setValue(key: string, value: string): void;
  flag(key: string): boolean;
  toggle(key: string): void;
}

function appSource<K extends keyof AppSettings>(app: AppSettings, key: K): SettingSource {
  return app[key] === DEFAULT_APP_SETTINGS[key] ? "default" : "user";
}

function AppSelect<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <select className="select" value={value} aria-label={label} onChange={(event) => onChange(event.target.value as T)}>
      {options.map(([optionValue, optionLabel]) => (
        <option key={optionValue} value={optionValue}>{optionLabel}</option>
      ))}
    </select>
  );
}

function TabHeader({ title, desc, ctl, resetKeys, resetTitle }: {
  title: string;
  desc: string;
  ctl?: SettingsCtl;
  resetKeys?: readonly (keyof AppSettings)[];
  resetTitle?: string;
}) {
  return (
    <>
      <h3>{title}{ctl?.preview ? <span className="chip amber xs demo-chip">演示</span> : null}</h3>
      <p className="desc">{desc}</p>
      {resetKeys ? (
        <div className="set-toolbar">
          <button
            type="button"
            className="btn small outline"
            disabled={ctl === undefined || ctl.preview}
            data-tip={ctl?.preview ? "预览" : (resetTitle ?? "恢复默认")}
            onClick={() => ctl?.resetApp(resetKeys)}
          >
            恢复默认值
          </button>
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 尚未接入行：真实模式禁用枚举 / 预览模式演示交互                        */
/* ------------------------------------------------------------------ */

type FutureControl =
  | { readonly type: "select"; readonly value: string; readonly options: ReadonlyArray<string> }
  | { readonly type: "toggle"; readonly on: boolean };

interface FutureRowDef {
  readonly key: string;
  readonly label: string;
  readonly desc: string;
  readonly control: FutureControl;
  readonly reason: string;
}

function FutureRows({ rows, demo }: { rows: readonly FutureRowDef[]; demo?: RuntimeDemoApi | undefined }) {
  return rows.map((row) => (
    <SettingRow key={row.key} label={row.label} desc={row.desc} source="unavailable" reason={row.reason}>
      {row.control.type === "select" ? (
        demo ? (
          <select
            className="select"
            aria-label={row.label}
            value={demo.value(row.key)}
            onChange={(event) => demo.setValue(row.key, event.target.value)}
          >
            {row.control.options.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        ) : (
          <StaticSelect value={row.control.value} options={row.control.options} label={row.label} title="（暂未实现）" />
        )
      ) : demo ? (
        <Switch checked={demo.flag(row.key)} onChange={() => demo.toggle(row.key)} label={row.label} />
      ) : (
        <Switch checked={row.control.on} onChange={() => undefined} disabled label={row.label} />
      )}
    </SettingRow>
  ));
}

const R_COMPACTION = "compaction.* 未接入 Studio Bridge（Runtime schema 已支持）";
const R_MEMORY = "memory.* 未接入 Studio Bridge（Runtime schema 已支持）";
const R_EDIT = "edit.* 未接入 Studio Bridge（Runtime schema 已支持）";
const R_LSP = "lsp.* 未接入 Studio Bridge（Runtime schema 已支持）";
const R_SHELL = "shell.* 未接入 Studio Bridge（Runtime schema 已支持）";
const R_TASK = "task.* 未接入 Studio Bridge（Runtime schema 已支持）";
const R_SETTINGS = "等待 settings contract 接入（读模型含 effective value + source）";

/* ------------------------------------------------------------------ */
/* 1. 常规                                                              */
/* ------------------------------------------------------------------ */

const GENERAL_RESET_KEYS: readonly (keyof AppSettings)[] = [
  "theme", "density", "streaming", "toolActivity",
  "restoreLastProject", "restoreLastSession", "startupPage",
  "rememberLayout", "perProjectLayout",
  "notifyTaskDone", "notifyErrors", "notifyConfirmations", "notifyLongTasks",
];

export function GeneralTab({ ctl }: { ctl: SettingsCtl }) {
  const { app, updateApp } = ctl;
  return (
    <>
      <TabHeader
        title="常规"
        desc="应用外观、启动行为与通知。这里不出现模型、Provider、会话归档或 Runtime 版本。"
        ctl={ctl}
        resetKeys={GENERAL_RESET_KEYS}
      />
      <SettingSection title="应用">
        <SettingRow label="界面语言" desc="界面文案语言（概念术语保留英文）" source="unavailable" reason="界面国际化（i18n）尚未接入，当前界面为中文">
          <StaticSelect value="中文" options={["中文", "English"]} label="界面语言" title="语言（暂未实现）" />
        </SettingRow>
        <SettingRow label="主题" desc="Light / Dark，实时生效并随应用持久化" source={appSource(app, "theme")}>
          <AppSelect
            label="主题"
            value={app.theme}
            options={[["light", "Light"], ["dark", "Dark"]]}
            onChange={(theme) => updateApp({ theme })}
          />
        </SettingRow>
        <SettingRow label="信息密度" desc="紧凑 / 标准 / 宽松，调整全局间距" source={appSource(app, "density")}>
          <AppSelect
            label="信息密度"
            value={app.density}
            options={[["compact", "紧凑"], ["standard", "标准"], ["cozy", "宽松"]]}
            onChange={(density) => updateApp({ density })}
          />
        </SettingRow>
        <SettingRow label="流式输出" desc="助手回复的流式渲染与底部运行状态" source={appSource(app, "streaming")}>
          <Switch checked={app.streaming} onChange={(streaming) => updateApp({ streaming })} label="流式输出" />
        </SettingRow>
        <SettingRow label="工具活动显示" desc="工具链的展开方式" source={appSource(app, "toolActivity")}>
          <AppSelect
            label="工具活动显示"
            value={app.toolActivity}
            options={[["full", "完整"], ["concise", "简洁"], ["hidden", "隐藏"]]}
            onChange={(toolActivity) => updateApp({ toolActivity })}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection title="启动">
        <SettingRow label="启动时恢复最近项目" desc="关闭后启动停留在首页，不直接进入工作台" source={appSource(app, "restoreLastProject")}>
          <Switch checked={app.restoreLastProject} onChange={(restoreLastProject) => updateApp({ restoreLastProject })} label="启动时恢复最近项目" />
        </SettingRow>
        <SettingRow label="启动时恢复最近会话" desc="冷启动且无驻留 Runtime 会话时，自动选中最近活跃会话" source={appSource(app, "restoreLastSession")}>
          <Switch checked={app.restoreLastSession} onChange={(restoreLastSession) => updateApp({ restoreLastSession })} label="启动时恢复最近会话" />
        </SettingRow>
        <SettingRow label="启动后默认页面" desc="应用启动时打开的页面" source={appSource(app, "startupPage")}>
          <AppSelect
            label="启动后默认页面"
            value={app.startupPage}
            options={[["home", "首页"], ["workbench", "工作台"], ["last", "上次页面"]]}
            onChange={(startupPage) => updateApp({ startupPage })}
          />
        </SettingRow>
        <SettingRow label="记住面板布局" desc="侧栏宽度、底栏高度、上下区比例与面板开关状态" source={appSource(app, "rememberLayout")}>
          <Switch checked={app.rememberLayout} onChange={(rememberLayout) => updateApp({ rememberLayout })} label="记住面板布局" />
        </SettingRow>
        <SettingRow label="按项目保存布局" desc="每个项目独立记忆面板布局" source={appSource(app, "perProjectLayout")}>
          <Switch checked={app.perProjectLayout} onChange={(perProjectLayout) => updateApp({ perProjectLayout })} label="按项目保存布局" />
        </SettingRow>
      </SettingSection>
      <SettingSection title="通知" desc="系统级通知；任务完成与长任务提醒只在窗口失焦时打扰。">
        <SettingRow label="任务完成通知" desc="会话结束当前任务时通知" source={appSource(app, "notifyTaskDone")}>
          <Switch checked={app.notifyTaskDone} onChange={(notifyTaskDone) => updateApp({ notifyTaskDone })} label="任务完成通知" />
        </SettingRow>
        <SettingRow label="错误通知" desc="命令失败或需要重新同步时通知" source={appSource(app, "notifyErrors")}>
          <Switch checked={app.notifyErrors} onChange={(notifyErrors) => updateApp({ notifyErrors })} label="错误通知" />
        </SettingRow>
        <SettingRow label="等待确认通知" desc="Runtime 发起 Ask / 审批交互时通知" source={appSource(app, "notifyConfirmations")}>
          <Switch checked={app.notifyConfirmations} onChange={(notifyConfirmations) => updateApp({ notifyConfirmations })} label="等待确认通知" />
        </SettingRow>
        <SettingRow label="长时间任务提醒" desc="任务连续运行超过 5 分钟时提醒一次" source={appSource(app, "notifyLongTasks")}>
          <Switch checked={app.notifyLongTasks} onChange={(notifyLongTasks) => updateApp({ notifyLongTasks })} label="长时间任务提醒" />
        </SettingRow>
      </SettingSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 2. 对话与交互                                                        */
/* ------------------------------------------------------------------ */

export function InteractionTab({ ctl, demo }: { ctl: SettingsCtl; demo?: RuntimeDemoApi | undefined }) {
  const { app, updateApp } = ctl;
  return (
    <>
      <TabHeader
        title="对话与交互"
        desc="输入行为与回答表现。当前模型、Provider、Thinking 等级与 Fallback 都在「模型配置」页。"
        ctl={ctl}
        resetKeys={["showThinkingSummary", "showToolIntent"]}
      />
      <SettingSection title="输入行为">
        <FutureRows
          demo={demo}
          rows={[
            { key: "input.steering", label: "Steering 消息处理", desc: "运行中插入的转向消息", control: { type: "select", value: "一次处理一条", options: ["一次处理全部", "一次处理一条"] }, reason: "Steering 处理语义未接入 settings contract" },
            { key: "input.followup", label: "Follow-up 消息处理", desc: "排队消息的消费方式", control: { type: "select", value: "一次处理全部", options: ["一次处理全部", "一次处理一条"] }, reason: "Follow-up 处理语义未接入 settings contract" },
            { key: "input.interrupt", label: "中断时机", desc: "请求中断后何时停下", control: { type: "select", value: "当前工具完成后中断", options: ["立即中断", "当前工具完成后中断"] }, reason: "中断策略未接入 settings contract" },
            { key: "input.paste", label: "大段粘贴处理", desc: "粘贴超长文本时的处理方式", control: { type: "select", value: "自动转文件", options: ["直接插入", "自动转文件", "自动包裹代码块"] }, reason: "Composer 粘贴策略尚未实现" },
            { key: "input.autocomplete", label: "自动补全最大显示数量", desc: "输入建议列表上限", control: { type: "select", value: "8 条", options: ["5 条", "8 条", "12 条"] }, reason: "Composer 自动补全尚未实现" },
            { key: "input.emoji", label: "Emoji 自动补全", desc: "输入 : 时建议 Emoji", control: { type: "toggle", on: true }, reason: "Composer 自动补全尚未实现" },
          ]}
        />
      </SettingSection>
      <SettingSection title="回答表现">
        <FutureRows
          demo={demo}
          rows={[
            { key: "reply.style", label: "回答风格", desc: "助手回答的语气风格", control: { type: "select", value: "Default", options: ["Default", "Friendly", "Pragmatic", "None"] }, reason: "回答风格为 Runtime 配置，未接入 settings contract" },
            { key: "reply.detail", label: "回答详略", desc: "回答的详细程度", control: { type: "select", value: "Balanced", options: ["Concise", "Balanced", "Detailed"] }, reason: "回答详略为 Runtime 配置，未接入 settings contract" },
          ]}
        />
        <SettingRow label="显示 Thinking 摘要" desc="助手回复中的 Think 摘要卡片" source={appSource(app, "showThinkingSummary")}>
          <Switch checked={app.showThinkingSummary} onChange={(showThinkingSummary) => updateApp({ showThinkingSummary })} label="显示 Thinking 摘要" />
        </SettingRow>
        <SettingRow label="显示工具调用意图" desc="工具行上的意图摘要行" source={appSource(app, "showToolIntent")}>
          <Switch checked={app.showToolIntent} onChange={(showToolIntent) => updateApp({ showToolIntent })} label="显示工具调用意图" />
        </SettingRow>
        <SettingRow label="显示 Token 使用情况" desc="对话内的 Token 用量展示" source="unavailable" reason="对话内 Token 用量视图尚未实现（全局用量在首页）">
          <Switch checked={app.showTokenUsage} onChange={() => undefined} disabled label="显示 Token 使用情况" />
        </SettingRow>
      </SettingSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 3. 权限与安全                                                        */
/* ------------------------------------------------------------------ */

const TOOL_POLICY_ROWS: readonly FutureRowDef[] = [
  { key: "tool.fileRead", label: "文件读取", desc: "读取工作区文件", control: { type: "select", value: "允许", options: ["允许", "询问", "禁止"] }, reason: "tools.approval 工具级审批未接入 Studio Bridge" },
  { key: "tool.fileWrite", label: "文件写入", desc: "写入 / 编辑工作区文件", control: { type: "select", value: "允许", options: ["允许", "询问", "禁止"] }, reason: "tools.approval 工具级审批未接入 Studio Bridge" },
  { key: "tool.outside", label: "工作区外路径", desc: "读写工作区以外的路径", control: { type: "select", value: "询问", options: ["允许", "询问", "禁止"] }, reason: "tools.approval 工具级审批未接入 Studio Bridge" },
  { key: "tool.bash", label: "Bash / Shell", desc: "执行 Shell 命令", control: { type: "select", value: "询问", options: ["允许", "询问", "禁止"] }, reason: "tools.approval 工具级审批未接入 Studio Bridge" },
  { key: "tool.network", label: "网络请求", desc: "发起 HTTP 请求", control: { type: "select", value: "询问", options: ["允许", "询问", "禁止"] }, reason: "tools.approval 工具级审批未接入 Studio Bridge" },
  { key: "tool.browser", label: "Browser", desc: "受控浏览器操作", control: { type: "select", value: "询问", options: ["允许", "询问", "禁止"] }, reason: "tools.approval 工具级审批未接入 Studio Bridge" },
  { key: "tool.computer", label: "Computer", desc: "桌面 / 系统集成操作", control: { type: "select", value: "禁止", options: ["允许", "询问", "禁止"] }, reason: "tools.approval 工具级审批未接入 Studio Bridge" },
  { key: "tool.github", label: "GitHub", desc: "GitHub 集成调用", control: { type: "select", value: "询问", options: ["允许", "询问", "禁止"] }, reason: "tools.approval 工具级审批未接入 Studio Bridge" },
  { key: "tool.fetch", label: "Fetch / Web Search", desc: "抓取网页与搜索", control: { type: "select", value: "允许", options: ["允许", "询问", "禁止"] }, reason: "tools.approval 工具级审批未接入 Studio Bridge" },
  { key: "tool.mcp", label: "MCP / Plugins", desc: "第三方工具调用", control: { type: "select", value: "询问", options: ["允许", "询问", "禁止"] }, reason: "tools.approval 工具级审批未接入 Studio Bridge" },
];

export function PermissionsTab({ ctl, demo }: { ctl: SettingsCtl; demo?: RuntimeDemoApi | undefined }) {
  const { approvalMode, setApprovalMode } = ctl;
  return (
    <>
      <TabHeader title="权限与安全" desc="默认审批模式、工具级审批策略与安全规则。能力启停（Skills / Plugins / MCP）在「能力中心」管理，这里只管调用时如何审批。" />
      <SettingSection title="默认审批模式" desc="OMP 授权语义：活动 Runtime 持久化到全局配置，其余驻留会话收到非持久覆盖。">
        <SettingRow
          label="审批模式"
          desc="Always ask 只自动允许只读操作；Write 额外自动允许工作区写入；Yolo 自动允许读、写、执行"
          source={approvalMode === undefined ? "unavailable" : "runtime"}
          reason="当前值来自运行时会话快照（override 层优先）；无 Runtime 时不可写"
        >
          <select
            className={`select${approvalMode === "yolo" ? " danger" : ""}`}
            value={approvalMode === undefined ? "" : approvalMode}
            disabled={approvalMode === undefined}
            onChange={(event) => {
              const mode = event.target.value as ApprovalModeId;
              if (mode === approvalMode) return;
              setApprovalMode(mode);
            }}
            aria-label="审批模式"
          >
            {approvalMode === undefined ? <option value="" disabled>无 Runtime</option> : null}
            <option value="always-ask">Always ask</option>
            <option value="write">Write</option>
            <option value="yolo">Yolo</option>
          </select>
        </SettingRow>
      </SettingSection>
      <SettingSection title="工具级策略" desc="每类工具的调用审批：允许 / 询问 / 禁止。">
        <FutureRows demo={demo} rows={TOOL_POLICY_ROWS} />
      </SettingSection>
      <SettingSection title="安全规则">
        <FutureRows
          demo={demo}
          rows={[
            { key: "security.outside", label: "工作区外访问策略", desc: "默认如何处理工作区外路径", control: { type: "select", value: "每次询问", options: ["每次询问", "始终允许", "始终禁止"] }, reason: "路径审批规则未接入 Studio Bridge" },
            { key: "security.bashRules", label: "Bash 命令拦截规则", desc: "按命令模式允许 / 拦截", control: { type: "select", value: "默认规则集", options: ["默认规则集", "严格", "关闭"] }, reason: "tools.bashApprovalRules 未接入 Studio Bridge" },
          ]}
        />
        <SettingRow label="始终允许 / 始终禁止规则" desc="跨会话的授权与拒绝规则表" source="unavailable" reason="「始终允许」规则读写不在公共 contract 中">
          <button type="button" className="btn small outline" disabled data-tip="管理规则（暂未实现）">管理规则</button>
        </SettingRow>
        <SettingRow label="清除授权规则" desc="一次性清除已积累的授权" source="unavailable" reason="清除授权规则不在公共 contract 中">
          <button type="button" className="btn small danger" disabled data-tip="清除（暂未实现）">清除全部</button>
        </SettingRow>
      </SettingSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 4. 上下文与记忆                                                      */
/* ------------------------------------------------------------------ */

export function ContextTab({ demo }: { demo?: RuntimeDemoApi | undefined }) {
  return (
    <>
      <TabHeader title="上下文与记忆" desc="上下文压缩、工作区上下文与记忆后端。会话列表、归档与导出在「会话历史」页。" />
      <SettingSection title="上下文压缩">
        <FutureRows
          demo={demo}
          rows={[
            { key: "compact.auto", label: "自动 Compact", desc: "达到阈值时自动压缩上下文", control: { type: "toggle", on: true }, reason: R_COMPACTION },
            { key: "compact.strategy", label: "Compact 策略", desc: "压缩算法（OMP compaction.strategy）", control: { type: "select", value: "Snapcompact", options: ["Context-full", "Handoff", "Shake", "Snapcompact", "Off"] }, reason: R_COMPACTION },
            { key: "compact.threshold", label: "Compact 阈值", desc: "Context 使用比例达到该值时触发", control: { type: "select", value: "80%", options: ["默认", "70%", "80%", "90%"] }, reason: R_COMPACTION },
            { key: "compact.midTurn", label: "Turn 中途 Compact", desc: "允许在工具循环中间压缩", control: { type: "toggle", on: false }, reason: R_COMPACTION },
            { key: "compact.idle", label: "空闲时 Compact", desc: "会话空闲时后台压缩", control: { type: "toggle", on: true }, reason: R_COMPACTION },
            { key: "compact.promote", label: "溢出时提升上下文", desc: "Context 满时切换到更大上下文的模型", control: { type: "toggle", on: false }, reason: R_COMPACTION },
            { key: "compact.pruneReads", label: "清理旧读取结果", desc: "移除已被新读取替代的旧结果", control: { type: "toggle", on: true }, reason: R_COMPACTION },
          ]}
        />
      </SettingSection>
      <SettingSection title="工作区上下文">
        <FutureRows
          demo={demo}
          rows={[
            { key: "workspace.extraDirs", label: "附加工作区目录", desc: "工作区之外允许引用的目录", control: { type: "select", value: "无", options: ["无", "已配置 2 个目录"] }, reason: "附加目录配置未接入 Studio Bridge" },
            { key: "workspace.tree", label: "工作区树加入上下文", desc: "把目录结构提供给助手", control: { type: "toggle", on: true }, reason: "工作区上下文配置未接入 Studio Bridge" },
            { key: "workspace.restore", label: "自动恢复项目上下文", desc: "打开项目时恢复上次的项目上下文", control: { type: "toggle", on: true }, reason: "工作区上下文配置未接入 Studio Bridge" },
          ]}
        />
      </SettingSection>
      <SettingSection title="记忆">
        <FutureRows
          demo={demo}
          rows={[
            { key: "memory.backend", label: "记忆后端", desc: "Off / Local / Hindsight / Mnemopi（OMP memory.backend）", control: { type: "select", value: "Local", options: ["Off", "Local", "Hindsight", "Mnemopi"] }, reason: R_MEMORY },
            { key: "memory.recall", label: "自动召回记忆", desc: "相关记忆自动注入上下文", control: { type: "toggle", on: true }, reason: R_MEMORY },
            { key: "memory.retain", label: "自动保留经验", desc: "会话结束后自动沉淀经验", control: { type: "toggle", on: false }, reason: R_MEMORY },
            { key: "memory.injectLimit", label: "记忆注入上限", desc: "单次注入的记忆条数", control: { type: "select", value: "8 条", options: ["4 条", "8 条", "16 条"] }, reason: R_MEMORY },
            { key: "memory.debug", label: "记忆调试信息", desc: "显示召回命中与注入明细", control: { type: "toggle", on: false }, reason: R_MEMORY },
          ]}
        />
      </SettingSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 5. 文件与终端                                                        */
/* ------------------------------------------------------------------ */

export function FilesTab({ demo }: { demo?: RuntimeDemoApi | undefined }) {
  return (
    <>
      <TabHeader title="文件与终端" desc="文件编辑、读取、LSP 与 Shell 行为。Browser、MCP、Skills、Plugins 的目录与启停在「能力中心」。" />
      <SettingSection title="文件编辑">
        <FutureRows
          demo={demo}
          rows={[
            { key: "edit.mode", label: "Edit Mode", desc: "Replace / Patch / Hashline / Apply Patch（OMP edit.mode）", control: { type: "select", value: "Hashline", options: ["Replace", "Patch", "Hashline", "Apply Patch"] }, reason: R_EDIT },
            { key: "edit.fuzzy", label: "模糊匹配", desc: "编辑定位时允许模糊匹配", control: { type: "toggle", on: true }, reason: R_EDIT },
            { key: "edit.fuzzyThreshold", label: "模糊匹配阈值", desc: "匹配的宽松程度", control: { type: "select", value: "默认", options: ["默认", "宽松", "严格"] }, reason: R_EDIT },
            { key: "edit.guardGenerated", label: "阻止修改自动生成文件", desc: "锁定文件（lockfiles 等）默认拦截", control: { type: "toggle", on: true }, reason: R_EDIT },
            { key: "edit.seenLine", label: "Seen-Line Guard", desc: "只允许编辑已读过的行", control: { type: "toggle", on: true }, reason: R_EDIT },
          ]}
        />
      </SettingSection>
      <SettingSection title="文件读取">
        <FutureRows
          demo={demo}
          rows={[
            { key: "read.lineNumbers", label: "默认显示行号", desc: "读取结果的行号显示", control: { type: "toggle", on: true }, reason: "读取呈现为 Runtime 行为，未接入 settings contract" },
            { key: "read.limit", label: "单次读取上限", desc: "一次读取的最大行数", control: { type: "select", value: "2000 行", options: ["500 行", "1000 行", "2000 行"] }, reason: "读取呈现为 Runtime 行为，未接入 settings contract" },
            { key: "read.summary", label: "自动生成读取摘要", desc: "长文件读取时生成摘要", control: { type: "toggle", on: true }, reason: "读取呈现为 Runtime 行为，未接入 settings contract" },
            { key: "read.markdown", label: "Markdown 渲染", desc: "Markdown 文件读取后的渲染方式", control: { type: "select", value: "渲染", options: ["渲染", "纯文本"] }, reason: "读取呈现为 Runtime 行为，未接入 settings contract" },
            { key: "read.previewLength", label: "工具结果预览长度", desc: "工具卡片里结果摘要的长度", control: { type: "select", value: "标准", options: ["简短", "标准", "加长"] }, reason: "读取呈现为 Runtime 行为，未接入 settings contract" },
          ]}
        />
      </SettingSection>
      <SettingSection title="LSP">
        <FutureRows
          demo={demo}
          rows={[
            { key: "lsp.enabled", label: "启用 LSP", desc: "语言服务器集成", control: { type: "toggle", on: true }, reason: R_LSP },
            { key: "lsp.lazy", label: "延迟启动 LSP", desc: "首次需要时再启动语言服务器", control: { type: "toggle", on: true }, reason: R_LSP },
            { key: "lsp.shared", label: "子代理共享 LSP", desc: "子任务复用主会话的语言服务器", control: { type: "toggle", on: true }, reason: R_LSP },
            { key: "lsp.formatOnWrite", label: "写入时格式化", desc: "文件写入后自动格式化", control: { type: "toggle", on: false }, reason: R_LSP },
            { key: "lsp.diagOnWrite", label: "写入时诊断", desc: "写入后立即跑诊断", control: { type: "toggle", on: true }, reason: R_LSP },
            { key: "lsp.diagOnEdit", label: "编辑时诊断", desc: "编辑过程中增量诊断", control: { type: "toggle", on: true }, reason: R_LSP },
          ]}
        />
      </SettingSection>
      <SettingSection title="Shell">
        <FutureRows
          demo={demo}
          rows={[
            { key: "shell.enabled", label: "启用 Bash", desc: "允许执行 Shell 命令", control: { type: "toggle", on: true }, reason: R_SHELL },
            { key: "shell.longCommand", label: "长命令自动转后台任务", desc: "超时命令转后台并轮询", control: { type: "toggle", on: true }, reason: R_SHELL },
            { key: "shell.direnv", label: "自动加载 direnv", desc: "进入目录时加载 direnv 环境", control: { type: "toggle", on: true }, reason: R_SHELL },
            { key: "shell.minimizer", label: "Shell Minimizer", desc: "压缩长命令输出", control: { type: "toggle", on: true }, reason: R_SHELL },
            { key: "shell.runtimes", label: "Python / JavaScript / Ruby / Julia", desc: "内联执行环境的解释器选择", control: { type: "select", value: "自动检测", options: ["自动检测", "独立环境", "关闭"] }, reason: R_SHELL },
          ]}
        />
      </SettingSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 6. 任务与执行                                                        */
/* ------------------------------------------------------------------ */

export function TasksTab({ demo }: { demo?: RuntimeDemoApi | undefined }) {
  return (
    <>
      <TabHeader title="任务与执行" desc="工作模式默认值、任务执行与子任务运行约束。子代理定义、工具与模型分配在「模型配置 · 子代理」。" />
      <SettingSection title="工作模式">
        <FutureRows
          demo={demo}
          rows={[
            { key: "plan.enabled", label: "启用 Plan 模式", desc: "允许进入 Plan 模式", control: { type: "toggle", on: true }, reason: "plan.enabled 为 Runtime 配置；会话内 Plan 命令已可用" },
            { key: "plan.default", label: "新会话默认进入 Plan 模式", desc: "新会话的初始模式", control: { type: "toggle", on: false }, reason: "新会话默认模式未接入 settings contract" },
            { key: "goal.enabled", label: "启用 Goal 模式", desc: "允许创建 Goal", control: { type: "toggle", on: true }, reason: "goal.enabled 为 Runtime 配置；会话内 Goal 命令已可用" },
            { key: "goal.status", label: "显示 Goal 状态", desc: "工作台展示 Goal 进度", control: { type: "toggle", on: true }, reason: "Goal 状态呈现未接入 settings contract" },
            { key: "goal.autoplay", label: "Goal 自动继续策略", desc: "Goal 阶段结束后的动作", control: { type: "select", value: "手动继续", options: ["手动继续", "自动继续"] }, reason: "Goal 自动继续未接入 settings contract" },
          ]}
        />
      </SettingSection>
      <SettingSection title="任务执行">
        <FutureRows
          demo={demo}
          rows={[
            { key: "loop.mode", label: "Loop 模式", desc: "Prompt / Compact / Reset（OMP loop.mode）", control: { type: "select", value: "Prompt", options: ["Prompt", "Compact", "Reset"] }, reason: "loop.mode 为 Runtime 配置；会话内 Loop 命令已可用" },
            { key: "exec.async", label: "异步任务", desc: "长任务异步执行", control: { type: "toggle", on: true }, reason: R_TASK },
            { key: "exec.toolTimeout", label: "工具最大超时时间", desc: "单次工具调用的超时", control: { type: "select", value: "10 分钟", options: ["5 分钟", "10 分钟", "30 分钟"] }, reason: R_TASK },
            { key: "exec.maxConcurrency", label: "最大并发任务数", desc: "同时运行的任务上限", control: { type: "select", value: "4", options: ["2", "4", "8"] }, reason: R_TASK },
            { key: "exec.polling", label: "后台任务轮询策略", desc: "后台任务的轮询节奏", control: { type: "select", value: "自适应", options: ["自适应", "固定间隔"] }, reason: R_TASK },
          ]}
        />
      </SettingSection>
      <SettingSection title="子任务运行约束" desc="只放全局运行限制；Agent 定义、模型覆盖与系统提示在「模型配置 · 子代理」。">
        <FutureRows
          demo={demo}
          rows={[
            { key: "task.maxConcurrency", label: "子任务最大并发数", desc: "同时运行的子任务上限（OMP task.maxConcurrency）", control: { type: "select", value: "8", options: ["4", "8", "16"] }, reason: R_TASK },
            { key: "task.maxDepth", label: "最大递归深度", desc: "子任务嵌套上限（task.maxRecursionDepth）", control: { type: "select", value: "3", options: ["2", "3", "5"] }, reason: R_TASK },
            { key: "task.maxRuntime", label: "单个子任务最大运行时长", desc: "超时自动终止（task.maxRuntimeMs）", control: { type: "select", value: "30 分钟", options: ["10 分钟", "30 分钟", "不限"] }, reason: R_TASK },
            { key: "task.budget", label: "子任务请求预算", desc: "单个子任务的请求上限（task.softRequestBudget）", control: { type: "select", value: "默认", options: ["默认", "1000 次", "500 次"] }, reason: R_TASK },
            { key: "task.preferDelegate", label: "优先委派给子代理", desc: "可拆分任务优先派发给子代理", control: { type: "toggle", on: true }, reason: R_TASK },
            { key: "task.isolation", label: "子任务隔离模式", desc: "共享工作区或隔离副本", control: { type: "select", value: "共享工作区", options: ["共享工作区", "隔离副本"] }, reason: R_TASK },
            { key: "task.merge", label: "隔离修改合并方式", desc: "隔离副本的改动如何回来", control: { type: "select", value: "Patch", options: ["Patch", "Branch"] }, reason: R_TASK },
          ]}
        />
      </SettingSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 7. 高级                                                              */
/* ------------------------------------------------------------------ */

const CONFIG_LAYERS = ["用户配置", "当前项目配置", "CLI Overlay", "Runtime Override", "当前生效值"] as const;

export function AdvancedTab({ demo }: { demo?: RuntimeDemoApi | undefined }) {
  return (
    <>
      <TabHeader title="高级" desc="配置层级、配置文件与高级行为。OMP 路径、RPC Endpoint、Bridge 管理与日志在「诊断中心」。" />
      <SettingSection title="配置层级" desc="只读展示各层配置与当前生效值（默认 < 用户 < 项目 < 覆盖）。">
        <div className="config-layer-list">
          {CONFIG_LAYERS.map((layer) => (
            <div key={layer} className="config-layer-row">
              <span>{layer}</span>
              <span className="small muted">{demo ? "演示值" : "尚未接入"}</span>
            </div>
          ))}
        </div>
        <p className="small muted set-note">{demo ? "预览模式：配置层级为演示数据，不读取真实配置。" : "依赖通用 settings 读模型（含 effective value + source），Phase 2 接入。" }</p>
      </SettingSection>
      <SettingSection title="配置文件">
        <SettingRow label="打开用户配置 / 项目配置" desc="在编辑器中打开 config.yml" source="unavailable" reason="配置目录路径已脱敏，不在公共 contract 中">
          <button type="button" className="btn small outline" disabled data-tip="打开（暂未实现）">打开</button>
        </SettingRow>
        <SettingRow label="查看脱敏配置 / 导出" desc="导出当前生效配置（脱敏）" source="unavailable" reason="通用配置读取不在公共 contract 中">
          <button type="button" className="btn small outline" disabled data-tip="导出（暂未实现）">导出</button>
        </SettingRow>
        <SettingRow label="恢复默认配置" desc="把用户层配置恢复为默认值" source="unavailable" reason="配置批量恢复不在公共 contract 中">
          <button type="button" className="btn small danger" disabled data-tip="恢复默认（暂未实现）">恢复默认</button>
        </SettingRow>
      </SettingSection>
      <SettingSection title="高级行为">
        <FutureRows
          demo={demo}
          rows={[
            { key: "advanced.retry", label: "自动重试策略", desc: "失败后的重试方式", control: { type: "select", value: "指数退避", options: ["指数退避", "固定间隔", "关闭"] }, reason: R_SETTINGS },
            { key: "advanced.retryCount", label: "重试次数", desc: "单次调用的最大重试", control: { type: "select", value: "3", options: ["2", "3", "5"] }, reason: R_SETTINGS },
            { key: "advanced.loopGuard", label: "工具调用循环保护", desc: "检测重复工具调用循环", control: { type: "toggle", on: true }, reason: R_SETTINGS },
            { key: "advanced.repeatThreshold", label: "重复工具调用阈值", desc: "相同调用连续出现该次数后告警", control: { type: "select", value: "10", options: ["5", "10", "20"] }, reason: R_SETTINGS },
          ]}
        />
      </SettingSection>
    </>
  );
}
