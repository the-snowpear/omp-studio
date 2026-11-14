import { useEffect, useState } from "react";
import type { TmuxAction, TmuxTopology } from "../../../desktop/src/tmux/tmux-shared";
import { useTerminalSessions } from "../terminalSessions";
import { useAppSettings } from "../settings/appSettings";
import { usePreviewMode } from "../preview/PreviewContext";
import { changePreviewTmux, createPreviewTmux } from "../preview/tmuxPreview";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { WorkspaceDialog } from "../workspaces/Workspace";
import { TmuxSessionPicker } from "./TmuxSessionPicker";
import { TmuxCloseDialog } from "./TmuxCloseDialog";
import { TmuxWindowView } from "./TmuxWindowView";
import "./tmux.css";

const selection = (connection: string, window = "") => `tmux:${connection}:${window}`;
export function useTmuxPanel({ targetId, workspaceId, connected, cwd, activeId, select, visible, onError }: {
  targetId: string | null; workspaceId?: string | undefined; connected: boolean; cwd: string;
  activeId: string | null; select(id: string): void; visible: boolean; onError(error: string): void;
}) {
  const { t } = useI18n(), { preview, marks } = usePreviewMode(), { settings, update } = useAppSettings();
  const { store, tmux, hiddenWindows } = useTerminalSessions();
  const [demos, setDemos] = useState<TmuxTopology[]>([]);
  const [demoHidden, setDemoHidden] = useState<Record<string, string[]>>({});
  const [demoClose, setDemoClose] = useState<"ask" | "hide" | "kill">("ask");
  const [picker, setPicker] = useState(false);
  const [closing, setClosing] = useState<{ group: TmuxTopology; windowId: string; name: string }>();
  const [killing, setKilling] = useState<TmuxTopology>();
  const [renaming, setRenaming] = useState<{ group: TmuxTopology; windowId: string; name: string }>();
  const groups = preview ? demos : Object.values(tmux).filter(group => group.targetId === targetId && group.workspaceId === workspaceId);
  const hidden = preview ? demoHidden : hiddenWindows;
  const group = groups.find(group => activeId?.startsWith(`tmux:${group.connectionId}:`));
  const shownWindows = group?.windows.filter(window => !hidden[group.connectionId]?.includes(window.id)) ?? [];
  const window = shownWindows.find(window => activeId === selection(group!.connectionId, window.id)) ?? shownWindows.find(window => window.id === group?.activeWindowId) ?? shownWindows[0];
  const activePane = group && window ? Object.entries(group.panes).find(([, pane]) => pane.windowId === window.id && pane.active)?.[0] : undefined;
  const alive = group?.state === "attached";
  useEffect(() => {
    if (group?.activeWindowId && !hidden[group.connectionId]?.includes(group.activeWindowId)) select(selection(group.connectionId, group.activeWindowId));
  }, [group?.connectionId, group?.activeWindowId]);
  const command = async (group: TmuxTopology, action: TmuxAction) => {
    try {
      if (preview) setDemos(current => current.map(item => item.connectionId === group.connectionId ? changePreviewTmux(item, action) : item));
      else await store.tmuxCommand(group.connectionId, action);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };
  const detach = async (group: TmuxTopology) => {
    if (preview) setDemos(current => current.map(item => item === group ? { ...item, state: "exited", reason: "detached" } : item));
    else await store.detachTmux(group.connectionId).catch(error => onError(String(error)));
  };
  const forget = (group: TmuxTopology) => { if (preview) setDemos(current => current.filter(item => item.connectionId !== group.connectionId)); else store.forgetTmux(group.connectionId); };
  const hide = async (group: TmuxTopology, windowId: string, value: boolean) => {
    if (preview) setDemoHidden(current => ({ ...current, [group.connectionId]: value ? [...(current[group.connectionId] ?? []), windowId] : (current[group.connectionId] ?? []).filter(id => id !== windowId) }));
    else await store.hideTmuxWindow(group.connectionId, windowId, value).catch(error => onError(String(error)));
  };
  const closeWindow = (group: TmuxTopology, windowId: string, name: string) => {
    const action = preview ? demoClose : settings.terminalTmuxCloseAction;
    if (action === "ask") setClosing({ group, windowId, name });
    else if (action === "hide") void hide(group, windowId, true);
    else void command(group, { kind: "killWindow", windowId });
  };
  const attach = async (name: string, old?: TmuxTopology) => {
    let connectionId: string;
    if (preview) {
      connectionId = `preview-tmux-${Date.now()}`;
      const next = createPreviewTmux(connectionId, name);
      setDemos(current => old ? current.map(item => item.connectionId === old.connectionId ? next : item) : [...current, next]);
    } else {
      const screen = activeId ? store.hosts.get(activeId)?.term : undefined;
      connectionId = await store.attachTmux(targetId!, workspaceId!, name, screen ? { cols: screen.cols, rows: screen.rows } : undefined, old?.connectionId);
    }
    select(selection(connectionId));
  };
  const canAttach = preview || !!(targetId && workspaceId && connected && store.api?.tmuxAttach);
  const reason = !targetId ? t("terminal.tmux.sshOnly") : !store.api?.tmuxAttach ? t("terminal.tmux.unavailable") : t("terminal.tmux.connectFirst");
  const list = groups.map(item => {
    const hiddenIds = hidden[item.connectionId] ?? [];
    const live = item.state === "attached";
    return <section className="tmux-group" key={item.connectionId} aria-label={`tmux · ${item.session?.name}`}>
      <div className="tmux-group-head">
        <button type="button" className="tmux-group-name ellipsis" onClick={() => select(selection(item.connectionId))}>tmux · {item.session?.name}</button>
        <details className="tmux-menu"><summary aria-label={t("terminal.tmux.menu")}><Icon name="more" extra="sm" /></summary><div>
          <button type="button" disabled={!live} onClick={() => setKilling(item)}>{t("terminal.tmux.killSession")}</button>
          {!live ? <button type="button" onClick={() => forget(item)}>{t("terminal.tmux.remove")}</button> : null}
        </div></details>
        <button type="button" className="icon-btn small" aria-label={t("terminal.tmux.detach")} disabled={!live && item.state !== "attaching"} onClick={() => void detach(item)}><Icon name="x" extra="sm" /></button>
      </div>
      <div className="tmux-group-status"><span className="chip gray xs">{t(`terminal.tmux.states.${item.state}`)}</span>{preview && marks ? <span className="chip purple xs">{t("terminal.tmux.demo")}</span> : null}</div>
      {item.windows.filter(window => !hiddenIds.includes(window.id)).map(win => <div key={win.id} className={`term-item tmux-window-item${item === group && win.id === window?.id ? " active" : ""}`}>
        <button type="button" className="ti-main" onClick={() => { select(selection(item.connectionId, win.id)); if (live) void command(item, { kind: "selectWindow", windowId: win.id }); }}><span className="ti-name ellipsis">{win.index}: {win.name}{item.activeWindowId === win.id ? " ·" : ""}</span></button>
        <button type="button" className="icon-btn small" aria-label={t("terminal.tmux.closeWindow", { name: win.name })} disabled={!live} onClick={() => closeWindow(item, win.id, win.name)}><Icon name="x" extra="sm" /></button>
      </div>)}
      {item.windows.some(win => hiddenIds.includes(win.id)) ? <details className="tmux-hidden"><summary>{t("terminal.tmux.hidden", { count: hiddenIds.length })}</summary>{item.windows.filter(win => hiddenIds.includes(win.id)).map(win => <button type="button" key={win.id} onClick={() => { void hide(item, win.id, false); select(selection(item.connectionId, win.id)); }}>{t("terminal.tmux.restore", { name: win.name })}</button>)}</details> : null}
    </section>;
  });
  const toolbar = group ? <>
    <div className="term-cwd"><span className="ellipsis">tmux · {group.session?.name} · {window?.name}{activePane && group.panes[activePane]?.cwd ? ` · ${group.panes[activePane]!.cwd}` : ""}</span>
      <div className="tmux-toolbar">
        <button type="button" className="icon-btn small" disabled={!alive || !activePane} title={t("terminal.tmux.splitRight")} aria-label={t("terminal.tmux.splitRight")} onClick={() => void command(group, { kind: "splitPane", paneId: activePane!, direction: "right" })}><Icon name="columns" extra="sm" /></button>
        <button type="button" className="icon-btn small tmux-split-down" disabled={!alive || !activePane} title={t("terminal.tmux.splitDown")} aria-label={t("terminal.tmux.splitDown")} onClick={() => void command(group, { kind: "splitPane", paneId: activePane!, direction: "down" })}><Icon name="columns" extra="sm" /></button>
        <button type="button" className="icon-btn small" disabled={!alive} title={t("terminal.tmux.newWindow")} aria-label={t("terminal.tmux.newWindow")} onClick={() => void command(group, { kind: "newWindow", ...(window ? { afterWindowId: window.id } : {}) })}><Icon name="plus" extra="sm" /></button>
        <button type="button" className="icon-btn small" disabled={!alive || !activePane} title={t("terminal.tmux.zoom")} aria-label={t("terminal.tmux.zoom")} onClick={() => void command(group, { kind: "zoomPane", paneId: activePane! })}><Icon name="maximize" extra="sm" /></button>
        <button type="button" className="icon-btn small" disabled={!alive || !window} title={t("terminal.tmux.rename")} aria-label={t("terminal.tmux.rename")} onClick={() => setRenaming({ group, windowId: window!.id, name: window!.name })}><Icon name="pencil" extra="sm" /></button>
        <button type="button" className="icon-btn small" disabled={!alive || !activePane} title={t("terminal.tmux.killPane")} aria-label={t("terminal.tmux.killPane")} onClick={() => void command(group, { kind: "killPane", paneId: activePane! })}><Icon name="stop" extra="sm" /></button>
      </div>
    </div>
    {group.state === "exited" || group.state === "lost" ? <div className="tmux-banner" role="status"><span>{t(`terminal.tmux.states.${group.state}`)} · {group.reason === "too-old" ? t("terminal.tmux.errors.too-old") : group.reason === "attach-timeout" ? t("terminal.tmux.errors.attach-timeout") : group.reason === "detached" ? t("terminal.tmux.detachedDetail") : group.reason}</span><button className="btn outline sm" type="button" onClick={() => void attach(group.session!.name, group).catch(error => onError(String(error)))}>{t("terminal.tmux.reattach")}</button><button className="btn ghost sm" type="button" onClick={() => forget(group)}>{t("terminal.tmux.remove")}</button></div> : null}
    {group.configErrors?.length ? <details className="tmux-banner"><summary>{t("terminal.tmux.configErrors")}</summary>{group.configErrors.map((error, index) => <p key={index}>{error}</p>)}</details> : null}
    {!window ? <div className="empty">{t(group.state === "attaching" ? "terminal.tmux.loading" : "terminal.tmux.noVisibleWindows")}</div> : null}
  </> : null;
  return {
    selected: !!group, list, toolbar,
    entry: <button type="button" className="term-new tmux-attach" disabled={!canAttach} title={canAttach ? t("terminal.tmux.attach") : reason} onClick={() => setPicker(true)}><Icon name="attach" extra="sm" />{t("terminal.tmux.attach")}</button>,
    screens: <div className="tmux-screen-stack" hidden={!group}>{groups.flatMap(item => item.windows.map(win => <TmuxWindowView key={`${item.connectionId}:${win.id}`} topology={item} window={win} store={store} active={visible && item === group && win.id === window?.id} demo={preview} command={action => command(item, action)} />))}</div>,
    dialogs: <>
      {picker ? <TmuxSessionPicker store={store} targetId={targetId} workspaceId={workspaceId} defaultName={`studio-${cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "work"}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64)} onAttach={attach} onClose={() => setPicker(false)} /> : null}
      {closing ? <TmuxCloseDialog name={closing.name} onClose={() => setClosing(undefined)} onChoose={(action, remember) => { if (remember) { if (preview) setDemoClose(action); else update({ terminalTmuxCloseAction: action }); } if (action === "hide") void hide(closing.group, closing.windowId, true); else void command(closing.group, { kind: "killWindow", windowId: closing.windowId }); setClosing(undefined); }} /> : null}
      {killing ? <WorkspaceDialog title={t("terminal.tmux.killSession")} onClose={() => setKilling(undefined)}><p>{t("terminal.tmux.killSessionConfirm", { name: killing.session?.name ?? "" })}</p><div className="tmux-dialog-actions"><button type="button" className="btn outline" onClick={() => setKilling(undefined)}>{t("terminal.tmux.cancel")}</button><button type="button" className="btn danger" onClick={() => { void command(killing, { kind: "killSession" }); setKilling(undefined); }}>{t("terminal.tmux.killSession")}</button></div></WorkspaceDialog> : null}
      {renaming ? <WorkspaceDialog title={t("terminal.tmux.rename")} onClose={() => setRenaming(undefined)}><form onSubmit={event => { event.preventDefault(); void command(renaming.group, { kind: "renameWindow", windowId: renaming.windowId, name: renaming.name }); setRenaming(undefined); }}><input className="input" aria-label={t("terminal.tmux.rename")} value={renaming.name} onChange={event => setRenaming({ ...renaming, name: event.target.value })} /><div className="tmux-dialog-actions"><button type="submit" className="btn primary">{t("terminal.tmux.save")}</button></div></form></WorkspaceDialog> : null}
    </>,
  };
}
