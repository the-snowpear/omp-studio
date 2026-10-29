import { useEffect, useState } from "react";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { formatShortcut } from "../keyboard/shortcuts";
import { PLATFORM } from "../platform";
import { SettingRow, SettingSection, Switch } from "../settings/SettingRow";
import { useOptionalDock } from "./DockContext";
import { DockPresetNameForm, dockPresetName, useDockCopy } from "./DockMenus";
import { dockProjectKey } from "./store";
import type { RailMode } from "./types";
import "./menus.css";

/** The Settings page can also be rendered without the workbench (e.g. isolated tests). */
export function DockSettings() {
  const dock = useOptionalDock();
  const copy = useDockCopy();
  if (!dock) return <SettingSection title={copy("工作台布局", "Workbench layout")}>
    <p className="set-section-desc">{copy("工作台尚未就绪，布局设置暂不可用。", "Layout settings are unavailable until the workbench is ready.")}</p>
  </SettingSection>;
  return <DockSettingsContent dock={dock} />;
}

function DockSettingsContent({ dock }: { dock: NonNullable<ReturnType<typeof useOptionalDock>> }) {
  const { layout, preferences, presets, scope, store, preview, modified, canUndo, canRedo } = dock;
  const copy = useDockCopy();
  const [selectedId, setSelectedId] = useState(layout.presetId);
  const [editing, setEditing] = useState<"save" | "rename" | "delete" | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => { setSelectedId(layout.presetId); setEditing(null); setNotice(""); }, [preview, scope.target, scope.project, scope.session]);
  const selected = presets.find(preset => preset.id === selectedId) ?? presets.find(preset => preset.id === layout.presetId) ?? presets[0]!;
  const current = presets.find(preset => preset.id === layout.presetId);
  const projectKey = dockProjectKey(scope);
  const projectDefault = scope.project === null ? "" : preferences.projectDefaults[projectKey] ?? "";
  const options = presets.map(preset => <option key={preset.id} value={preset.id}>{dockPresetName(preset, copy)}</option>);
  const updateProjectDefault = (id: string) => {
    if (scope.project === null) return;
    const projectDefaults = { ...preferences.projectDefaults };
    if (id) projectDefaults[projectKey] = id;
    else delete projectDefaults[projectKey];
    store.updatePreferences({ projectDefaults });
  };
  const currentName = current ? dockPresetName(current, copy) : copy("自定义布局", "Custom layout");
  return <div className="dock-settings" data-dock-settings>
    <SettingSection title={copy("工作台布局", "Workbench layout")} desc={copy("每个会话自动保存自己的布局。预设只保存工具位置与显示偏好，不包含会话或运行资源。", "Each session saves its own layout automatically. Presets contain tool positions and display preferences, not sessions or running resources.")}>
      {preview ? <span className="chip amber xs demo-chip">{copy("演示", "Demo")}</span> : null}
      <SettingRow label={copy("应用默认预设", "Application default preset")} desc={copy("用于未指定项目默认的新会话及无布局记录的会话；不改变当前会话。", "Used for new sessions and sessions without a saved layout when no project default is set. Does not change this session.")} source={preferences.appDefault === "default" ? "default" : "user"}>
        <AppSelect className="select" aria-label={copy("应用默认预设", "Application default preset")} value={preferences.appDefault} onChange={event => store.updatePreferences({ appDefault: event.target.value })}>{options}</AppSelect>
      </SettingRow>
      <SettingRow label={copy("当前项目默认预设", "Current project default preset")} desc={scope.project === null ? copy("当前没有项目。选择项目后可设置；不会改动应用默认。", "No project is selected. Select a project to set its default; the application default is unchanged.") : copy("优先于应用默认；选择跟随应用可移除项目覆盖。", "Takes precedence over the application default. Follow application to remove the project override.")} source={scope.project === null ? "unavailable" : projectDefault ? "project" : "default"} reason={copy("当前没有项目。", "No project is selected.")}>
        <AppSelect className="select" aria-label={copy("当前项目默认预设", "Current project default preset")} disabled={scope.project === null} value={projectDefault} onChange={event => updateProjectDefault(event.target.value)}>
          <option value="">{copy("跟随应用默认", "Follow application default")}</option>{options}
        </AppSelect>
      </SettingRow>
      <SettingRow label={copy("新会话沿用本项目上次布局", "Inherit this project's last layout")} desc={copy("仅复制新会话的起点，之后各会话独立保存；已有会话不受影响。", "Copies a starting layout for new sessions only. Sessions remain independent; existing sessions are unchanged.")} source={preferences.inherit ? "user" : "default"}>
        <Switch label={copy("新会话沿用本项目上次布局", "Inherit this project's last layout")} checked={preferences.inherit} onChange={inherit => store.updatePreferences({ inherit })} />
      </SettingRow>
      <SettingRow label={copy("启用停靠吸附", "Enable dock snapping")} desc={PLATFORM === "darwin" ? copy("拖动时按住 Command 可临时暂停吸附并浮动放置。", "Hold Command while dragging to suspend snapping and float the tool.") : copy("拖动时按住 Ctrl 可临时暂停吸附并浮动放置。", "Hold Ctrl while dragging to suspend snapping and float the tool.")} source={preferences.snap ? "default" : "user"}>
        <Switch label={copy("启用停靠吸附", "Enable dock snapping")} checked={preferences.snap} onChange={snap => store.updatePreferences({ snap })} />
      </SettingRow>
      <SettingRow label={copy("锁定布局", "Lock layout")} desc={copy("禁止移动、分组和调整尺寸；仍可切标签、折叠、隐藏、找回工具及应用预设。", "Prevents moving, grouping and resizing. Switching tabs, collapsing, hiding, restoring tools and applying presets remain available.")} source={preferences.locked ? "user" : "default"}>
        <Switch label={copy("锁定布局", "Lock layout")} checked={preferences.locked} onChange={locked => store.updatePreferences({ locked })} />
      </SettingRow>
      <SettingRow label={copy("对话工具区模式", "Conversation tools mode")} desc={copy("完整卡片列占用宽度；空间不足时临时变为悬浮图标，窗口变宽后恢复。自动紧凑不会覆盖此偏好。", "Full cards use layout width. When space is tight, they temporarily become floating icons and return when space allows. Automatic compacting does not overwrite this preference.")} source={layout.rail.mode === "hidden" ? "default" : "user"}>
        <AppSelect className="select" aria-label={copy("对话工具区模式", "Conversation tools mode")} value={layout.rail.mode} onChange={event => store.dispatch({ type: "railMode", mode: event.target.value as RailMode })}>
          <option value="hidden">{copy("完全隐藏", "Hidden")}</option>
          <option value="expanded">{copy("完整卡片列", "Full cards")}</option>
          <option value="compact">{copy("悬浮图标", "Floating icons")}</option>
        </AppSelect>
      </SettingRow>
      <div className="dock-preset-manager">
        <div className="dock-preset-heading"><strong>{copy("预设管理", "Manage presets")}</strong><span className="dock-current-preset">{copy("当前", "Current")}: {currentName}{modified ? <span className="chip xs">{copy("已修改", "Modified")}</span> : null}</span></div>
        <p className="set-section-desc">{copy("切换或恢复只影响当前会话，可用布局撤销找回。内置预设不可覆盖、重命名或删除。", "Applying or restoring affects this session only and can be undone. Built-in presets cannot be overwritten, renamed or deleted.")}</p>
        <div className="dock-preset-actions">
          <AppSelect className="select" aria-label={copy("管理预设", "Manage preset")} value={selected.id} onChange={event => { setSelectedId(event.target.value); setEditing(null); setNotice(""); }}>{options}</AppSelect>
          <button type="button" className="btn small" onClick={() => { store.applyPreset(selected.id); setNotice(copy("已应用到当前会话。", "Applied to the current session.")); }}>{copy("应用到当前会话", "Apply to this session")}</button>
          <button type="button" className="btn small outline" onClick={() => { setEditing("save"); setNotice(""); }}><Icon name="plus" extra="sm" />{copy("另存为…", "Save as…")}</button>
        </div>
        <div className="dock-preset-actions">
          <button type="button" className="btn small outline" disabled={!!selected.builtin} data-tip={copy("用当前会话的布局覆盖选中的自定义预设。", "Replace the selected custom preset with this session's layout.")} onClick={() => { store.updatePreset(selected.id); setNotice(copy("已用当前布局更新预设。", "Preset updated with the current layout.")); }}>{copy("更新为当前布局", "Update from current layout")}</button>
          <button type="button" className="btn small outline" disabled={!!selected.builtin} onClick={() => { setEditing("rename"); setNotice(""); }}>{copy("重命名…", "Rename…")}</button>
          <button type="button" className="btn small outline" disabled={!!selected.builtin} onClick={() => { setEditing("delete"); setNotice(""); }}>{copy("删除…", "Delete…")}</button>
          <button type="button" className="btn small outline" disabled={scope.project === null || projectDefault === selected.id} data-tip={scope.project === null ? copy("当前没有项目。", "No project is selected.") : undefined} onClick={() => updateProjectDefault(selected.id)}>{copy("设为项目默认", "Use as project default")}</button>
          <button type="button" className="btn small outline" disabled={preferences.appDefault === selected.id} onClick={() => store.updatePreferences({ appDefault: selected.id })}>{copy("设为应用默认", "Use as application default")}</button>
        </div>
        {editing === "save" || (editing === "rename" && !selected.builtin) ? <DockPresetNameForm key={`${editing}-${selected.id}-${preview}`} initialName={editing === "rename" ? selected.name : ""} onSave={name => {
          if (editing === "save") setSelectedId(store.savePreset(name));
          else store.renamePreset(selected.id, name);
          setEditing(null);
          setNotice(copy("预设已保存。", "Preset saved."));
        }} onCancel={() => setEditing(null)} /> : null}
        {editing === "delete" && !selected.builtin ? <div className="dock-preset-delete" role="group" aria-label={copy("删除预设确认", "Confirm preset deletion")}>
          <p>{copy("删除预设", "Delete preset")} “{selected.name}”?</p>
          <p className="set-section-desc">{copy("已有会话布局保留。引用此预设的默认设置将回退到内置默认。", "Existing session layouts are kept. Defaults referencing this preset fall back to the built-in default.")}</p>
          <div className="dock-preset-actions"><button type="button" className="btn small" onClick={() => { store.deletePreset(selected.id); setSelectedId("default"); setEditing(null); setNotice(copy("预设已删除，会话布局保持不变。", "Preset deleted; session layouts are unchanged.")); }}>{copy("删除预设", "Delete preset")}</button><button type="button" className="btn small outline" onClick={() => setEditing(null)}>{copy("取消", "Cancel")}</button></div>
        </div> : null}
        <div className="dock-preset-actions dock-layout-recovery">
          <button type="button" className="btn small outline" onClick={() => { store.resetPreset(); setNotice(copy("已恢复当前预设，可撤销。", "Current preset restored; you can undo this.")); }}>{copy("恢复当前预设", "Restore current preset")}</button>
          <button type="button" className="btn small outline" onClick={() => { store.resetFactory(); setNotice(copy("已恢复出厂布局，可撤销。", "Factory layout restored; you can undo this.")); }}>{copy("恢复出厂布局", "Restore factory layout")}</button>
          <button type="button" className="btn small outline" disabled={!canUndo || preferences.locked} onClick={() => store.undo()}>{copy("撤销布局修改", "Undo layout change")}</button>
          <button type="button" className="btn small outline" disabled={!canRedo || preferences.locked} onClick={() => store.redo()}>{copy("重做布局修改", "Redo layout change")}</button>
        </div>
        {notice ? <p className="dock-settings-notice" role="status">{notice}</p> : null}
      </div>
      <div className="dock-layout-help">
        <strong>{copy("操作与快捷键", "Controls and shortcuts")}</strong>
        <p>{copy("卡片、标签和组的更多菜单提供移动、排序、拆分、合并和隐藏操作，无需拖动。隐藏工具不会结束任务；用“添加工具”或视图菜单找回。", "Card, tab and group More menus offer moving, reordering, splitting, merging and hiding without dragging. Hiding a tool does not stop its tasks; restore it from Add tool or View.")}</p>
        <dl>
          <div><dt>{copy("左侧栏", "Left sidebar")}</dt><dd><kbd>{formatShortcut({ key: "B" }, "hint")}</kbd></dd></div>
          <div><dt>{copy("底栏", "Bottom bar")}</dt><dd><kbd>{formatShortcut({ key: "J" }, "hint")}</kbd></dd></div>
          <div><dt>{copy("对话工具区", "Conversation tools")}</dt><dd><kbd>{formatShortcut({ key: "L", shift: true }, "hint")}</kbd></dd></div>
          <div><dt>{copy("下一个／上一个区域", "Next / previous region")}</dt><dd><kbd>F6 / Shift+F6</kbd></dd></div>
          <div><dt>{copy("取消拖动／收起覆盖层", "Cancel drag / close overlay")}</dt><dd><kbd>Esc</kbd></dd></div>
        </dl>
        <p>{copy("布局撤销只在布局菜单中执行，不占用编辑器或终端的文本撤销快捷键。", "Use the layout menu for layout undo; editor and terminal text-undo shortcuts are unchanged.")}</p>
      </div>
    </SettingSection>
  </div>;
}
