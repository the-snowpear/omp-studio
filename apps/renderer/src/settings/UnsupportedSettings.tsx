import { useI18n } from "../i18n";

export const UNSUPPORTED_SETTINGS = [
  {
    "key": "input.paste",
    "label": "settings.interaction.paste",
    "desc": "settings.interaction.pasteDesc",
    "reason": "settings.interaction.pasteReason",
    "group": "InteractionTab"
  },
  {
    "key": "input.autocomplete",
    "label": "settings.interaction.autocomplete",
    "desc": "settings.interaction.autocompleteDesc",
    "reason": "settings.interaction.autocompleteReason",
    "group": "InteractionTab"
  },
  {
    "key": "input.emoji",
    "label": "settings.interaction.emoji",
    "desc": "settings.interaction.emojiDesc",
    "reason": "settings.interaction.emojiReason",
    "group": "InteractionTab"
  },
  {
    "key": "tool.fileRead",
    "label": "settings.permissions.toolFileRead",
    "desc": "settings.permissions.toolFileReadDesc",
    "reason": "settings.permissions.toolPolicyReason",
    "group": "PermissionsTab"
  },
  {
    "key": "tool.fileWrite",
    "label": "settings.permissions.toolFileWrite",
    "desc": "settings.permissions.toolFileWriteDesc",
    "reason": "settings.permissions.toolPolicyReason",
    "group": "PermissionsTab"
  },
  {
    "key": "tool.outside",
    "label": "settings.permissions.toolOutside",
    "desc": "settings.permissions.toolOutsideDesc",
    "reason": "settings.permissions.toolPolicyReason",
    "group": "PermissionsTab"
  },
  {
    "key": "tool.bash",
    "label": "settings.permissions.toolBash",
    "desc": "settings.permissions.toolBashDesc",
    "reason": "settings.permissions.toolPolicyReason",
    "group": "PermissionsTab"
  },
  {
    "key": "tool.network",
    "label": "settings.permissions.toolNetwork",
    "desc": "settings.permissions.toolNetworkDesc",
    "reason": "settings.permissions.toolPolicyReason",
    "group": "PermissionsTab"
  },
  {
    "key": "tool.browser",
    "label": "settings.permissions.toolBrowser",
    "desc": "settings.permissions.toolBrowserDesc",
    "reason": "settings.permissions.toolPolicyReason",
    "group": "PermissionsTab"
  },
  {
    "key": "tool.computer",
    "label": "settings.permissions.toolComputer",
    "desc": "settings.permissions.toolComputerDesc",
    "reason": "settings.permissions.toolPolicyReason",
    "group": "PermissionsTab"
  },
  {
    "key": "tool.github",
    "label": "settings.permissions.toolGithub",
    "desc": "settings.permissions.toolGithubDesc",
    "reason": "settings.permissions.toolPolicyReason",
    "group": "PermissionsTab"
  },
  {
    "key": "tool.fetch",
    "label": "settings.permissions.toolFetch",
    "desc": "settings.permissions.toolFetchDesc",
    "reason": "settings.permissions.toolPolicyReason",
    "group": "PermissionsTab"
  },
  {
    "key": "tool.mcp",
    "label": "settings.permissions.toolMcp",
    "desc": "settings.permissions.toolMcpDesc",
    "reason": "settings.permissions.toolPolicyReason",
    "group": "PermissionsTab"
  },
  {
    "key": "security.outside",
    "label": "settings.permissions.securityOutside",
    "desc": "settings.permissions.securityOutsideDesc",
    "reason": "settings.permissions.securityOutsideReason",
    "group": "PermissionsTab"
  },
  {
    "key": "security.bashRules",
    "label": "settings.permissions.bashRules",
    "desc": "settings.permissions.bashRulesDesc",
    "reason": "settings.permissions.bashRulesReason",
    "group": "PermissionsTab"
  },
  {
    "key": "workspace.restore",
    "label": "settings.context.workspaceRestore",
    "desc": "settings.context.workspaceRestoreDesc",
    "reason": "settings.context.workspaceRestoreReason",
    "group": "ContextTab"
  },
  {
    "key": "read.previewLength",
    "label": "settings.files.readPreviewLength",
    "desc": "settings.files.readPreviewLengthDesc",
    "reason": "settings.files.readReason",
    "group": "FilesTab"
  },
  {
    "key": "shell.runtimes",
    "label": "settings.files.shellRuntimes",
    "desc": "settings.files.shellRuntimesDesc",
    "reason": "settings.files.shellRuntimesReason",
    "group": "FilesTab"
  },
  {
    "key": "goal.status",
    "label": "settings.tasks.goalStatus",
    "desc": "settings.tasks.goalStatusDesc",
    "reason": "settings.tasks.goalStatusReason",
    "group": "TasksTab"
  },
  {
    "key": "goal.autoplay",
    "label": "settings.tasks.goalAutoplay",
    "desc": "settings.tasks.goalAutoplayDesc",
    "reason": "settings.tasks.goalAutoplayReason",
    "group": "TasksTab"
  },
  {
    "key": "exec.polling",
    "label": "settings.tasks.execPolling",
    "desc": "settings.tasks.execPollingDesc",
    "reason": "settings.reasons.task",
    "group": "TasksTab"
  },
  {
    "key": "task.preferDelegate",
    "label": "settings.tasks.taskPreferDelegate",
    "desc": "settings.tasks.taskPreferDelegateDesc",
    "reason": "settings.reasons.task",
    "group": "TasksTab"
  },
  {
    "key": "conversation.tokenUsage",
    "label": "settings.interaction.showTokenUsage",
    "desc": "settings.interaction.showTokenUsageDesc",
    "reason": "settings.interaction.showTokenUsageReason",
    "group": "InteractionTab"
  },
  {
    "key": "security.manageRules",
    "label": "settings.permissions.ruleTableLabel",
    "desc": "settings.permissions.ruleTableDesc",
    "reason": "settings.permissions.ruleTableReason",
    "group": "PermissionsTab"
  },
  {
    "key": "security.clearRules",
    "label": "settings.permissions.clearRulesLabel",
    "desc": "settings.permissions.clearRulesDesc",
    "reason": "settings.permissions.clearRulesReason",
    "group": "PermissionsTab"
  },
  {
    "key": "config.open",
    "label": "settings.advanced.openConfig",
    "desc": "settings.advanced.openConfigDesc",
    "reason": "settings.advanced.openConfigReason",
    "group": "AdvancedTab"
  },
  {
    "key": "config.export",
    "label": "settings.advanced.viewSanitized",
    "desc": "settings.advanced.viewSanitizedDesc",
    "reason": "settings.advanced.viewSanitizedReason",
    "group": "AdvancedTab"
  },
  {
    "key": "config.reset",
    "label": "settings.advanced.resetDefaults",
    "desc": "settings.advanced.resetDefaultsDesc",
    "reason": "settings.advanced.resetDefaultsReason",
    "group": "AdvancedTab"
  }
] as const;

const GROUPS: Record<string, [string, string]> = {
  InteractionTab: ["对话与输入", "Conversation and input"],
  PermissionsTab: ["权限与安全", "Permissions and security"],
  ContextTab: ["上下文与记忆", "Context and memory"],
  FilesTab: ["工具与终端", "Tools and terminal"],
  TasksTab: ["任务与代理", "Tasks and agents"],
  AdvancedTab: ["运行与配置", "Runtime and configuration"],
};
export function UnsupportedSettings() {
  const { t, resolvedLanguage } = useI18n();
  return <div className="settings-pending">
    <h3>{resolvedLanguage === "zh" ? "待支持" : "Planned settings"}</h3>
    <p className="desc">{resolvedLanguage === "zh" ? "这些功能尚未接入，当前不会修改运行行为。" : "These settings are not connected and do not change Runtime behavior."}</p>
    {Object.entries(GROUPS).map(([group, title]) => <section className="set-section" key={group}>
      <h4>{title[resolvedLanguage === "zh" ? 0 : 1]}</h4>
      {UNSUPPORTED_SETTINGS.filter(item => item.group === group).map(item => <div className="settings-pending-row" data-setting-label={t(item.label)} key={item.key}>
        <strong>{t(item.label)}</strong>
        <p>{t(item.desc)}</p>
        <span>{t(item.reason)}</span>
      </div>)}
    </section>)}
  </div>;
}
