import "./ssh.css";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_SSH_TARGETS } from "../preview/fixtures";
import { useExecutionTarget, useTargetMemory } from "./ExecutionTargets";
import { SshPasswordDialog } from "./SshPasswordDialog";
import { remoteConnectionPending, remoteStatusLabel } from "./remoteStatus";
import type { RemoteConnectionProfile, RemoteDirectoryList } from "../../../desktop/src/remote/shared";

export function ExecutionTargetPicker({ onOpen, otherMenuOpen = false }: { onOpen?(): void; otherMenuOpen?: boolean }) {
  const target = useExecutionTarget();
  const { preview } = usePreviewMode();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(false);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [authMode, setAuthMode] = useState<"agent" | "password">("agent");
  const [port, setPort] = useState("");
  const [editing, setEditing] = useState<string>();
  const [platform, setPlatform] = useState<RemoteConnectionProfile["platform"]>("linux");
  const [busy, setBusy] = useState(false);
  const [connectingId, setConnectingId] = useState<string>();
  const [error, setError] = useState("");
  const [directoryTarget, setDirectoryTarget] = useState<string>();
  const [directories, setDirectories] = useState<RemoteDirectoryList>();
  const [path, setPath] = useState("");
  const [demo, setDemo] = useTargetMemory<string | null>("preview-execution-target", () => null);
  const [demoPasswordProfile, setDemoPasswordProfile] = useState<RemoteConnectionProfile>();
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false);
  const navigation = useRef(0);
  const modalOpen = form || directoryTarget !== undefined;
  const status = target.inventory.statuses.find(value => value.id === target.id);
  const label = preview ? demo ? `SSH · ${demo}` : "此计算机" : target.id ? `SSH · ${target.name}` : "此计算机";
  const unavailable = !preview && !target.api;
  const installing = status?.operation === "installing-runtime";

  useEffect(() => { if (modalOpen) dialog.current?.showModal(); else dialog.current?.close(); }, [modalOpen]);
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }, [open]);
  useEffect(() => { if (otherMenuOpen) setOpen(false); }, [otherMenuOpen]);
  const closeMenu = () => { setOpen(false); button.current?.focus(); };
  const closeModal = () => {
    if (busy) return;
    navigation.current++;
    setForm(false); setDirectoryTarget(undefined); setDirectories(undefined); setError("");
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
    setOpen(false); setDirectoryTarget(id); setDirectories(undefined); setPath("");
    void run(() => browse(id));
  };
  const choose = (id: string | null) => {
    closeMenu();
    if (preview) { setDemo(id); return; }
    if (!target.api) return;
    cancelled.current = false;
    void run(async () => {
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
    setPort(profile?.port ? String(profile.port) : ""); setPlatform(profile?.platform ?? "linux");
    setError(""); setForm(true);
  };
  const save = () => void run(async () => {
    if (preview) {
      setForm(false);
      if (authMode === "password") setDemoPasswordProfile({ id: "demo-password", name: name || host, host, user, platform, authMode });
      else setDemo(name || host);
      return;
    }
    await target.api!.save({ ...(editing ? { id: editing } : {}), name: name.trim() || host.trim(), host: host.trim(), platform, authMode, ...(user.trim() ? { user: user.trim() } : {}), ...(port ? { port: Number(port) } : {}) });
    await target.refresh();
    setForm(false); setEditing(undefined); button.current?.focus();
  });
  const profiles = preview ? PREVIEW_SSH_TARGETS : target.inventory.profiles;
  const displayError = error || target.inventoryError;

  return <span className="execution-picker">
    <button ref={button} type="button" className="ctx-item ctx-project-switch" aria-label={`工作位置：${label}${preview ? "（演示）" : ""}`} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => { onOpen?.(); setOpen(value => !value); setError(""); }}>
      {busy ? <span className="spinner" /> : <Icon name="terminal" extra="sm" />}
      <span>{label}</span>
      {!preview && target.id && status?.state !== "connected" ? <span className={remoteConnectionPending(status) ? "remote-pending" : "remote-offline"}>{remoteStatusLabel(status)}</span> : null}
      {preview ? <span className="chip xs">演示</span> : null}
      <Icon name="chevron-d" extra="sm" />
    </button>
    {connectingId ? <button className="btn small" onClick={() => { cancelled.current = true; void target.cancelConnection(connectingId).catch(showError); }}>取消连接</button> : null}
    {open ? <>
      <button className="ctx-project-backdrop" aria-label="关闭执行位置菜单" onClick={closeMenu} />
      <div ref={menu} className="menu ctx-project-menu execution-menu" role="menu" aria-label="工作位置" onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); closeMenu(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
          const current = items.indexOf(document.activeElement as HTMLElement);
          items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}>
        <div className="menu-label">工作位置</div>
        <button className="execution-menu-row" role="menuitem" onClick={() => choose(null)}><Icon name="folder-open" extra="sm" /><span>此计算机</span>{(!preview && !target.id) || (preview && !demo) ? <Icon name="check" extra="sm" /> : null}</button>
        {profiles.map(profile => {
          const state = target.inventory.statuses.find(value => value.id === profile.id);
          const locked = !preview && (remoteConnectionPending(state) || Boolean(state?.operation));
          const realProfile = !preview ? target.inventory.profiles.find(value => value.id === profile.id) : undefined;
          return <div className="execution-profile" key={profile.id}>
            <button className="execution-menu-row" role="menuitem" disabled={locked} onClick={() => choose(preview ? profile.name : profile.id)}>
              <Icon name="terminal" extra="sm" /><span>{profile.name}<small>{profile.platform === "win32" ? "Windows" : profile.platform === "darwin" ? "macOS" : "Linux"}{!preview ? ` · ${remoteStatusLabel(state)}` : ""}</small></span>
              {!preview && target.id === profile.id ? <Icon name="check" extra="sm" /> : null}
            </button>
            {realProfile && target.id !== profile.id && !locked && state?.state !== "connected" ? <button className="icon-btn" aria-label={`编辑 ${profile.name}`} onClick={() => edit(realProfile)}><Icon name="settings" extra="sm" /></button> : null}
            {realProfile && target.id !== profile.id && !locked ? <button className="icon-btn" aria-label={`移除 ${profile.name}`} onClick={() => void run(async () => { await target.api!.disconnect(profile.id); await target.api!.remove(profile.id); await target.refresh(); })}><Icon name="x" extra="sm" /></button> : null}
          </div>;
        })}
        <div className="menu-sep" />
        <button className="execution-menu-row" role="menuitem" disabled={unavailable} onClick={() => edit()}><Icon name="plus" extra="sm" /><span>添加 SSH 连接</span></button>
        {!preview && target.id ? <>
          <button className="execution-menu-row" role="menuitem" disabled={status?.state !== "connected" || installing} onClick={() => openDirectory(target.id!)}><Icon name="folder-open" extra="sm" /><span>选择远端目录</span></button>
          <button className="execution-menu-row" role="menuitem" disabled={installing} onClick={() => { closeMenu(); void run(async () => { await target.api!.disconnect(target.id!); await target.refresh(); }); }}><Icon name="x" extra="sm" /><span>断开 SSH（不停止任务）</span></button>
          <button className="execution-menu-row" role="menuitem" disabled={status?.state !== "connected" || installing} onClick={() => { closeMenu(); void run(async () => { const result = await target.api!.installRuntime(target.id!); if (result.installed) { await target.refresh(); await target.select(target.id); } }); }}><Icon name="download" extra="sm" /><span>导入签名 Runtime</span></button>
          <p className="execution-menu-help">项目、Git、模型配置和新终端使用这台远端机器。不会复制本机模型凭证。</p>
        </> : null}
        {unavailable ? <p className="execution-menu-help">SSH 连接需要桌面客户端。</p> : null}
      </div>
    </> : null}
    {displayError && !modalOpen ? <span className="execution-error" role="alert">{displayError}</span> : null}
    {modalOpen ? createPortal(<dialog ref={dialog} className="ssh-dialog" aria-labelledby="ssh-dialog-title" onCancel={event => { event.preventDefault(); closeModal(); }}>
      <div className="ssh-dialog-head"><h2 id="ssh-dialog-title">{form ? editing ? "编辑 SSH 连接" : "添加 SSH 连接" : "选择远端项目目录"}</h2><button type="button" className="icon-btn" aria-label="关闭" disabled={busy} onClick={closeModal}><Icon name="x" /></button></div>
      {form ? <form onSubmit={event => { event.preventDefault(); save(); }}>
        <label>连接名称<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="开发服务器" maxLength={80} disabled={busy} /></label>
        <label>主机地址或 SSH 配置别名<input required value={host} onChange={event => setHost(event.target.value)} placeholder="dev-server 或 192.168.1.10" autoCapitalize="off" spellCheck={false} disabled={busy} /></label>
        <label>用户名{authMode === "agent" ? "（可留空使用 SSH 配置）" : ""}<input value={user} onChange={event => setUser(event.target.value)} required={authMode === "password"} placeholder="用户名" autoComplete="username" autoCapitalize="off" spellCheck={false} disabled={busy} /></label>
        <label>认证方式<select value={authMode} onChange={event => setAuthMode(event.target.value as "agent" | "password")} disabled={busy}><option value="agent">系统 SSH 配置 / 密钥 / agent</option><option value="password">用户名和密码</option></select></label>
        <label>端口（留空使用 SSH 配置）<input type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} placeholder="22" disabled={busy} /></label>
        <label>远端系统<select value={platform} onChange={event => setPlatform(event.target.value as typeof platform)} disabled={busy}><option value="linux">Linux</option><option value="win32">Windows</option><option value="darwin">macOS</option></select></label>
        <p className="muted small">{authMode === "password" ? "连接时会单独询问密码，只在本次连接期间保留，不保存到配置。账密模式仅支持直接密码认证，暂不支持跳板机、验证码或密码变更。" : "复用系统 SSH config、密钥和 ssh-agent。可直接填写 user@host，或单独填写用户名。"}</p>
        <p className="muted small">远端需要 Node.js 22+。首次主机信任仍需在系统 SSH 完成，不会自动接受未知主机密钥。</p>
        {preview ? <p className="muted small">演示模式只修改界面，不连接服务器。</p> : null}
        {error ? <p role="alert" className="ssh-error">{error}</p> : null}
        <div className="ssh-dialog-actions"><button type="button" className="btn outline" onClick={closeModal} disabled={busy}>取消</button><button className="btn primary" disabled={busy}>{busy ? "保存中…" : `保存连接${preview ? "（演示）" : ""}`}</button></div>
      </form> : <form onSubmit={event => { event.preventDefault(); if (!directoryTarget) return; void run(async () => { await target.api!.register(directoryTarget, path); await target.select(directoryTarget); setDirectoryTarget(undefined); }); }}>
        <p className="muted small">{target.inventory.profiles.find(value => value.id === directoryTarget)?.name} 上的目录，不会创建本机副本。</p>
        <label>远端绝对路径<input autoFocus required value={path} onChange={event => setPath(event.target.value)} spellCheck={false} disabled={busy} /></label>
        <div className="ssh-directory-actions"><button type="button" className="btn outline small" disabled={busy || !directories || directories.parent === directories.path} onClick={() => void run(() => browse(directoryTarget!, directories?.parent))}>上一级</button><button type="button" className="btn outline small" disabled={busy || !path} onClick={() => void run(() => browse(directoryTarget!, path))}>浏览路径</button></div>
        <div className="ssh-directory-list" aria-label="远端子目录">{directories?.directories.map(directory => <button type="button" key={directory.path} disabled={busy} onClick={() => void run(() => browse(directoryTarget!, directory.path))}><Icon name="folder-open" extra="sm" />{directory.name}</button>)}{busy ? <p role="status">正在读取远端目录…</p> : directories?.directories.length === 0 ? <p className="muted small">没有子目录，可以直接选择当前目录。</p> : null}</div>
        {error ? <p role="alert" className="ssh-error">{error}</p> : null}
        <div className="ssh-dialog-actions"><button type="button" className="btn outline" disabled={busy} onClick={closeModal}>取消</button><button className="btn primary" disabled={busy || !path}>{busy ? "准备中…" : "在此目录工作"}</button></div>
      </form>}
    </dialog>, document.body) : null}
    {preview && demoPasswordProfile ? <SshPasswordDialog demo profile={demoPasswordProfile} onCancel={() => setDemoPasswordProfile(undefined)} onSubmit={() => { setDemo(demoPasswordProfile.name); setDemoPasswordProfile(undefined); }} /> : null}
  </span>;
}
