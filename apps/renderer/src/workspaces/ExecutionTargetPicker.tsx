import "./ssh.css";
import { AppSelect } from "../AppSelect";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PLATFORM } from "../platform";
import { PREVIEW_WSL_DIRECTORY, PREVIEW_WSL_DISTROS, PREVIEW_SSH_TARGETS } from "../preview/fixtures";
import { useExecutionTarget, useTargetMemory } from "./ExecutionTargets";
import { SshPasswordDialog } from "./SshPasswordDialog";
import { SshPreparationDialog } from "./SshPreparationDialog";
import { executionTargetLabel, remoteConnectionPending, remoteStatusLabel } from "./remoteStatus";
import type { RemoteConnectionProfile, RemoteDirectoryList, RemoteNetworkMode } from "../../../desktop/src/remote/shared";

export function ExecutionTargetPicker({ onOpen, otherMenuOpen = false }: { onOpen?(): void; otherMenuOpen?: boolean }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const target = useExecutionTarget();
  const { preview, marks } = usePreviewMode();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(false);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [authMode, setAuthMode] = useState<"agent" | "password">("agent");
  const [port, setPort] = useState("");
  const [editing, setEditing] = useState<string>();
  const [networkMode, setNetworkMode] = useState<RemoteNetworkMode>("remote-first");
  const [installRoot, setInstallRoot] = useState("");
  const [localProxyUrl, setLocalProxyUrl] = useState("");
  const [demoPreparation, setDemoPreparation] = useState<RemoteConnectionProfile>();
  const [busy, setBusy] = useState(false);
  const [connectingId, setConnectingId] = useState<string>();
  const [error, setError] = useState("");
  const [directoryTarget, setDirectoryTarget] = useState<string>();
  const [directories, setDirectories] = useState<RemoteDirectoryList>();
  const [path, setPath] = useState("");
  const [demo, setDemo] = useTargetMemory<{ kind: "ssh" | "wsl"; name: string } | null>("preview-execution-target", () => null);
  const [demoDirectory, setDemoDirectory] = useState(false);
  const [demoPath, setDemoPath] = useState(PREVIEW_WSL_DIRECTORY);
  const [demoPasswordProfile, setDemoPasswordProfile] = useState<RemoteConnectionProfile>();
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false);
  const navigation = useRef(0);
  const modalOpen = form || directoryTarget !== undefined || (preview && demoDirectory);
  const status = target.inventory.statuses.find(value => value.id === target.id);
  const localLabel = zh ? "此计算机" : "This computer";
  const isWsl = preview ? demo?.kind === "wsl" : target.kind === "wsl";
  const label = preview ? demo ? executionTargetLabel(demo.kind, demo.name) : localLabel : target.id ? executionTargetLabel(target.kind, target.name) : localLabel;
  const unavailable = !preview && !target.api;
  const installing = status?.operation === "installing-runtime";

  useEffect(() => { if (modalOpen) dialog.current?.showModal(); else dialog.current?.close(); }, [modalOpen]);
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }, [open]);
  useEffect(() => { if (otherMenuOpen) setOpen(false); }, [otherMenuOpen]);
  const closeMenu = () => { setOpen(false); button.current?.focus(); };
  const closeModal = () => {
    if (busy) return;
    navigation.current++;
    setForm(false); setDemoDirectory(false); setDirectoryTarget(undefined); setDirectories(undefined); setError("");
    button.current?.focus();
  };
  const showError = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (cause) { showError(cause); }
    finally { setBusy(false); }
  };
  const browse = async (id: string, requestedPath?: string) => {
    const sequence = ++navigation.current;
    const value = await target.api!.directories(id, requestedPath);
    if (sequence === navigation.current) { setDirectories(value); setPath(value.path); }
  };
  const openDirectory = (id: string) => {
    const recent = target.inventory.profiles.find(profile => profile.id === id)?.lastDirectory;
    setOpen(false); setDirectoryTarget(id); setDirectories(undefined); setPath(recent ?? "");
    void run(() => browse(id, recent));
  };
  const choose = (requested: string | null, kind: "ssh" | "wsl" = "ssh") => {
    closeMenu();
    if (preview) { setDemo(requested ? { kind, name: requested } : null); return; }
    if (!target.api) return;
    cancelled.current = false;
    void run(async () => {
      const id = kind === "wsl" && requested ? (await target.api!.ensureWsl!(requested)).id : requested;
      if (id === null) { await target.select(null); return; }
      if (target.inventory.statuses.find(value => value.id === id)?.state !== "connected") {
        setConnectingId(id);
        try { await target.connect(id); } finally { setConnectingId(undefined); }
      }
      if (cancelled.current) return;
      await target.refresh();
      const bootstrap = await target.api!.bootstrap(id);
      if (bootstrap.selected.workspaceId) await target.select(id);
      else { setDirectoryTarget(id); setDirectories(undefined); await browse(id); }
    });
  };
  const requested = useRef(target.directoryRequest);
  useEffect(() => {
    if (target.directoryRequest === requested.current || !target.id || preview) return;
    requested.current = target.directoryRequest;
    openDirectory(target.id);
  }, [target.directoryRequest, target.id, preview]);

  const edit = (profile?: RemoteConnectionProfile) => {
    closeMenu(); setEditing(profile?.id); setName(profile?.name ?? "");
    setHost(profile?.host ?? ""); setUser(profile?.user ?? "");
    setAuthMode(profile?.authMode ?? "agent");
    setPort(profile?.port ? String(profile.port) : ""); setNetworkMode(profile?.networkMode ?? "remote-first"); setInstallRoot(profile?.installRoot ?? ""); setLocalProxyUrl(profile?.localProxyUrl ?? "");
    setError(""); setForm(true);
  };
  const save = () => void run(async () => {
    if (preview) {
      setForm(false);
      const profile = { id: "demo-password", name: name || host, host, user, platform: "linux" as const, authMode };
      if (authMode === "password") setDemoPasswordProfile(profile);
      else setDemoPreparation(profile);
      return;
    }
    const saved = await target.api!.save({ ...(editing ? { id: editing } : {}), name: name.trim() || host.trim(), host: host.trim(), authMode, networkMode, ...(installRoot.trim() ? { installRoot: installRoot.trim() } : {}), ...(localProxyUrl.trim() ? { localProxyUrl: localProxyUrl.trim() } : {}), ...(user.trim() ? { user: user.trim() } : {}), ...(port ? { port: Number(port) } : {}) });
    await target.refresh();
    setForm(false); setEditing(undefined); button.current?.focus();
    setConnectingId(saved.id);
    try {
      await target.connect(saved.id); await target.refresh();
      const bootstrap = await target.api!.bootstrap(saved.id);
      if (bootstrap.selected.workspaceId) await target.select(saved.id);
      else { setDirectoryTarget(saved.id); await browse(saved.id, saved.lastDirectory); }
    } finally { setConnectingId(undefined); }
  });
  const profiles = preview ? PREVIEW_SSH_TARGETS : target.inventory.profiles.filter(profile => profile.kind !== "wsl");
  const wsl = preview ? { available: true, distributions: PREVIEW_WSL_DISTROS } : target.wsl;
  const looking = !preview && PLATFORM === "win32" && !!target.api?.wslDistributions && !wsl;
  const missing = preview || !wsl?.available ? [] : target.inventory.profiles.filter(profile => profile.kind === "wsl" && !wsl.distributions.some(item => item.name === profile.distro));
  const wslHelp = zh ? "默认使用 WSL 网络，失败时经本机联网。模型配置从本机同步；文件、Git 和终端在 WSL 中运行。断开后发行版可能因空闲而停止，未完成的任务会中断。" : "Uses the WSL network first and falls back through this computer. Model config syncs from this computer; files, Git, and terminals run in WSL. After disconnecting, the distribution may stop when idle and interrupt unfinished tasks.";
  const directoryProfile = target.inventory.profiles.find(item => item.id === directoryTarget);
  const wslDirectory = (preview && demoDirectory) || directoryProfile?.kind === "wsl";
  const directoryName = preview && demoDirectory ? demo?.name : directoryProfile?.name;
  const displayError = error || target.inventoryError;

  return <span className="execution-picker">
    <button ref={button} type="button" className="ctx-item ctx-project-switch" aria-label={`${zh ? "工作位置：" : "Execution target: "}${label}${preview && marks ? (zh ? "（演示）" : " (Preview)") : ""}`} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => { onOpen?.(); if (!open) target.refreshWsl(); setOpen(value => !value); setError(""); }}>
      {busy ? <span className="spinner" /> : <Icon name={isWsl ? "layers" : "terminal"} extra="sm" />}
      <span>{label}</span>
      {!preview && target.id && status?.state !== "connected" ? <span className={remoteConnectionPending(status) ? "remote-pending" : "remote-offline"}>{remoteStatusLabel(status, zh)}</span> : null}
      {preview && marks ? <span className="chip xs">{zh ? "演示" : "Preview"}</span> : null}
      <Icon name="chevron-d" extra="sm" />
    </button>
    {connectingId ? <button className="btn small" onClick={() => { cancelled.current = true; void target.cancelConnection(connectingId).catch(showError); }}>{zh ? "取消连接" : "Cancel connection"}</button> : null}
    {open ? <>
      <button className="ctx-project-backdrop" aria-label={zh ? "关闭执行位置菜单" : "Close execution target menu"} onClick={closeMenu} />
      <div ref={menu} className="menu ctx-project-menu execution-menu" role="menu" aria-label={zh ? "工作位置" : "Execution target"} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); closeMenu(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
          const current = items.indexOf(document.activeElement as HTMLElement);
          items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}>
        <div className="menu-label">{zh ? "工作位置" : "Execution target"}</div>
        <button className="execution-menu-row" role="menuitem" onClick={() => choose(null)}><Icon name="folder-open" extra="sm" /><span>{zh ? "此计算机" : "This computer"}</span>{(!preview && !target.id) || (preview && !demo) ? <Icon name="check" extra="sm" /> : null}</button>
        {wsl?.available || looking ? <>
          <div className="menu-label">WSL</div>
          {looking ? <p className="execution-menu-help">{zh ? "正在查找 WSL 发行版…" : "Looking for WSL distributions…"}</p> : null}
          {wsl?.available && !wsl.distributions.length ? <p className="execution-menu-help">{zh ? "未找到 Linux 发行版。可在终端运行 wsl --install 安装。" : "No Linux distributions found. Run wsl --install in a terminal to add one."}</p> : null}
          {wsl?.distributions.map(distro => {
            const profile = target.inventory.profiles.find(item => item.kind === "wsl" && item.distro === distro.name);
            const state = !preview && profile ? target.inventory.statuses.find(item => item.id === profile.id) : undefined;
            const selected = preview ? isWsl && demo?.name === distro.name : profile?.id === target.id;
            const detail = distro.version === 1 ? (zh ? "需要 WSL 2" : "Requires WSL 2")
              : state && state.state !== "disconnected" ? remoteStatusLabel(state, zh)
              : preview && selected ? (zh ? "已连接" : "Connected") : distro.running ? (zh ? "运行中" : "Running") : (zh ? "已停止" : "Stopped");
            return <button key={distro.name} role="menuitem" className="execution-menu-row" disabled={distro.version === 1 || (!preview && !target.api?.ensureWsl)} onClick={() => choose(distro.name, "wsl")}>
              <Icon name="layers" extra="sm" /><span>{distro.name}<small>WSL {distro.version} · {detail}</small></span>{selected ? <Icon name="check" extra="sm" /> : null}
            </button>;
          })}
          {missing.map(profile => <div className="execution-profile" key={profile.id}>
            <button className="execution-menu-row" disabled role="menuitem"><Icon name="layers" extra="sm" /><span>{profile.name}<small>{zh ? "已从 WSL 移除" : "Removed from WSL"}</small></span></button>
            <button className="icon-btn" aria-label={zh ? `移除 ${profile.name}` : `Remove ${profile.name}`} onClick={() => void run(async () => { if (target.id === profile.id) await target.select(null); await target.api!.disconnect(profile.id); await target.api!.remove(profile.id); await target.refresh(); })}><Icon name="x" extra="sm" /></button>
          </div>)}
        </> : null}
        {profiles.length ? <div className="menu-label">SSH</div> : null}
        {profiles.map(profile => {
          const state = target.inventory.statuses.find(value => value.id === profile.id);
          const locked = !preview && (remoteConnectionPending(state) || Boolean(state?.operation));
          const realProfile = !preview ? target.inventory.profiles.find(value => value.id === profile.id) : undefined;
          return <div className="execution-profile" key={profile.id}>
            <button className="execution-menu-row" role="menuitem" disabled={locked} onClick={() => choose(preview ? profile.name : profile.id)}>
              <Icon name="terminal" extra="sm" /><span>{profile.name}<small>{profile.platform === "win32" ? "Windows" : profile.platform === "darwin" ? "macOS" : profile.platform === "linux" ? "Linux" : (zh ? "系统自动识别" : "Auto-detected")}{!preview ? ` · ${remoteStatusLabel(state, zh)}` : ""}</small></span>
              {!preview && target.id === profile.id ? <Icon name="check" extra="sm" /> : null}
            </button>
            {realProfile && target.id !== profile.id && !locked && state?.state !== "connected" ? <button className="icon-btn" aria-label={zh ? `编辑 ${profile.name}` : `Edit ${profile.name}`} onClick={() => edit(realProfile)}><Icon name="settings" extra="sm" /></button> : null}
            {realProfile && target.id !== profile.id && !locked ? <button className="icon-btn" aria-label={zh ? `移除 ${profile.name}` : `Remove ${profile.name}`} onClick={() => void run(async () => { await target.api!.disconnect(profile.id); await target.api!.remove(profile.id); await target.refresh(); })}><Icon name="x" extra="sm" /></button> : null}
          </div>;
        })}
        <div className="menu-sep" />
        <button className="execution-menu-row" role="menuitem" disabled={unavailable} onClick={() => edit()}><Icon name="plus" extra="sm" /><span>{zh ? "添加 SSH 连接" : "Add SSH connection"}</span></button>
        {(preview ? isWsl : target.id) ? <>
          <button className="execution-menu-row" role="menuitem" disabled={!preview && (status?.state !== "connected" || installing)} onClick={() => { if (preview) { closeMenu(); setDemoDirectory(true); setPath(demoPath); } else openDirectory(target.id!); }}><Icon name="folder-open" extra="sm" /><span>{isWsl ? (zh ? "选择 WSL 目录" : "Select WSL directory") : zh ? "选择远端目录" : "Select remote directory"}</span></button>
          <button className="execution-menu-row" role="menuitem" disabled={installing} onClick={() => { closeMenu(); if (preview) { setDemo(null); return; } void run(async () => { await target.api!.disconnect(target.id!); await target.refresh(); }); }}><Icon name="x" extra="sm" /><span>{isWsl ? (zh ? "断开 WSL" : "Disconnect WSL") : zh ? "断开 SSH（不停止任务）" : "Disconnect SSH (keep tasks running)"}</span></button>
          <button className="execution-menu-row" role="menuitem" disabled={preview || status?.state !== "connected" || installing} onClick={() => { closeMenu(); void run(async () => { const result = await target.api!.installRuntime(target.id!); if (result.installed) { await target.refresh(); await target.select(target.id); } }); }}><Icon name="arrow-d" extra="sm" /><span>{zh ? "导入签名 Runtime" : "Import signed Runtime"}</span></button>
          <button className="execution-menu-row" role="menuitem" disabled={!preview && status?.state !== "connected"} onClick={() => { closeMenu(); if (preview) return; void run(() => target.api!.retryNetwork(target.id!)); }}><Icon name="refresh" extra="sm" /><span>{isWsl ? (zh ? "重新检查 WSL 网络" : "Recheck WSL network") : zh ? "重新检查远端网络" : "Recheck remote network"}</span></button>
          {isWsl ? <p className="execution-menu-help">{wslHelp}</p> : <p className="execution-menu-help">{status?.networkMessage || (zh ? "远端优先联网，连接失败时降级本机。" : "Uses remote network first and falls back through this computer.")} {zh ? "用户级模型配置自动从本机同步；文件、Git 和终端在远端执行。" : "User-level model config syncs from this computer; files, Git, and terminals run remotely."}</p>}
        </> : null}
        {unavailable ? <p className="execution-menu-help">{zh ? "SSH 连接需要桌面客户端。" : "SSH connections require the desktop app."}</p> : null}
      </div>
    </> : null}
    {displayError && !modalOpen ? <span className="execution-error" role="alert">{displayError}</span> : null}
    {modalOpen ? createPortal(<dialog role="dialog" ref={dialog} className="ssh-dialog" aria-labelledby="ssh-dialog-title" onCancel={event => { event.preventDefault(); closeModal(); }}>
      <div className="ssh-dialog-head"><h2 id="ssh-dialog-title">{form ? editing ? (zh ? "编辑 SSH 连接" : "Edit SSH connection") : (zh ? "添加 SSH 连接" : "Add SSH connection") : wslDirectory ? (zh ? "选择 WSL 项目目录" : "Choose WSL project directory") : (zh ? "选择远端项目目录" : "Choose remote project directory")}</h2><button type="button" className="icon-btn" aria-label={zh ? "关闭" : "Close"} disabled={busy} onClick={closeModal}><Icon name="x" /></button></div>
      {form ? <form onSubmit={event => { event.preventDefault(); save(); }}>
        <label>{zh ? "连接名称" : "Connection name"}<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder={zh ? "开发服务器" : "Dev server"} maxLength={80} disabled={busy} /></label>
        <label>{zh ? "主机地址或 SSH 配置别名" : "Host address or SSH config alias"}<input required value={host} onChange={event => setHost(event.target.value)} placeholder={zh ? "dev-server 或 192.168.1.10" : "dev-server or 192.168.1.10"} autoCapitalize="off" spellCheck={false} disabled={busy} /></label>
        <label>{zh ? "用户名" : "Username"}{authMode === "agent" ? (zh ? "（可留空使用 SSH 配置）" : " (optional, uses SSH config)") : ""}<input value={user} onChange={event => setUser(event.target.value)} required={authMode === "password"} placeholder={zh ? "用户名" : "Username"} autoComplete="username" autoCapitalize="off" spellCheck={false} disabled={busy} /></label>
        <label>{zh ? "认证方式" : "Authentication"}<AppSelect value={authMode} onChange={event => setAuthMode(event.target.value as "agent" | "password")} disabled={busy}><option value="agent">{zh ? "系统 SSH 配置 / 密钥 / agent" : "System SSH config / keys / agent"}</option><option value="password">{zh ? "用户名和密码" : "Username and password"}</option></AppSelect></label>
        <label>{zh ? "端口（留空使用 SSH 配置）" : "Port (leave empty for SSH config)"}<input type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} placeholder="22" disabled={busy} /></label>
        <p className="muted small">{zh ? "连接后自动识别 Windows、Linux 或 macOS，并准备私有 Node 和 Runtime。" : "Detects Windows, Linux, or macOS automatically after connecting and prepares private Node and Runtime."}</p>
        <details><summary>{zh ? "高级设置" : "Advanced settings"}</summary>
          <label>{zh ? "联网方式" : "Network mode"}<AppSelect value={networkMode} onChange={event => setNetworkMode(event.target.value as RemoteNetworkMode)} disabled={busy}><option value="remote-first">{zh ? "远端优先，失败时通过本机" : "Remote first, fall back to this computer"}</option><option value="remote-only">{zh ? "仅远端联网" : "Remote network only"}</option><option value="local-only">{zh ? "仅通过本机联网" : "Through this computer only"}</option></AppSelect></label>
          <label>{zh ? "远端安装目录（留空自动选择）" : "Remote install directory (auto if empty)"}<input value={installRoot} onChange={event => setInstallRoot(event.target.value)} placeholder={zh ? "远端绝对路径" : "Remote absolute path"} spellCheck={false} disabled={busy} /></label>
          <label>{zh ? "本机上游代理（留空使用系统代理）" : "Local upstream proxy (uses system proxy if empty)"}<input value={localProxyUrl} onChange={event => setLocalProxyUrl(event.target.value)} placeholder={zh ? "http://127.0.0.1:7890 或 socks5://…" : "http://127.0.0.1:7890 or socks5://..."} spellCheck={false} disabled={busy} /></label>
        </details>
        <p className="muted small">{authMode === "password" ? (zh ? "连接时会单独询问密码，只在本次连接期间保留，不保存到配置。账密模式仅支持直接密码认证，暂不支持跳板机、验证码或密码变更。" : "Asks for the password on connect and keeps it only for that connection without saving to disk. Password mode supports direct password auth only (no jump hosts, OTP, or password changes).") : (zh ? "复用系统 SSH config、密钥和 ssh-agent。可直接填写 user@host，或单独填写用户名。" : "Reuses your system SSH config, keys, and ssh-agent. You can enter user@host or specify username separately.")}</p>
        <p className="muted small">{zh ? "首次主机信任仍需在系统 SSH 完成；安装位置与模型配置同步会在体检后由应用内弹窗确认。" : "First-time host trust must still be completed via system SSH; install path and model config sync are confirmed in-app after probing."}</p>
        {preview && marks ? <p className="muted small">{zh ? "演示模式只修改界面，不连接服务器。" : "Preview mode updates UI state only and does not connect to any server."}</p> : null}
        {error ? <p role="alert" className="ssh-error">{error}</p> : null}
        <div className="ssh-dialog-actions"><button type="button" className="btn outline" onClick={closeModal} disabled={busy}>{zh ? "取消" : "Cancel"}</button><button className="btn primary" disabled={busy}>{busy ? (zh ? "准备中…" : "Preparing…") : `${zh ? "连接并检查" : "Connect & inspect"}${preview && marks ? (zh ? "（演示）" : " (Preview)") : ""}`}</button></div>
      </form> : <form onSubmit={event => { event.preventDefault(); if (preview) { setDemoPath(path); closeModal(); return; } if (!directoryTarget) return; void run(async () => { await target.api!.register(directoryTarget, path); await target.select(directoryTarget); setDirectoryTarget(undefined); }); }}>
        <p className="muted small">{wslDirectory ? (zh ? `${directoryName} 中的目录，文件保留在 Linux 文件系统中，不创建 Windows 副本。` : `A directory in ${directoryName}. Files stay on the Linux file system; no Windows copy is created.`) : zh ? `${directoryProfile?.name} 上的目录，不会创建本机副本。` : `Directory on ${directoryName}; no local copy is created.`}</p>
        <label>{wslDirectory ? (zh ? "Linux 绝对路径" : "Linux absolute path") : zh ? "远端绝对路径" : "Remote absolute path"}<input autoFocus required value={path} onChange={event => setPath(event.target.value)} spellCheck={false} disabled={busy} /></label>
        {wslDirectory && /^\/mnt\/[a-z](\/|$)/u.test(path) ? <p className="muted small">{zh ? "该目录位于 Windows 磁盘，文件访问和 Git 会明显变慢；建议放在 Linux 主目录下。" : "This directory is on a Windows drive, so file access and Git will be noticeably slower. A folder under your Linux home is recommended."}</p> : null}
        {!preview && <div className="ssh-directory-actions"><button type="button" className="btn outline small" disabled={busy || !directories || directories.parent === directories.path} onClick={() => void run(() => browse(directoryTarget!, directories?.parent))}>{zh ? "上一级" : "Up"}</button><button type="button" className="btn outline small" disabled={busy || !path} onClick={() => void run(() => browse(directoryTarget!, path))}>{zh ? "浏览路径" : "Browse path"}</button></div>}
        {!preview && <div className="ssh-directory-list" aria-label={zh ? "远端子目录" : "Remote subdirectories"}>{directories?.directories.map(directory => <button type="button" key={directory.path} disabled={busy} onClick={() => void run(() => browse(directoryTarget!, directory.path))}><Icon name="folder-open" extra="sm" />{directory.name}</button>)}{busy ? <p role="status">{zh ? "正在读取远端目录…" : "Loading remote directory…"}</p> : directories?.directories.length === 0 ? <p className="muted small">{zh ? "没有子目录，可以直接选择当前目录。" : "No subdirectories; you can select the current directory directly."}</p> : null}</div>}
        {error ? <p role="alert" className="ssh-error">{error}</p> : null}
        <div className="ssh-dialog-actions"><button type="button" className="btn outline" disabled={busy} onClick={closeModal}>{zh ? "取消" : "Cancel"}</button><button className="btn primary" disabled={busy || !path}>{busy ? (zh ? "准备中…" : "Preparing…") : (zh ? "在此目录工作" : "Work in this directory")}</button></div>
      </form>}
    </dialog>, document.body) : null}
    {preview && demoPasswordProfile ? <SshPasswordDialog demo profile={demoPasswordProfile} onCancel={() => setDemoPasswordProfile(undefined)} onSubmit={() => { setDemoPreparation(demoPasswordProfile); setDemoPasswordProfile(undefined); }} /> : null}
    {preview && demoPreparation ? <SshPreparationDialog demo profile={demoPreparation} status={{ id: demoPreparation.id, state: "awaiting-approval", stage: "confirmation", platform: "linux", arch: "x64", installRoot: "~/.local/share/omp-studio/remote" }} onCancel={() => setDemoPreparation(undefined)} onApprove={() => { setDemo({ kind: "ssh", name: demoPreparation.name }); setDemoPreparation(undefined); }} /> : null}
  </span>;
}
