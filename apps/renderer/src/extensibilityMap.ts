/**
 * Map the Host configured inventory onto the existing drawer / capabilities
 * card shapes. Does not invent loaded/session facts.
 */

import type { ExtensibilityReadModel, PluginRecord, SkillRecord } from "@omp-studio/client-contract";

import type { DrawerItem, PluginPreview, SkillPreview } from "./skillsPreview";

export function skillToPreview(skill: SkillRecord): SkillPreview {
  return {
    kind: "skill",
    name: skill.name,
    desc: skill.desc,
    src: skill.sourceLabel,
    scope: skill.scope,
    path: skill.sourceLabel,
    enabled: skill.enabled,
    loaded: false,
    session: false,
    ...(skill.error === undefined ? {} : { error: skill.error }),
  };
}

export function pluginToPreview(plugin: PluginRecord): PluginPreview {
  return {
    kind: "plugin",
    name: plugin.name,
    src: plugin.srcLabel,
    status: plugin.status === "error" ? "error" : "loaded",
    tools: plugin.tools,
    commands: plugin.commands,
    hooks: plugin.hooks,
    ui: plugin.ui,
    err: plugin.err ?? null,
    enabled: plugin.enabled,
    toolItems: [...plugin.toolItems],
    commandItems: [...plugin.commandItems],
    hookItems: [...plugin.hookItems],
    uiItems: [...plugin.uiItems],
  };
}

export function toDrawerItems(model: ExtensibilityReadModel): DrawerItem[] {
  return [...model.skills.map(skillToPreview), ...model.plugins.map(pluginToPreview)];
}
