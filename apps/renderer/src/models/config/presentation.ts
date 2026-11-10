

export const STATUS_META: Record<string, { label: string; chip: string; dot: string }> = {
  available: { label: "Available", chip: "green", dot: "green" },
  "not-authenticated": { label: "Not Authenticated", chip: "amber", dot: "amber" },
  disabled: { label: "Disabled", chip: "gray", dot: "" },
  offline: { label: "Offline", chip: "red", dot: "red" },
  "auth-expired": { label: "Authentication Expired", chip: "amber", dot: "amber" },
  "config-error": { label: "Configuration Error", chip: "red", dot: "red" },
  "connection-failed": { label: "Connection Failed", chip: "red", dot: "red" },
};

// 原生 = OMP 内置/运行时解析；第三方 = 用户自定义/扩展。
export const SOURCE_GROUP = (source: string): "native" | "third" =>
  source === "builtin" || source === "runtime" ? "native" : "third";

const BUILTIN_ROLE_DESC_KEYS: Record<string, string> = {
  default: "modelConfig.roleDescDefault",
  smol: "modelConfig.roleDescFast",
  slow: "modelConfig.roleDescThinking",
  vision: "modelConfig.roleDescVision",
  plan: "modelConfig.roleDescArchitect",
  designer: "modelConfig.roleDescDesigner",
  commit: "modelConfig.roleDescCommit",
  tiny: "modelConfig.roleDescTiny",
  task: "modelConfig.roleDescSubtask",
  advisor: "modelConfig.roleDescAdvisor",
  widget: "modelConfig.roleDescWidget",
};

export function formatRoleDesc(role: { id: string; desc: string; builtin?: boolean }, t: (k: string) => string): string {
  const key = BUILTIN_ROLE_DESC_KEYS[role.id];
  if (role.builtin && key) {
    return t(key);
  }
  return role.desc;
}

const PROVIDER_STATUS_DETAIL_KEYS: Record<string, string> = {
  "OMP 已解析到可用模型": "modelConfig.statusOmpResolved",
  "已从 models.yml 读取": "modelConfig.statusReadFromModelsYml",
  "已在 disabledProviders 中禁用": "modelConfig.statusDisabledInConfig",
  "已禁用": "modelConfig.statusDisabled",
  "尚未登录": "modelConfig.statusNotLoggedIn",
  "尚未配置凭据": "modelConfig.statusNoCredentials",
  "已登录 · 演示账号": "modelConfig.statusDemoAccount",
  "API Key 已保存": "modelConfig.statusApiKeySaved",
  "本地服务未运行": "modelConfig.statusLocalServiceNotRunning",
};

export function formatProviderStatusDetail(detail: string | undefined, t: (k: string) => string, marks = true, zh = false): string {
  if (!detail) return "";
  if (!marks) {
    if (detail === "已登录 · 演示账号" || detail === "Logged in · Demo Account") return zh ? "已登录" : "Logged in";
    if (detail === "Demo · Not written to Host") return "";
    return detail;
  }
  if (PROVIDER_STATUS_DETAIL_KEYS[detail]) {
    return t(PROVIDER_STATUS_DETAIL_KEYS[detail]);
  }
  return detail;
}
