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
import { useI18n } from "../i18n";


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
  const { t } = useI18n();
  return (
    <>
      <h3>{title}{ctl?.preview ? <span className="chip amber xs demo-chip">{t("common.demo")}</span> : null}</h3>
      <p className="desc">{desc}</p>
      {resetKeys ? (
        <div className="set-toolbar">
          <button
            type="button"
            className="btn small outline"
            disabled={ctl === undefined || ctl.preview}
            data-tip={ctl?.preview ? t("common.preview") : (resetTitle ?? t("common.resetDefaults"))}
            onClick={() => ctl?.resetApp(resetKeys)}
          >
            {resetTitle ?? t("common.resetDefaults")}
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
  | { readonly type: "select"; readonly value: string; readonly options: ReadonlyArray<string | readonly [string, string]> }
  | { readonly type: "toggle"; readonly on: boolean };

interface FutureRowDef {
  readonly key: string;
  readonly label: string;
  readonly desc: string;
  readonly control: FutureControl;
  readonly reason: string;
}

function FutureRows({ rows, demo }: { rows: readonly FutureRowDef[]; demo?: RuntimeDemoApi | undefined }) {
  const { t } = useI18n();
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
            {row.control.options.map((option) => {
              const [optVal, optLabel] = Array.isArray(option) ? option : [option, option];
              return (
                <option key={optVal} value={optVal}>{optLabel}</option>
              );
            })}
          </select>
        ) : (
          <StaticSelect value={row.control.value} options={row.control.options} label={row.label} title={row.reason} />
        )
      ) : demo ? (
        <Switch checked={demo.flag(row.key)} onChange={() => demo.toggle(row.key)} label={row.label} />
      ) : (
        <Switch checked={row.control.on} onChange={() => undefined} disabled label={row.label} />
      )}
    </SettingRow>
  ));
}

/* ------------------------------------------------------------------ */
/* 1. 常规                                                              */
/* ------------------------------------------------------------------ */

const GENERAL_RESET_KEYS: readonly (keyof AppSettings)[] = [
  "language", "theme", "density", "streaming", "toolActivity",
  "restoreLastProject", "restoreLastSession", "startupPage",
  "rememberLayout", "perProjectLayout",
  "notifyTaskDone", "notifyErrors", "notifyConfirmations", "notifyLongTasks",
];

export function GeneralTab({ ctl }: { ctl: SettingsCtl }) {
  const { t } = useI18n();
  const { app, updateApp } = ctl;
  return (
    <>
      <TabHeader
        title={t("settings.general.title")}
        desc={t("settings.general.desc")}
        ctl={ctl}
        resetKeys={GENERAL_RESET_KEYS}
      />
      <SettingSection title={t("settings.general.sectionApp")}>
        <SettingRow label={t("settings.general.language")} desc={t("settings.general.languageDesc")} source={appSource(app, "language")}>
          <AppSelect
            label={t("settings.general.language")}
            value={app.language}
            options={[
              ["system", t("settings.general.langSystem")],
              ["zh", t("settings.general.langZh")],
              ["en", t("settings.general.langEn")],
            ]}
            onChange={(language) => updateApp({ language })}
          />
        </SettingRow>
        <SettingRow label={t("settings.general.theme")} desc={t("settings.general.themeDesc")} source={appSource(app, "theme")}>
          <AppSelect
            label={t("settings.general.theme")}
            value={app.theme}
            options={[
              ["light", t("settings.general.themeLight")],
              ["dark", t("settings.general.themeDark")],
            ]}
            onChange={(theme) => updateApp({ theme })}
          />
        </SettingRow>
        <SettingRow label={t("settings.general.density")} desc={t("settings.general.densityDesc")} source={appSource(app, "density")}>
          <AppSelect
            label={t("settings.general.density")}
            value={app.density}
            options={[
              ["compact", t("settings.general.densityCompact")],
              ["standard", t("settings.general.densityStandard")],
              ["cozy", t("settings.general.densityCozy")],
            ]}
            onChange={(density) => updateApp({ density })}
          />
        </SettingRow>
        <SettingRow label={t("settings.general.streaming")} desc={t("settings.general.streamingDesc")} source={appSource(app, "streaming")}>
          <Switch checked={app.streaming} onChange={(streaming) => updateApp({ streaming })} label={t("settings.general.streaming")} />
        </SettingRow>
        <SettingRow label={t("settings.general.toolActivity")} desc={t("settings.general.toolActivityDesc")} source={appSource(app, "toolActivity")}>
          <AppSelect
            label={t("settings.general.toolActivity")}
            value={app.toolActivity}
            options={[
              ["full", t("settings.general.toolFull")],
              ["concise", t("settings.general.toolConcise")],
              ["hidden", t("settings.general.toolHidden")],
            ]}
            onChange={(toolActivity) => updateApp({ toolActivity })}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.general.sectionStartup")}>
        <SettingRow label={t("settings.general.restoreLastProject")} desc={t("settings.general.restoreLastProjectDesc")} source={appSource(app, "restoreLastProject")}>
          <Switch checked={app.restoreLastProject} onChange={(restoreLastProject) => updateApp({ restoreLastProject })} label={t("settings.general.restoreLastProject")} />
        </SettingRow>
        <SettingRow label={t("settings.general.restoreLastSession")} desc={t("settings.general.restoreLastSessionDesc")} source={appSource(app, "restoreLastSession")}>
          <Switch checked={app.restoreLastSession} onChange={(restoreLastSession) => updateApp({ restoreLastSession })} label={t("settings.general.restoreLastSession")} />
        </SettingRow>
        <SettingRow label={t("settings.general.startupPage")} desc={t("settings.general.startupPageDesc")} source={appSource(app, "startupPage")}>
          <AppSelect
            label={t("settings.general.startupPage")}
            value={app.startupPage}
            options={[
              ["home", t("settings.general.startupHome")],
              ["workbench", t("settings.general.startupWorkbench")],
              ["last", t("settings.general.startupLast")],
            ]}
            onChange={(startupPage) => updateApp({ startupPage })}
          />
        </SettingRow>
        <SettingRow label={t("settings.general.rememberLayout")} desc={t("settings.general.rememberLayoutDesc")} source={appSource(app, "rememberLayout")}>
          <Switch checked={app.rememberLayout} onChange={(rememberLayout) => updateApp({ rememberLayout })} label={t("settings.general.rememberLayout")} />
        </SettingRow>
        <SettingRow label={t("settings.general.perProjectLayout")} desc={t("settings.general.perProjectLayoutDesc")} source={appSource(app, "perProjectLayout")}>
          <Switch checked={app.perProjectLayout} onChange={(perProjectLayout) => updateApp({ perProjectLayout })} label={t("settings.general.perProjectLayout")} />
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.general.sectionNotify")} desc={t("settings.general.notifyDesc")}>
        <SettingRow label={t("settings.general.notifyTaskDone")} desc={t("settings.general.notifyTaskDoneDesc")} source={appSource(app, "notifyTaskDone")}>
          <Switch checked={app.notifyTaskDone} onChange={(notifyTaskDone) => updateApp({ notifyTaskDone })} label={t("settings.general.notifyTaskDone")} />
        </SettingRow>
        <SettingRow label={t("settings.general.notifyErrors")} desc={t("settings.general.notifyErrorsDesc")} source={appSource(app, "notifyErrors")}>
          <Switch checked={app.notifyErrors} onChange={(notifyErrors) => updateApp({ notifyErrors })} label={t("settings.general.notifyErrors")} />
        </SettingRow>
        <SettingRow label={t("settings.general.notifyConfirmations")} desc={t("settings.general.notifyConfirmationsDesc")} source={appSource(app, "notifyConfirmations")}>
          <Switch checked={app.notifyConfirmations} onChange={(notifyConfirmations) => updateApp({ notifyConfirmations })} label={t("settings.general.notifyConfirmations")} />
        </SettingRow>
        <SettingRow label={t("settings.general.notifyLongTasks")} desc={t("settings.general.notifyLongTasksDesc")} source={appSource(app, "notifyLongTasks")}>
          <Switch checked={app.notifyLongTasks} onChange={(notifyLongTasks) => updateApp({ notifyLongTasks })} label={t("settings.general.notifyLongTasks")} />
        </SettingRow>
      </SettingSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 2. 对话与交互                                                        */
/* ------------------------------------------------------------------ */

export function InteractionTab({ ctl, demo }: { ctl: SettingsCtl; demo?: RuntimeDemoApi | undefined }) {
  const { t } = useI18n();
  const { app, updateApp } = ctl;
  return (
    <>
      <TabHeader
        title={t("settings.interaction.title")}
        desc={t("settings.interaction.desc")}
        ctl={ctl}
        resetKeys={["showThinkingSummary", "showToolIntent"]}
      />
      <SettingSection title={t("settings.interaction.sectionInput")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "input.steering", label: t("settings.interaction.steering"), desc: t("settings.interaction.steeringDesc"), control: { type: "select", value: "一次处理一条", options: [["一次处理全部", t("settings.interaction.steeringAll")], ["一次处理一条", t("settings.interaction.steeringOne")]] }, reason: t("settings.interaction.steeringReason") },
            { key: "input.followup", label: t("settings.interaction.followup"), desc: t("settings.interaction.followupDesc"), control: { type: "select", value: "一次处理全部", options: [["一次处理全部", t("settings.interaction.followupAll")], ["一次处理一条", t("settings.interaction.followupOne")]] }, reason: t("settings.interaction.followupReason") },
            { key: "input.interrupt", label: t("settings.interaction.interrupt"), desc: t("settings.interaction.interruptDesc"), control: { type: "select", value: "当前工具完成后中断", options: [["立即中断", t("settings.interaction.interruptImmediate")], ["当前工具完成后中断", t("settings.interaction.interruptAfterTool")]] }, reason: t("settings.interaction.interruptReason") },
            { key: "input.paste", label: t("settings.interaction.paste"), desc: t("settings.interaction.pasteDesc"), control: { type: "select", value: "自动转文件", options: [["直接插入", t("settings.interaction.pasteDirect")], ["自动转文件", t("settings.interaction.pasteFile")], ["自动包裹代码块", t("settings.interaction.pasteCodeblock")]] }, reason: t("settings.interaction.pasteReason") },
            { key: "input.autocomplete", label: t("settings.interaction.autocomplete"), desc: t("settings.interaction.autocompleteDesc"), control: { type: "select", value: "8 条", options: [["5 条", t("settings.interaction.count5")], ["8 条", t("settings.interaction.count8")], ["12 条", t("settings.interaction.count12")]] }, reason: t("settings.interaction.autocompleteReason") },
            { key: "input.emoji", label: t("settings.interaction.emoji"), desc: t("settings.interaction.emojiDesc"), control: { type: "toggle", on: true }, reason: t("settings.interaction.emojiReason") },
          ]}
        />
      </SettingSection>
      <SettingSection title={t("settings.interaction.sectionReply")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "reply.style", label: t("settings.interaction.replyStyle"), desc: t("settings.interaction.replyStyleDesc"), control: { type: "select", value: "Default", options: [["Default", "Default"], ["Friendly", "Friendly"], ["Pragmatic", "Pragmatic"], ["None", "None"]] }, reason: t("settings.interaction.replyStyleReason") },
            { key: "reply.detail", label: t("settings.interaction.replyDetail"), desc: t("settings.interaction.replyDetailDesc"), control: { type: "select", value: "Balanced", options: [["Concise", t("settings.interaction.detailConcise")], ["Balanced", t("settings.interaction.detailBalanced")], ["Detailed", t("settings.interaction.detailDetailed")]] }, reason: t("settings.interaction.replyDetailReason") },
          ]}
        />
        <SettingRow label={t("settings.interaction.showThinkingSummary")} desc={t("settings.interaction.showThinkingSummaryDesc")} source={appSource(app, "showThinkingSummary")}>
          <Switch checked={app.showThinkingSummary} onChange={(showThinkingSummary) => updateApp({ showThinkingSummary })} label={t("settings.interaction.showThinkingSummary")} />
        </SettingRow>
        <SettingRow label={t("settings.interaction.showToolIntent")} desc={t("settings.interaction.showToolIntentDesc")} source={appSource(app, "showToolIntent")}>
          <Switch checked={app.showToolIntent} onChange={(showToolIntent) => updateApp({ showToolIntent })} label={t("settings.interaction.showToolIntent")} />
        </SettingRow>
        <SettingRow label={t("settings.interaction.showTokenUsage")} desc={t("settings.interaction.showTokenUsageDesc")} source="unavailable" reason={t("settings.interaction.showTokenUsageReason")}>
          <Switch checked={app.showTokenUsage} onChange={() => undefined} disabled label={t("settings.interaction.showTokenUsage")} />
        </SettingRow>
      </SettingSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 3. 权限与安全                                                        */
/* ------------------------------------------------------------------ */

export function PermissionsTab({ ctl, demo }: { ctl: SettingsCtl; demo?: RuntimeDemoApi | undefined }) {
  const { t } = useI18n();
  const { approvalMode, setApprovalMode } = ctl;

  const toolPolicyOptions: ReadonlyArray<readonly [string, string]> = [
    ["允许", t("settings.permissions.allow")],
    ["询问", t("settings.permissions.ask")],
    ["禁止", t("settings.permissions.deny")],
  ];

  const toolPolicyRows: readonly FutureRowDef[] = [
    { key: "tool.fileRead", label: t("settings.permissions.toolFileRead"), desc: t("settings.permissions.toolFileReadDesc"), control: { type: "select", value: "允许", options: toolPolicyOptions }, reason: t("settings.permissions.toolPolicyReason") },
    { key: "tool.fileWrite", label: t("settings.permissions.toolFileWrite"), desc: t("settings.permissions.toolFileWriteDesc"), control: { type: "select", value: "允许", options: toolPolicyOptions }, reason: t("settings.permissions.toolPolicyReason") },
    { key: "tool.outside", label: t("settings.permissions.toolOutside"), desc: t("settings.permissions.toolOutsideDesc"), control: { type: "select", value: "询问", options: toolPolicyOptions }, reason: t("settings.permissions.toolPolicyReason") },
    { key: "tool.bash", label: t("settings.permissions.toolBash"), desc: t("settings.permissions.toolBashDesc"), control: { type: "select", value: "询问", options: toolPolicyOptions }, reason: t("settings.permissions.toolPolicyReason") },
    { key: "tool.network", label: t("settings.permissions.toolNetwork"), desc: t("settings.permissions.toolNetworkDesc"), control: { type: "select", value: "询问", options: toolPolicyOptions }, reason: t("settings.permissions.toolPolicyReason") },
    { key: "tool.browser", label: t("settings.permissions.toolBrowser"), desc: t("settings.permissions.toolBrowserDesc"), control: { type: "select", value: "询问", options: toolPolicyOptions }, reason: t("settings.permissions.toolPolicyReason") },
    { key: "tool.computer", label: t("settings.permissions.toolComputer"), desc: t("settings.permissions.toolComputerDesc"), control: { type: "select", value: "禁止", options: toolPolicyOptions }, reason: t("settings.permissions.toolPolicyReason") },
    { key: "tool.github", label: t("settings.permissions.toolGithub"), desc: t("settings.permissions.toolGithubDesc"), control: { type: "select", value: "询问", options: toolPolicyOptions }, reason: t("settings.permissions.toolPolicyReason") },
    { key: "tool.fetch", label: t("settings.permissions.toolFetch"), desc: t("settings.permissions.toolFetchDesc"), control: { type: "select", value: "允许", options: toolPolicyOptions }, reason: t("settings.permissions.toolPolicyReason") },
    { key: "tool.mcp", label: t("settings.permissions.toolMcp"), desc: t("settings.permissions.toolMcpDesc"), control: { type: "select", value: "询问", options: toolPolicyOptions }, reason: t("settings.permissions.toolPolicyReason") },
  ];

  return (
    <>
      <TabHeader title={t("settings.permissions.title")} desc={t("settings.permissions.desc")} />
      <SettingSection title={t("settings.permissions.sectionDefaultMode")} desc={t("settings.permissions.sectionDefaultModeDesc")}>
        <SettingRow
          label={t("settings.permissions.approvalMode")}
          desc={t("settings.permissions.approvalModeDesc")}
          source={approvalMode === undefined ? "unavailable" : "runtime"}
          reason={t("settings.permissions.approvalModeReason")}
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
            aria-label={t("settings.permissions.approvalMode")}
          >
            {approvalMode === undefined ? <option value="" disabled>{t("settings.permissions.noRuntime")}</option> : null}
            <option value="always-ask">Always ask</option>
            <option value="write">Write</option>
            <option value="yolo">Yolo</option>
          </select>
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.permissions.sectionToolPolicy")} desc={t("settings.permissions.sectionToolPolicyDesc")}>
        <FutureRows demo={demo} rows={toolPolicyRows} />
      </SettingSection>
      <SettingSection title={t("settings.permissions.sectionSecurityRules")}>
        <FutureRows
          demo={demo}
          rows={[
            {
              key: "security.outside",
              label: t("settings.permissions.securityOutside"),
              desc: t("settings.permissions.securityOutsideDesc"),
              control: {
                type: "select",
                value: "每次询问",
                options: [
                  ["每次询问", t("settings.permissions.askEachTime")],
                  ["始终允许", t("settings.permissions.alwaysAllow")],
                  ["始终禁止", t("settings.permissions.alwaysDeny")],
                ],
              },
              reason: t("settings.permissions.securityOutsideReason"),
            },
            {
              key: "security.bashRules",
              label: t("settings.permissions.bashRules"),
              desc: t("settings.permissions.bashRulesDesc"),
              control: {
                type: "select",
                value: "默认规则集",
                options: [
                  ["默认规则集", t("settings.permissions.rulesDefault")],
                  ["严格", t("settings.permissions.rulesStrict")],
                  ["关闭", t("settings.permissions.rulesOff")],
                ],
              },
              reason: t("settings.permissions.bashRulesReason"),
            },
          ]}
        />
        <SettingRow
          label={t("settings.permissions.ruleTableLabel")}
          desc={t("settings.permissions.ruleTableDesc")}
          source="unavailable"
          reason={t("settings.permissions.ruleTableReason")}
        >
          <button type="button" className="btn small outline" disabled data-tip={`${t("settings.permissions.manageRulesBtn")}（${t("common.notImplemented")}）`}>
            {t("settings.permissions.manageRulesBtn")}
          </button>
        </SettingRow>
        <SettingRow
          label={t("settings.permissions.clearRulesLabel")}
          desc={t("settings.permissions.clearRulesDesc")}
          source="unavailable"
          reason={t("settings.permissions.clearRulesReason")}
        >
          <button type="button" className="btn small danger" disabled data-tip={`${t("settings.permissions.clearAllBtn")}（${t("common.notImplemented")}）`}>
            {t("settings.permissions.clearAllBtn")}
          </button>
        </SettingRow>
      </SettingSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 4. 上下文与记忆                                                      */
/* ------------------------------------------------------------------ */

export function ContextTab({ demo }: { demo?: RuntimeDemoApi | undefined }) {
  const { t } = useI18n();
  return (
    <>
      <TabHeader title={t("settings.context.title")} desc={t("settings.context.desc")} />
      <SettingSection title={t("settings.context.sectionCompaction")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "compact.auto", label: t("settings.context.compactAuto"), desc: t("settings.context.compactAutoDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.compaction") },
            { key: "compact.strategy", label: t("settings.context.compactStrategy"), desc: t("settings.context.compactStrategyDesc"), control: { type: "select", value: "Snapcompact", options: [["Context-full", "Context-full"], ["Handoff", "Handoff"], ["Shake", "Shake"], ["Snapcompact", "Snapcompact"], ["Off", "Off"]] }, reason: t("settings.reasons.compaction") },
            { key: "compact.threshold", label: t("settings.context.compactThreshold"), desc: t("settings.context.compactThresholdDesc"), control: { type: "select", value: "80%", options: [["默认", t("settings.context.thresholdDefault")], ["70%", "70%"], ["80%", "80%"], ["90%", "90%"]] }, reason: t("settings.reasons.compaction") },
            { key: "compact.midTurn", label: t("settings.context.compactMidTurn"), desc: t("settings.context.compactMidTurnDesc"), control: { type: "toggle", on: false }, reason: t("settings.reasons.compaction") },
            { key: "compact.idle", label: t("settings.context.compactIdle"), desc: t("settings.context.compactIdleDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.compaction") },
            { key: "compact.promote", label: t("settings.context.compactPromote"), desc: t("settings.context.compactPromoteDesc"), control: { type: "toggle", on: false }, reason: t("settings.reasons.compaction") },
            { key: "compact.pruneReads", label: t("settings.context.compactPruneReads"), desc: t("settings.context.compactPruneReadsDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.compaction") },
          ]}
        />
      </SettingSection>
      <SettingSection title={t("settings.context.sectionWorkspace")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "workspace.extraDirs", label: t("settings.context.workspaceExtraDirs"), desc: t("settings.context.workspaceExtraDirsDesc"), control: { type: "select", value: "已配置 2 个目录", options: [["无", t("settings.context.extraDirsNone")], ["已配置 2 个目录", t("settings.context.extraDirsConfigured")]] }, reason: t("settings.context.workspaceExtraDirsReason") },
            { key: "workspace.tree", label: t("settings.context.workspaceTree"), desc: t("settings.context.workspaceTreeDesc"), control: { type: "toggle", on: true }, reason: t("settings.context.workspaceTreeReason") },
            { key: "workspace.restore", label: t("settings.context.workspaceRestore"), desc: t("settings.context.workspaceRestoreDesc"), control: { type: "toggle", on: true }, reason: t("settings.context.workspaceRestoreReason") },
          ]}
        />
      </SettingSection>
      <SettingSection title={t("settings.context.sectionMemory")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "memory.backend", label: t("settings.context.memoryBackend"), desc: t("settings.context.memoryBackendDesc"), control: { type: "select", value: "Local", options: [["Off", "Off"], ["Local", "Local"], ["Hindsight", "Hindsight"], ["Mnemopi", "Mnemopi"]] }, reason: t("settings.reasons.memory") },
            { key: "memory.recall", label: t("settings.context.memoryRecall"), desc: t("settings.context.memoryRecallDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.memory") },
            { key: "memory.retain", label: t("settings.context.memoryRetain"), desc: t("settings.context.memoryRetainDesc"), control: { type: "toggle", on: false }, reason: t("settings.reasons.memory") },
            { key: "memory.injectLimit", label: t("settings.context.memoryInjectLimit"), desc: t("settings.context.memoryInjectLimitDesc"), control: { type: "select", value: "8 条", options: [["4 条", t("settings.context.count4")], ["8 条", t("settings.interaction.count8")], ["16 条", t("settings.context.count16")]] }, reason: t("settings.reasons.memory") },
            { key: "memory.debug", label: t("settings.context.memoryDebug"), desc: t("settings.context.memoryDebugDesc"), control: { type: "toggle", on: false }, reason: t("settings.reasons.memory") },
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
  const { t } = useI18n();
  return (
    <>
      <TabHeader title={t("settings.files.title")} desc={t("settings.files.desc")} />
      <SettingSection title={t("settings.files.sectionEdit")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "edit.mode", label: t("settings.files.editMode"), desc: t("settings.files.editModeDesc"), control: { type: "select", value: "Hashline", options: [["Replace", "Replace"], ["Patch", "Patch"], ["Hashline", "Hashline"], ["Apply Patch", "Apply Patch"]] }, reason: t("settings.reasons.edit") },
            { key: "edit.fuzzy", label: t("settings.files.editFuzzy"), desc: t("settings.files.editFuzzyDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.edit") },
            { key: "edit.fuzzyThreshold", label: t("settings.files.editFuzzyThreshold"), desc: t("settings.files.editFuzzyThresholdDesc"), control: { type: "select", value: "默认", options: [["默认", t("settings.context.thresholdDefault")], ["宽松", t("settings.files.thresholdLenient")], ["严格", t("settings.files.thresholdStrict")]] }, reason: t("settings.reasons.edit") },
            { key: "edit.guardGenerated", label: t("settings.files.editGuardGenerated"), desc: t("settings.files.editGuardGeneratedDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.edit") },
            { key: "edit.seenLine", label: t("settings.files.editSeenLine"), desc: t("settings.files.editSeenLineDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.edit") },
          ]}
        />
      </SettingSection>
      <SettingSection title={t("settings.files.sectionRead")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "read.lineNumbers", label: t("settings.files.readLineNumbers"), desc: t("settings.files.readLineNumbersDesc"), control: { type: "toggle", on: true }, reason: t("settings.files.readReason") },
            { key: "read.limit", label: t("settings.files.readLimit"), desc: t("settings.files.readLimitDesc"), control: { type: "select", value: "2000 行", options: [["500 行", t("settings.files.lines500")], ["1000 行", t("settings.files.lines1000")], ["2000 行", t("settings.files.lines2000")]] }, reason: t("settings.files.readReason") },
            { key: "read.summary", label: t("settings.files.readSummary"), desc: t("settings.files.readSummaryDesc"), control: { type: "toggle", on: true }, reason: t("settings.files.readReason") },
            { key: "read.markdown", label: t("settings.files.readMarkdown"), desc: t("settings.files.readMarkdownDesc"), control: { type: "select", value: "渲染", options: [["渲染", t("settings.files.readRender")], ["纯文本", t("settings.files.readPlainText")]] }, reason: t("settings.files.readReason") },
            { key: "read.previewLength", label: t("settings.files.readPreviewLength"), desc: t("settings.files.readPreviewLengthDesc"), control: { type: "select", value: "标准", options: [["简短", t("settings.files.previewShort")], ["标准", t("settings.files.previewStandard")], ["加长", t("settings.files.previewLong")]] }, reason: t("settings.files.readReason") },
          ]}
        />
      </SettingSection>
      <SettingSection title={t("settings.files.sectionLsp")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "lsp.enabled", label: t("settings.files.lspEnabled"), desc: t("settings.files.lspEnabledDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.lsp") },
            { key: "lsp.lazy", label: t("settings.files.lspLazy"), desc: t("settings.files.lspLazyDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.lsp") },
            { key: "lsp.shared", label: t("settings.files.lspShared"), desc: t("settings.files.lspSharedDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.lsp") },
            { key: "lsp.formatOnWrite", label: t("settings.files.lspFormatOnWrite"), desc: t("settings.files.lspFormatOnWriteDesc"), control: { type: "toggle", on: false }, reason: t("settings.reasons.lsp") },
            { key: "lsp.diagOnWrite", label: t("settings.files.lspDiagOnWrite"), desc: t("settings.files.lspDiagOnWriteDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.lsp") },
            { key: "lsp.diagOnEdit", label: t("settings.files.lspDiagOnEdit"), desc: t("settings.files.lspDiagOnEditDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.lsp") },
          ]}
        />
      </SettingSection>
      <SettingSection title={t("settings.files.sectionShell")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "shell.enabled", label: t("settings.files.shellEnabled"), desc: t("settings.files.shellEnabledDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.shell") },
            { key: "shell.longCommand", label: t("settings.files.shellLongCommand"), desc: t("settings.files.shellLongCommandDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.shell") },
            { key: "shell.direnv", label: t("settings.files.shellDirenv"), desc: t("settings.files.shellDirenvDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.shell") },
            { key: "shell.minimizer", label: t("settings.files.shellMinimizer"), desc: t("settings.files.shellMinimizerDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.shell") },
            { key: "shell.runtimes", label: t("settings.files.shellRuntimes"), desc: t("settings.files.shellRuntimesDesc"), control: { type: "select", value: "自动检测", options: [["自动检测", t("settings.files.runtimesAuto")], ["独立环境", t("settings.files.runtimesIsolated")], ["关闭", t("settings.files.runtimesDisabled")]] }, reason: t("settings.reasons.shell") },
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
  const { t } = useI18n();
  return (
    <>
      <TabHeader title={t("settings.tasks.title")} desc={t("settings.tasks.desc")} />
      <SettingSection title={t("settings.tasks.sectionWorkMode")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "plan.enabled", label: t("settings.tasks.planEnabled"), desc: t("settings.tasks.planEnabledDesc"), control: { type: "toggle", on: true }, reason: t("settings.tasks.planEnabledReason") },
            { key: "plan.default", label: t("settings.tasks.planDefault"), desc: t("settings.tasks.planDefaultDesc"), control: { type: "toggle", on: false }, reason: t("settings.tasks.planDefaultReason") },
            { key: "goal.enabled", label: t("settings.tasks.goalEnabled"), desc: t("settings.tasks.goalEnabledDesc"), control: { type: "toggle", on: true }, reason: t("settings.tasks.goalEnabledReason") },
            { key: "goal.status", label: t("settings.tasks.goalStatus"), desc: t("settings.tasks.goalStatusDesc"), control: { type: "toggle", on: true }, reason: t("settings.tasks.goalStatusReason") },
            { key: "goal.autoplay", label: t("settings.tasks.goalAutoplay"), desc: t("settings.tasks.goalAutoplayDesc"), control: { type: "select", value: "自动继续", options: [["手动继续", t("settings.tasks.continueManual")], ["自动继续", t("settings.tasks.continueAuto")]] }, reason: t("settings.tasks.goalAutoplayReason") },
          ]}
        />
      </SettingSection>
      <SettingSection title={t("settings.tasks.sectionExecution")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "loop.mode", label: t("settings.tasks.loopMode"), desc: t("settings.tasks.loopModeDesc"), control: { type: "select", value: "Prompt", options: [["Prompt", "Prompt"], ["Compact", "Compact"], ["Reset", "Reset"]] }, reason: t("settings.tasks.loopModeReason") },
            { key: "exec.async", label: t("settings.tasks.execAsync"), desc: t("settings.tasks.execAsyncDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.task") },
            { key: "exec.toolTimeout", label: t("settings.tasks.execToolTimeout"), desc: t("settings.tasks.execToolTimeoutDesc"), control: { type: "select", value: "10 分钟", options: [["5 分钟", t("settings.tasks.mins5")], ["10 分钟", t("settings.tasks.mins10")], ["30 分钟", t("settings.tasks.mins30")]] }, reason: t("settings.reasons.task") },
            { key: "exec.maxConcurrency", label: t("settings.tasks.execMaxConcurrency"), desc: t("settings.tasks.execMaxConcurrencyDesc"), control: { type: "select", value: "4", options: [["2", "2"], ["4", "4"], ["8", "8"]] }, reason: t("settings.reasons.task") },
            { key: "exec.polling", label: t("settings.tasks.execPolling"), desc: t("settings.tasks.execPollingDesc"), control: { type: "select", value: "自适应", options: [["自适应", t("settings.tasks.pollingAdaptive")], ["固定间隔", t("settings.tasks.pollingFixed")]] }, reason: t("settings.reasons.task") },
          ]}
        />
      </SettingSection>
      <SettingSection title={t("settings.tasks.sectionSubtaskLimits")} desc={t("settings.tasks.sectionSubtaskLimitsDesc")}>
        <FutureRows
          demo={demo}
          rows={[
            { key: "task.maxConcurrency", label: t("settings.tasks.taskMaxConcurrency"), desc: t("settings.tasks.taskMaxConcurrencyDesc"), control: { type: "select", value: "8", options: [["4", "4"], ["8", "8"], ["16", "16"]] }, reason: t("settings.reasons.task") },
            { key: "task.maxDepth", label: t("settings.tasks.taskMaxDepth"), desc: t("settings.tasks.taskMaxDepthDesc"), control: { type: "select", value: "3", options: [["2", "2"], ["3", "3"], ["5", "5"]] }, reason: t("settings.reasons.task") },
            { key: "task.maxRuntime", label: t("settings.tasks.taskMaxRuntime"), desc: t("settings.tasks.taskMaxRuntimeDesc"), control: { type: "select", value: "30 分钟", options: [["10 分钟", t("settings.tasks.mins10")], ["30 分钟", t("settings.tasks.mins30")], ["不限", t("settings.tasks.runtimeUnlimited")]] }, reason: t("settings.reasons.task") },
            { key: "task.budget", label: t("settings.tasks.taskBudget"), desc: t("settings.tasks.taskBudgetDesc"), control: { type: "select", value: "默认", options: [["默认", t("settings.context.thresholdDefault")], ["1000 次", t("settings.tasks.budget1000")], ["500 次", t("settings.tasks.budget500")]] }, reason: t("settings.reasons.task") },
            { key: "task.preferDelegate", label: t("settings.tasks.taskPreferDelegate"), desc: t("settings.tasks.taskPreferDelegateDesc"), control: { type: "toggle", on: true }, reason: t("settings.reasons.task") },
            { key: "task.isolation", label: t("settings.tasks.taskIsolation"), desc: t("settings.tasks.taskIsolationDesc"), control: { type: "select", value: "共享工作区", options: [["共享工作区", t("settings.tasks.isolationShared")], ["隔离副本", t("settings.tasks.isolationCopy")]] }, reason: t("settings.reasons.task") },
            { key: "task.merge", label: t("settings.tasks.taskMerge"), desc: t("settings.tasks.taskMergeDesc"), control: { type: "select", value: "Patch", options: [["Patch", "Patch"], ["Branch", "Branch"]] }, reason: t("settings.reasons.task") },
          ]}
        />
      </SettingSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 7. 高级                                                              */
/* ------------------------------------------------------------------ */

export function AdvancedTab({ demo }: { demo?: RuntimeDemoApi | undefined }) {
  const { t } = useI18n();

  const configLayers: ReadonlyArray<readonly [string, string]> = [
    ["user", t("settings.advanced.layerUser")],
    ["project", t("settings.advanced.layerProject")],
    ["cli", t("settings.advanced.layerCli")],
    ["override", t("settings.advanced.layerOverride")],
    ["effective", t("settings.advanced.layerEffective")],
  ];

  return (
    <>
      <TabHeader title={t("settings.advanced.title")} desc={t("settings.advanced.desc")} />
      <SettingSection title={t("settings.advanced.sectionConfigLayers")} desc={t("settings.advanced.sectionConfigLayersDesc")}>
        <div className="config-layer-list">
          {configLayers.map(([key, label]) => (
            <div key={key} className="config-layer-row">
              <span>{label}</span>
              <span className="small muted">{demo ? t("settings.advanced.demoValue") : t("settings.advanced.notConnected")}</span>
            </div>
          ))}
        </div>
        <p className="small muted set-note">
          {demo ? t("settings.advanced.layerNoteDemo") : t("settings.advanced.layerNoteReal")}
        </p>
      </SettingSection>
      <SettingSection title={t("settings.advanced.sectionConfigFiles")}>
        <SettingRow
          label={t("settings.advanced.openConfig")}
          desc={t("settings.advanced.openConfigDesc")}
          source="unavailable"
          reason={t("settings.advanced.openConfigReason")}
        >
          <button type="button" className="btn small outline" disabled data-tip={`${t("settings.advanced.openBtn")}（${t("common.notImplemented")}）`}>
            {t("settings.advanced.openBtn")}
          </button>
        </SettingRow>
        <SettingRow
          label={t("settings.advanced.viewSanitized")}
          desc={t("settings.advanced.viewSanitizedDesc")}
          source="unavailable"
          reason={t("settings.advanced.viewSanitizedReason")}
        >
          <button type="button" className="btn small outline" disabled data-tip={`${t("settings.advanced.exportBtn")}（${t("common.notImplemented")}）`}>
            {t("settings.advanced.exportBtn")}
          </button>
        </SettingRow>
        <SettingRow
          label={t("settings.advanced.resetDefaults")}
          desc={t("settings.advanced.resetDefaultsDesc")}
          source="unavailable"
          reason={t("settings.advanced.resetDefaultsReason")}
        >
          <button type="button" className="btn small danger" disabled data-tip={`${t("settings.advanced.resetDefaultsBtn")}（${t("common.notImplemented")}）`}>
            {t("settings.advanced.resetDefaultsBtn")}
          </button>
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.advanced.sectionAdvancedBehavior")}>
        <FutureRows
          demo={demo}
          rows={[
            {
              key: "advanced.retry",
              label: t("settings.advanced.retryPolicy"),
              desc: t("settings.advanced.retryPolicyDesc"),
              control: {
                type: "select",
                value: "指数退避",
                options: [
                  ["指数退避", t("settings.advanced.retryExponential")],
                  ["固定间隔", t("settings.advanced.retryFixed")],
                  ["关闭", t("settings.advanced.retryDisabled")],
                ],
              },
              reason: t("settings.reasons.settingsContract"),
            },
            {
              key: "advanced.retryCount",
              label: t("settings.advanced.retryCount"),
              desc: t("settings.advanced.retryCountDesc"),
              control: { type: "select", value: "3", options: [["2", "2"], ["3", "3"], ["5", "5"]] },
              reason: t("settings.reasons.settingsContract"),
            },
            {
              key: "advanced.loopGuard",
              label: t("settings.advanced.loopGuard"),
              desc: t("settings.advanced.loopGuardDesc"),
              control: { type: "toggle", on: true },
              reason: t("settings.reasons.settingsContract"),
            },
            {
              key: "advanced.repeatThreshold",
              label: t("settings.advanced.repeatThreshold"),
              desc: t("settings.advanced.repeatThresholdDesc"),
              control: { type: "select", value: "10", options: [["5", "5"], ["10", "10"], ["20", "20"]] },
              reason: t("settings.reasons.settingsContract"),
            },
          ]}
        />
      </SettingSection>
    </>
  );
}

