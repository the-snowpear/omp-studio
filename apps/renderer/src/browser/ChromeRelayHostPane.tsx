import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { ChromeRelayEndpointOutcome, ChromeRelayHostOperation, ChromeRelayHostStatus } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { useSurfaceChrome } from "../dock/SurfaceContext";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { getPreviewChromeRelay } from "../preview/chromeRelayPreview";
import { Callout, StatePill, type StateTone as Tone } from "../workspaces/StatusBits";
import type { Copy } from "./BrowserToolbar";
import "./chromeRelayHost.css";

type Action = "install" | "sync" | "repair" | "uninstall";
const endpointLabel = (outcome: ChromeRelayEndpointOutcome, copy: Copy) => ({
  ready: copy("已连接", "Connected"), unreachable: copy("无法连接", "Unreachable"),
  "no-extension": copy("等待扩展连接", "Waiting for extension"), "outdated-relay": copy("Relay 需要更新", "Relay needs an update"),
  "idle-older-relay": copy("旧 Relay 空闲中", "Older relay is idle"), "outdated-extension": copy("扩展需要更新", "Extension needs an update"),
})[outcome];
const endpointTone = (outcome: ChromeRelayEndpointOutcome): Tone => outcome === "ready" ? "ready" : outcome === "unreachable" ? "blocked" : outcome === "no-extension" ? "idle" : "warn";

export function ChromeRelayHostPane({ client, sessionId, remote = false, visible, onBack }: {
  client?: StudioClient | undefined; sessionId?: string | undefined; remote?: boolean | undefined; visible: boolean; onBack(): void;
}) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const copy: Copy = (chinese, english) => zh ? chinese : english;
  const chrome = useSurfaceChrome()?.managedBrowser;
  const [status, setStatus] = useState<ChromeRelayHostStatus>();
  const [browser, setBrowser] = useState("");
  const [profile, setProfile] = useState("");
  const [registerProfile, setRegisterProfile] = useState(false);
  const [removeProfiles, setRemoveProfiles] = useState(false);
  const [removeFiles, setRemoveFiles] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [busy, setBusy] = useState<Action | "read" | "open" | null>(null);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [completed, setCompleted] = useState<Action>();
  const [revision, refresh] = useState(0);
  const [demoInstalled, setDemoInstalled] = useState(true);
  const epoch = useRef(0);
  const operationScope = useRef(0);
  const canManage = preview || !!client && !!sessionId;
  useEffect(() => { setStatus(undefined); setBusy(null); setCompleted(undefined); setWarnings([]); return () => { operationScope.current++; }; }, [client, sessionId, preview]);

  useEffect(() => {
    const request = ++epoch.current;
    setError("");
    if (!visible) return;
    if (preview) { setStatus(getPreviewChromeRelay(zh, demoInstalled)); return; }
    if (!client || !sessionId) { setStatus(undefined); return; }
    setBusy(current => current ?? "read");
    void client.query("browser.relayHost.status", { sessionId }).then(value => {
      if (request === epoch.current) setStatus(value);
    }).catch(cause => { if (request === epoch.current) setError(hostErrorMessage(cause, zh ? "无法读取扩展状态" : "Cannot read extension status")); })
      .finally(() => { if (request === epoch.current) setBusy(current => current === "read" ? null : current); });
    return () => { epoch.current++; };
  }, [client, sessionId, visible, preview, revision, zh, demoInstalled]);

  const currentBrowser = browser || status?.browsers[0]?.name || "";
  const profiles = status?.profiles.filter(row => row.browser === currentBrowser) ?? [];
  const currentProfile = profile || status?.browsers.find(row => row.name === currentBrowser)?.lastUsedProfile || profiles[0]?.profileDir || "";
  const installed = status?.installs.some(row => row.exists) ?? false;
  const directory = status?.installs.find(row => row.exists)?.dir ?? status?.defaultExtensionDir;
  const actionNames: Record<Action, string> = { install: copy("安装扩展与 Native Host", "Install extension and native host"), sync: copy("同步更新", "Sync updates"), repair: copy("修复注册", "Repair registration"), uninstall: copy("卸载 Native Host", "Uninstall native host") };

  const run = async (action: Action) => {
    if (busy || !canManage) return;
    const request = operationScope.current;
    epoch.current++;
    setBusy(action); setError(""); setWarnings([]); setCompleted(undefined);
    try {
      if (preview) { setDemoInstalled(action !== "uninstall"); setCompleted(action); setConfirmUninstall(false); return; }
      if (!client || !sessionId) return;
      const selection = { ...(currentBrowser ? { browser: currentBrowser } : {}), ...(currentProfile ? { profile: currentProfile } : {}) };
      const operation: Exclude<ChromeRelayHostOperation, { kind: "browser.relayHost.status" }> = action === "install" ? { kind: "browser.relayHost.install", sessionId, ...selection, registerChrome: registerProfile }
        : action === "repair" ? { kind: "browser.relayHost.repair", sessionId, ...selection, repairProfile: registerProfile, installIfMissing: true }
        : action === "uninstall" ? { kind: "browser.relayHost.uninstall", sessionId, removeProfileRegistrations: removeProfiles, removeExtensionFiles: removeFiles }
        : { kind: "browser.relayHost.sync", sessionId, restartOutdatedRelay: true };
      const { kind, ...input } = operation;
      const handle = await client.command(kind, input);
      const { result } = await waitReceipt<{ result: { status: ChromeRelayHostStatus; warnings: string[] } }>(client, handle.requestId, 120000);
      if (request === operationScope.current) { setStatus(result.status); setWarnings(result.warnings); setCompleted(action); setConfirmUninstall(false); refresh(value => value + 1); }
    } catch (cause) { if (request === operationScope.current) setError(hostErrorMessage(cause, copy("扩展操作失败", "Extension operation failed"))); }
    finally { if (request === operationScope.current) setBusy(null); }
  };
  const openDirectory = async () => {
    if (preview || remote || !directory || !chrome?.openRelayExtensionDirectory) return;
    setBusy("open"); setError("");
    try { await chrome.openRelayExtensionDirectory(directory); }
    catch (cause) { setError(hostErrorMessage(cause, copy("无法打开扩展目录", "Cannot open the extension directory"))); }
    finally { setBusy(null); }
  };

  const upToDate = installed && (status?.installs.every(row => !row.exists || row.upToDate) ?? false);
  const steps: Array<{ key: string; label: string; value: string; tone: Tone }> = status ? [
    { key: "files", label: copy("扩展文件", "Extension files"), value: installed ? upToDate ? copy("已是最新", "Up to date") : copy("可更新", "Update available") : copy("未安装", "Not installed"), tone: installed ? upToDate ? "ready" : "warn" : "idle" },
    { key: "host", label: "Native Host", value: status.nativeHost.registered ? copy("已注册", "Registered") : copy("未注册", "Not registered"), tone: status.nativeHost.registered ? "ready" : status.policy.nativeHostBlocked ? "blocked" : "idle" },
    { key: "link", label: copy("连接", "Connection"), value: status.health.ready ? copy("已连接", "Connected") : copy("等待浏览器", "Waiting for browser"), tone: status.health.ready ? "ready" : "idle" },
  ] : [];
  const overall: { tone: Tone; label: string } | undefined = !status ? undefined
    : status.policy.blocked ? { tone: "blocked", label: copy("需要处理", "Needs attention") }
    : steps.every(step => step.tone === "ready") ? { tone: "ready", label: copy("可以使用", "Ready to use") }
    : !installed && !status.nativeHost.registered ? { tone: "idle", label: copy("尚未设置", "Not set up") }
    : { tone: "warn", label: copy("设置未完成", "Setup incomplete") };
  const policy: { tone: Tone; label: string } | undefined = status ? status.policy.blocked ? { tone: "blocked", label: copy("被策略阻止", "Blocked by policy") }
    : status.policy.checked ? { tone: "ready", label: copy("未发现拒绝策略", "No blocking policy found") }
    : { tone: "idle", label: copy("策略检查未完成", "Policy check incomplete") } : undefined;
  const installLabel = installed ? registerProfile ? copy("安装到所选 Profile", "Install to selected profile") : copy("重新安装文件", "Reinstall files") : copy("安装", "Install");
  const notes = status ? [...warnings, ...status.policy.warnings] : [];

  return <div className="mb-view cr-host" aria-busy={!!busy}>
    <header className="mb-view-header cr-header">
      <button type="button" className="icon-btn" aria-label={copy("返回浏览器", "Back to browser")} onClick={onBack}><Icon name="arrow-l" extra="sm" /></button>
      <h2>{copy("Chrome 扩展", "Chrome extension")}</h2>
      {preview && marks ? <span className="chip gray xs">{copy("演示", "Demo")}</span> : null}
      <button type="button" className="btn small ghost cr-header-refresh" disabled={!!busy || !canManage} onClick={() => refresh(value => value + 1)}>
        {busy === "read" ? <i className="mb-spinner" aria-hidden /> : <Icon name="refresh" extra="sm" />}{copy("检查状态", "Check status")}
      </button>
    </header>
    <div className="mb-view-body cr-body">
      <section className="cr-hero" data-tone={overall?.tone}>
        <span className="cr-hero-mark" aria-hidden><Icon name="globe" /></span>
        <div className="cr-hero-copy">
          <div className="cr-hero-title"><h3>{copy("连接常用浏览器", "Connect your browser")}</h3>{overall ? <StatePill tone={overall.tone}>{overall.label}</StatePill> : null}</div>
          <p>{copy("通过 Chrome 扩展连接现有标签、登录状态和 Profile。", "Connect existing tabs, sign-ins and profiles through the Chrome extension.")}</p>
        </div>
        {steps.length ? <ol className="cr-steps" aria-label={copy("连接步骤", "Connection steps")}>
          {steps.map((step, index) => <li key={step.key} data-tone={step.tone}>
            <span className="cr-step-mark" aria-hidden>{step.tone === "ready" ? <Icon name="check" extra="sm" /> : step.tone === "blocked" ? <Icon name="x" extra="sm" /> : index + 1}</span>
            <span className="cr-step-copy"><small>{step.label}</small><strong>{step.value}</strong></span>
          </li>)}
        </ol> : null}
      </section>

      {!canManage ? <Callout tone="info" icon="plug">{copy("请连接支持 Chrome 扩展管理的 Runtime，并选择一个对话。", "Connect a Runtime with Chrome extension management and select a chat.")}</Callout> : null}
      {error ? <Callout tone="error" icon="alert-c" role="alert">{error}</Callout> : null}
      {busy && busy !== "read" ? <p className="cr-progress" role="status"><i className="mb-spinner" />{busy === "open" ? copy("正在打开目录…", "Opening directory…") : `${actionNames[busy]}…`}</p>
        : busy === "read" && !status ? <p className="cr-progress" role="status"><i className="mb-spinner" />{copy("正在检查安装与连接…", "Checking installation and connection…")}</p> : null}
      {completed && !busy ? <Callout tone="success" icon="check">{copy("操作已完成", "Operation complete")} · {actionNames[completed]}</Callout> : null}

      {status ? <>
        <section className="cr-card" aria-labelledby="cr-install-title">
          <header className="cr-card-head"><h3 id="cr-install-title">{copy("安装与维护", "Installation")}</h3><span className="cr-meta">OMP {status.ompVersion}</span></header>
          <div className="cr-selection">
            <label><span>{copy("浏览器", "Browser")}</span><AppSelect value={currentBrowser} aria-label={copy("浏览器", "Browser")} disabled={!status.browsers.length || !!busy} onChange={event => { setBrowser(event.target.value); setProfile(""); }}><option value="">{copy("自动选择", "Automatic")}</option>{status.browsers.map(row => <option key={row.name} value={row.name}>{row.name}</option>)}</AppSelect></label>
            <label><span>Profile</span><AppSelect value={currentProfile} aria-label="Profile" disabled={!profiles.length || !!busy} onChange={event => setProfile(event.target.value)}><option value="">{copy("最近使用", "Last used")}</option>{profiles.map(row => <option key={row.profileDir} value={row.profileDir}>{row.profile} · {row.profileDir}</option>)}</AppSelect></label>
          </div>
          <label className="cr-check"><input type="checkbox" checked={registerProfile} disabled={!!busy || !status.browsers.length} onChange={event => setRegisterProfile(event.target.checked)} /><span>{copy("同时注册到所选 Profile（会重启该浏览器）", "Also register in the selected profile (restarts that browser)")}</span></label>
          <div className="cr-actions">
            <button type="button" className="btn small primary" disabled={!!busy} onClick={() => void run("install")}><Icon name="download" extra="sm" />{installLabel}</button>
            <button type="button" className="btn small outline" disabled={!!busy || !installed} onClick={() => void run("sync")}><Icon name="refresh" extra="sm" />{actionNames.sync}</button>
            <button type="button" className="btn small ghost" disabled={!!busy} onClick={() => void run("repair")}><Icon name="wrench" extra="sm" />{actionNames.repair}</button>
          </div>
          <div className="cr-directory">
            <Icon name="folder" extra="sm" />
            <code title={directory}>{directory}</code>
            <button type="button" className="icon-btn" disabled={!installed || !!busy || !preview && (remote || !chrome?.openRelayExtensionDirectory)} aria-label={copy("打开扩展目录", "Open extension directory")} data-tip={copy("打开扩展目录", "Open extension directory")} onClick={() => void openDirectory()}><Icon name="external" extra="sm" /></button>
          </div>
          {!preview && remote ? <p className="cr-help">{copy("此目录位于远端 Runtime，无法在本机文件管理器打开。", "This directory belongs to the remote Runtime and cannot be opened in the local file manager.")}</p> : null}
          <p className="cr-help">{copy("也可在 chrome://extensions 开启开发者模式，选择“加载已解压的扩展程序”，然后选取上方目录。", "You can also enable Developer mode at chrome://extensions, choose Load unpacked, then select the directory above.")}</p>
        </section>

        <section className="cr-card" aria-labelledby="cr-profiles-title">
          <header className="cr-card-head"><h3 id="cr-profiles-title">{copy("已发现的 Profile", "Discovered profiles")}</h3><span className="cr-count">{status.profiles.length}</span></header>
          {status.profiles.length ? <ul className="cr-list">{status.profiles.map(row => {
            const tone: Tone = row.enabled ? "ready" : row.disabled ? "warn" : "idle";
            return <li key={`${row.browser}:${row.profileDir}`}>
              <span className="cr-avatar" aria-hidden>{row.profile.slice(0, 1).toUpperCase()}</span>
              <span className="cr-list-copy"><strong>{row.profile}</strong><small>{row.browser} · {row.profileDir}</small></span>
              <StatePill tone={tone}>{row.enabled ? copy("已启用", "Enabled") : row.disabled ? copy("已禁用", "Disabled") : copy("未加载", "Not loaded")}</StatePill>
            </li>;
          })}</ul> : <p className="cr-empty">{copy("尚未发现浏览器 Profile。首次运行 Chrome 后再检查。", "No browser profiles found. Launch Chrome once, then check again.")}</p>}
        </section>

        <section className="cr-card" aria-labelledby="cr-policy-title">
          <header className="cr-card-head"><h3 id="cr-policy-title">{copy("连接与策略", "Connection and policy")}</h3>{policy ? <StatePill tone={policy.tone}>{policy.label}</StatePill> : null}</header>
          {status.policy.denials.map((denial, index) => <Callout tone="error" icon="shield" key={`${denial.source}:${denial.policy}:${index}`}><strong>{denial.browser} · {denial.policy}</strong><p>{denial.reason}</p><code>{denial.source}</code></Callout>)}
          {status.health.endpoints.length ? <ul className="cr-list cr-endpoints">{status.health.endpoints.map(endpoint => <li key={endpoint.url}>
            <span className="cr-endpoint-icon" aria-hidden><Icon name="network" extra="sm" /></span>
            <span className="cr-list-copy"><code>{endpoint.url}</code>{endpoint.notice ? <small>{endpoint.notice}</small> : null}</span>
            <StatePill tone={endpointTone(endpoint.outcome)}>{endpointLabel(endpoint.outcome, copy)}</StatePill>
          </li>)}</ul> : <p className="cr-empty">{copy("打开已加载扩展的 Chrome，连接后这里会显示 Relay 地址。", "Open Chrome with the extension loaded. Its relay address appears here when it connects.")}</p>}
          <details className="cr-diagnostics">
            <summary><Icon name="chevron-r" extra="sm" />{copy("检测明细", "Diagnostic details")}</summary>
            <dl>
              <div><dt>{copy("启动文件", "Launcher")}</dt><dd><code>{status.nativeHost.launcherPath}</code></dd></div>
              {status.nativeHost.manifests.map(row => <div key={row.path}><dt data-tone={row.valid ? "ready" : "warn"}>{row.valid ? copy("清单有效", "Manifest valid") : copy("清单待修复", "Manifest needs repair")}</dt><dd><code>{row.path}</code>{row.error ? <p>{row.error}</p> : null}</dd></div>)}
              {status.nativeHost.windowsRegistry.map(row => <div key={row.key}><dt data-tone={row.matchesManifest ? "ready" : "warn"}>{row.browser} · {row.matchesManifest ? copy("注册有效", "Registered") : copy("未注册", "Not registered")}</dt><dd><code>{row.key}</code>{row.error ? <p>{row.error}</p> : null}</dd></div>)}
            </dl>
          </details>
        </section>

        {notes.map((warning, index) => <Callout tone="info" icon="info" key={index}>{warning}</Callout>)}

        <section className="cr-card cr-remove" data-open={confirmUninstall || undefined} aria-labelledby="cr-remove-title">
          <div className="cr-remove-row">
            <span className="cr-list-copy"><strong id="cr-remove-title">{copy("移除连接", "Remove connection")}</strong><small>{copy("移除本机 Native Host 注册后，Chrome 将无法再通过此扩展连接 OMP。", "Removing the native host registration disconnects this extension from OMP.")}</small></span>
            <button type="button" className="btn small outline danger" aria-expanded={confirmUninstall} disabled={!!busy || !installed && !status.nativeHost.registered} onClick={() => setConfirmUninstall(value => !value)}>{actionNames.uninstall}</button>
          </div>
          {confirmUninstall ? <div className="cr-remove-options">
            <label className="cr-check"><input type="checkbox" checked={removeProfiles} onChange={event => setRemoveProfiles(event.target.checked)} /><span>{copy("同时移除 Profile 扩展记录（会重启浏览器）", "Also remove profile extension records (restarts browsers)")}</span></label>
            <label className="cr-check"><input type="checkbox" checked={removeFiles} onChange={event => setRemoveFiles(event.target.checked)} /><span>{copy("同时移除扩展文件", "Also remove extension files")}</span></label>
            <div className="cr-actions"><button type="button" className="btn small danger solid" disabled={!!busy} onClick={() => void run("uninstall")}>{copy("确认卸载", "Confirm uninstall")}</button><button type="button" className="btn small ghost" onClick={() => setConfirmUninstall(false)}>{copy("取消", "Cancel")}</button></div>
          </div> : null}
        </section>
      </> : null}
    </div>
  </div>;
}
