/**
 * 「新建标签 / 添加工具」菜单的分类表。
 *
 * 菜单按这张表的顺序渲染，所以「常用」永远在最上面；分组条沿用应用内
 * 「切换模型」分类列表的样式（图标色标 + 名称 + 数量），每个分类有自己的
 * 色相，扫一眼就能分清分区。
 * 面板清单以 `panels/registry.ts` 为准，这里只决定菜单里的归类和顺序；
 * 忘了登记的新面板不会消失，会按原顺序落到末尾的「其他」。
 */
import type { IconName } from "../icons";
import type { PanelId } from "./types";

export type ToolGroupId = "common" | "workspace" | "session" | "automation" | "diagnostics" | "other";

/** 与 `--tint-*` 色板同名；图标色标按它取色。 */
export type ToolGroupTint = "orange" | "blue" | "violet" | "teal" | "rose" | "gray";

export interface ToolGroup {
  readonly id: ToolGroupId;
  readonly icon: IconName;
  readonly tint: ToolGroupTint;
  /** [中文, English]；渲染时按当前语言取。 */
  readonly label: readonly [string, string];
  readonly panels: readonly PanelId[];
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
  { id: "common", icon: "zap", tint: "orange", label: ["常用", "Common"], panels: ["files", "changes", "git-quick", "browser", "computer", "terminal", "agents", "btw"] },
  { id: "workspace", icon: "branch", tint: "blue", label: ["工作区与版本", "Workspace & Git"], panels: ["git", "environment"] },
  { id: "session", icon: "layers", tint: "violet", label: ["会话与上下文", "Session & context"], panels: ["context", "context-viewer", "annotations", "token-counter"] },
  { id: "automation", icon: "globe", tint: "teal", label: ["自动化", "Automation"], panels: ["jobs"] },
  { id: "diagnostics", icon: "wrench", tint: "rose", label: ["诊断与输出", "Diagnostics & output"], panels: ["problems", "tests", "output", "logs", "pvlogs"] },
];

const OTHER: Omit<ToolGroup, "panels"> = { id: "other", icon: "box", tint: "gray", label: ["其他", "Other"] };

/** 按 TOOL_GROUPS 归桶；空分类不渲染，未登记的面板保持原顺序落到「其他」。 */
export function groupToolPanels(panels: readonly PanelId[]): ToolGroup[] {
  const remaining = new Set<PanelId>(panels);
  const groups: ToolGroup[] = [];
  for (const group of TOOL_GROUPS) {
    const members = group.panels.filter(panel => remaining.has(panel));
    if (!members.length) continue;
    for (const panel of members) remaining.delete(panel);
    groups.push({ ...group, panels: members });
  }
  const rest = panels.filter(panel => remaining.has(panel));
  if (rest.length) groups.push({ ...OTHER, panels: rest });
  return groups;
}
