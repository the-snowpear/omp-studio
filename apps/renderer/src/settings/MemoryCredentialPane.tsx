import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { SettingRow, SettingSection } from "./SettingRow";
import type { RuntimeSettingsCtl } from "./tabs";
import type { StudioClient, StudioRuntimeSettingsGetResult } from "@omp-studio/client-contract";
import { waitReceipt } from "../hostError";

export function MemoryCredentialPane({ runtime, targetId, client, inspect = false }: { runtime?: RuntimeSettingsCtl | undefined; targetId: string | null; client?: StudioClient | undefined; inspect?: boolean | undefined }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview, marks } = usePreviewMode();
  const backend = preview ? runtime?.previewValues?.["memory.backend"] ?? "off" : runtime?.snapshot?.["memory.backend"];
  const url = preview ? runtime?.previewValues?.["hindsight.apiUrl"] ?? "http://localhost:8888" : runtime?.snapshot?.["hindsight.apiUrl"];
  const [configured, setConfigured] = useState(false);
  const [syncSupported, setSyncSupported] = useState(true);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [serviceStatus, setServiceStatus] = useState<StudioRuntimeSettingsGetResult["hindsightStatus"]>();
  const generation = useRef(0);
  const api = globalThis.ompStudioChrome;

  useEffect(() => {
    generation.current++; setToken(""); setConfigured(false); setSyncSupported(true); setMessage(""); setPending(false); setServiceStatus(undefined);
    if (preview || (backend !== "hindsight" && !inspect) || typeof url !== "string" || !api?.memoryCredentialStatus) return;
    let active = true;
    void api.memoryCredentialStatus({ targetId, url }).then(result => {
      if (!active) return;
      if (result.ok) { setConfigured(result.configured); setSyncSupported(result.syncSupported); } else setMessage(result.message);
    }).catch(() => { if (active) setMessage(zh ? "无法读取加密存储状态。" : "Cannot read secure storage status."); });
    return () => { active = false; };
  }, [api, backend, inspect, preview, targetId, url, zh]);

  if (backend !== "hindsight" && !inspect) return null;
  const available = preview || typeof url === "string" && !!api?.memoryCredentialStatus && !!api.setMemoryCredential && !!api.removeMemoryCredential;
  const label = zh ? "Hindsight 令牌" : "Hindsight token";
  const credentialSource = runtime?.activation?.hindsightCredential?.source;
  const sourceLabels = { env: ["环境变量", "environment"], runtime: ["运行时", "runtime"], overlay: ["配置覆盖", "overlay"], project: ["项目配置", "project"], global: ["用户配置", "user configuration"], default: ["默认值", "default"] } as const;
  const statusText = serviceStatus === "ready" ? (zh ? "服务连接正常" : "Service connected") : serviceStatus === "authentication-failed" ? (zh ? "服务拒绝认证，请检查令牌。" : "Authentication failed; check the token.") : serviceStatus === "not-found" ? (zh ? "服务已响应，但未找到记忆库或 API。" : "Service responded, but the bank or API was not found.") : serviceStatus === "inactive" ? (zh ? "Hindsight 尚未启用。" : "Hindsight is not active.") : serviceStatus === "unavailable" ? (zh ? "无法连接服务或记忆后端尚未启动。" : "The service is unreachable or the backend has not started.") : (zh ? "尚未检查服务连接。" : "Service connection has not been checked.");
  const check = async () => {
    if (preview) { setServiceStatus("ready"); return; }
    if (!client) return;
    const current = generation.current;
    setPending(true); setServiceStatus(undefined);
    try {
      const handle = await client.command("runtime.settings.get", { keys: ["hindsight.apiUrl"], checkHindsight: true });
      const result = await waitReceipt<StudioRuntimeSettingsGetResult>(client, handle.requestId, 12000);
      if (current === generation.current) setServiceStatus(result.hindsightStatus ?? "unavailable");
    } catch { if (current === generation.current) setServiceStatus("unavailable"); }
    finally { if (current === generation.current) setPending(false); }
  };
  const change = async (remove: boolean) => {
    if (preview) { setConfigured(!remove); setToken(""); setMessage(marks ? (zh ? "演示设置已更新。" : "Demo setting updated.") : ""); return; }
    if (typeof url !== "string" || !api?.setMemoryCredential || !api.removeMemoryCredential) return;
    const current = generation.current;
    setPending(true); setMessage("");
    try {
      const input = { targetId, url };
      const result = remove ? await api.removeMemoryCredential(input) : await api.setMemoryCredential({ ...input, token });
      if (current !== generation.current) return;
      if (result.ok) {
        setConfigured(result.configured); setSyncSupported(result.syncSupported); setToken("");
        setMessage(zh ? "已更新加密存储；服务连接状态需由 Runtime 确认。" : "Secure storage updated; Runtime determines service connectivity.");
      } else setMessage(result.message);
    } catch { if (current === generation.current) setMessage(zh ? "无法更新加密存储。" : "Cannot update secure storage."); }
    finally { if (current === generation.current) setPending(false); }
  };

  return <SettingSection title={zh ? "Hindsight 凭据" : "Hindsight credentials"}>
    <SettingRow label={label} desc={zh ? "令牌加密保存在本机，按环境和服务地址区分；SSH 令牌经已认证连接临时发送。环境变量和现有 Runtime 配置优先。" : "Tokens are encrypted locally per environment and service URL; SSH credentials are sent temporarily over the authenticated connection. Environment and existing Runtime configuration take precedence."} source={available ? null : "unavailable"} reason={zh ? "此环境不提供桌面加密存储。" : "Desktop secure storage is unavailable in this environment."}>
      <div className="memory-credential-control">
        <span className="small muted">{configured ? (zh ? "已保存令牌" : "Token saved") : (zh ? "未保存令牌" : "No saved token")}</span>
        {!preview && !syncSupported ? <span className="small muted">{zh ? "远端未连接或不支持凭据同步；令牌仅保存在本机。" : "The remote host is disconnected or cannot sync credentials; the token is saved locally only."}</span> : null}
        {!preview && runtime?.activation?.hindsightCredential ? <span className="small muted">{runtime.activation.hindsightCredential.configured && credentialSource ? (zh ? `Runtime 已配置凭据（来源：${sourceLabels[credentialSource][0]}）` : `Runtime credential configured (${sourceLabels[credentialSource][1]})`) : (zh ? "Runtime 未配置凭据（服务可能不要求令牌）" : "No Runtime credential configured (the service may not require one)")}</span> : null}
        <input className="input" type="password" autoComplete="new-password" aria-label={label} value={token} disabled={!available || pending} onChange={event => setToken(event.target.value)} />
        <div className="memory-credential-actions">
          <button type="button" className="btn small" disabled={!available || pending || !token} onClick={() => void change(false)}>{zh ? "保存令牌" : "Save token"}</button>
          <button type="button" className="btn small outline" disabled={!available || pending || !configured} onClick={() => void change(true)}>{zh ? "删除令牌" : "Remove token"}</button>
          <button type="button" className="btn small outline" disabled={pending || backend !== "hindsight" || (!preview && !client)} onClick={() => void check()}>{zh ? "检查服务" : "Check service"}</button>
        </div>
        <span role="status" className="small muted">{statusText}</span>
        {message ? <span role="status" className="small">{message}</span> : null}
      </div>
    </SettingRow>
  </SettingSection>;
}
