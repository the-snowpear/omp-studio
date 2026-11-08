import { previewOfficeState, subscribePreviewOffice, setPreviewOfficeInstalled } from "../preview/filesPreview";
import { useEffect, useState } from "react";
import { AppSelect } from "../AppSelect";
import { SettingRow, SettingSection } from "../settings/SettingRow";
import { usePreviewMode } from "../preview/PreviewContext";
import { readFileScope, saveFileScope, type FileScope } from "./filePreferences";
import type { OfficeComponentState } from "../../../desktop/src/file-viewer-shared";

export function FileViewerSettings() {
  const { preview } = usePreviewMode(); const [scope, setScope] = useState(() => readFileScope(preview));
  useEffect(() => setScope(readFileScope(preview)), [preview]);
  return <SettingSection title="文件查看器"><SettingRow label="文件窗口默认归属" desc="适用于之后打开的文件。已有窗口可通过 Pin 菜单调整归属。" source="user"><AppSelect aria-label="文件窗口默认归属" value={scope} onChange={event => { const value = event.target.value as FileScope; setScope(value); saveFileScope(value, preview); }}><option value="conversation">跟随来源对话</option><option value="workspace">工作区共享</option></AppSelect></SettingRow><SettingRow label="保存方式" desc="Ctrl / Cmd + S 手动保存。磁盘文件被 Agent 或其他程序修改时提示处理冲突。" source="default"><span>手动保存</span></SettingRow></SettingSection>;
}
export function OfficeComponentSettings() {
  const { preview, marks } = usePreviewMode();
  const [state, setState] = useState<OfficeComponentState>({ id: "office-preview", status: "not-installed" });
  const api = globalThis.ompStudioChrome?.files;
  const [error, setError] = useState("");
  useEffect(() => {
    if (preview) { setState(previewOfficeState()); return subscribePreviewOffice(() => setState(previewOfficeState())); }
    if (!api) return;
    let active = true;
    void api.officeState().then(value => { if (active) setState(value); }).catch(error => { if (active) setError(String(error)); });
    const off = api.onOfficeState(setState); return () => { active = false; off(); };
  }, [preview, api]);
  const run = async (action: "check" | "install" | "uninstall" | "cancel") => {
    setError("");
    if (preview) { if (action === "install") setPreviewOfficeInstalled(true); else if (action === "uninstall") setPreviewOfficeInstalled(false); setState(previewOfficeState()); return; }
    try { const next = action === "check" ? await api?.officeState(true) : action === "install" ? await api?.officeInstall() : action === "uninstall" ? await api?.officeUninstall() : await api?.officeCancel(); if (next) setState(next); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  const busy = ["checking", "downloading", "installing"].includes(state.status);
  const available = preview || !!api;
  return <SettingSection title={`可选组件${preview && marks ? " · 演示" : ""}`}><SettingRow label="Office 文档预览" desc="通过 LibreOffice 在本机预览 Word、PowerPoint、ODT、ODP 和 RTF。默认不安装、不随主程序打包；Excel / CSV 已内置支持。" source={available ? "user" : "unavailable"} {...(!available ? { reason: "仅桌面端可安装" } : {})}>
    <div className="file-component-controls"><span>{state.installedVersion ? `已安装 ${state.installedVersion}` : "未安装"}{state.availableVersion && state.availableVersion !== state.installedVersion ? ` · 可用版本 ${state.availableVersion}` : ""}</span>{state.downloadBytes ? <small>{(state.downloadBytes / 1024 / 1024).toFixed(0)} MiB 下载</small> : null}
      {state.status === "downloading" ? <progress max={state.downloadBytes} value={state.receivedBytes ?? 0} /> : null}<div>
        <button className="btn small outline" disabled={!available || busy} onClick={() => { void run("check"); }}>检查组件版本</button>
        <button className="btn small primary" disabled={!available || busy} onClick={() => { void run("install"); }}>{state.status === "installing" ? "正在安装…" : state.status === "checking" ? "正在检查…" : state.installedVersion ? "更新组件" : "安装组件"}</button>
        {busy ? <button className="btn small outline" onClick={() => { void run("cancel"); }}>取消</button> : state.installedVersion ? <button className="btn small outline" onClick={() => { void run("uninstall"); }}>卸载</button> : null}
      </div>{state.message || error ? <small role="status">{error || state.message}</small> : null}
    </div>
  </SettingRow></SettingSection>;
}
