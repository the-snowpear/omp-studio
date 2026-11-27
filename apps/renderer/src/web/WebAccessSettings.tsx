import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { SettingRow, SettingSection, Switch } from "../settings/SettingRow";
import { useWebAccessUi } from "./WebAccessContext";

export function WebAccessSettings() {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview } = usePreviewMode();
  const { visible, setVisible, setOpen, position, setPosition } = useWebAccessUi();
  const available = preview || Boolean(globalThis.ompStudioWebAccess);
  const reason = zh ? "连接共享 Host 后可用。" : "Available when connected to a shared Host.";
  return <SettingSection title={zh ? "Web 访问" : "Web access"}>
    <SettingRow
      label={zh ? "设备与控制权" : "Devices and control"}
      desc={zh ? "管理配对设备、局域网访问和当前控制权。隐藏控制条后仍可从这里打开。" : "Manage paired devices, LAN access and control. This entry remains available when the control bar is hidden."}
      source={available ? null : "unavailable"}
      {...(!available ? { reason } : {})}
    >
      <button type="button" className="btn small outline" disabled={!available} onClick={() => setOpen(true)}>{zh ? "管理 Web 访问" : "Manage Web access"}</button>
    </SettingRow>
    <SettingRow
      label={zh ? "显示 Web 控制条" : "Show Web control bar"}
      desc={zh ? "默认停靠在工作台下方。拖动手柄可自由移动，位置保存在当前设备。" : "Docked below the workbench by default. Drag the handle to move it; the position is saved on this device."}
      source={visible ? "user" : "default"}
    >
      <Switch label={zh ? "显示 Web 控制条" : "Show Web control bar"} checked={visible} disabled={!available} onChange={setVisible} />
    </SettingRow>
    {position && <SettingRow label={zh ? "控制条位置" : "Control bar position"} desc={zh ? "回到底部后，控制条为审批和输入区保留独立空间。" : "Dock at the bottom to reserve space for approvals and message input."}>
      <button type="button" className="btn small outline" onClick={() => setPosition(null)}>{zh ? "回到底部" : "Dock at bottom"}</button>
    </SettingRow>}
  </SettingSection>;
}
