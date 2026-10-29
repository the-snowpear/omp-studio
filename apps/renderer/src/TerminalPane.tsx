import { useExecutionTarget } from "./workspaces/ExecutionTargets";
import { readTerminalTypography, readXtermTheme, applyTheme } from "./terminalTheme";
import { useAppSettings } from "./settings/appSettings";
import { useTerminalSessions, type TerminalSession as Session, type TerminalScreenHost as Host } from "./terminalSessions";
import { TerminalGraphicView } from "./TerminalGraphicView";
import { TerminalRecordingControls } from "./recordings/TerminalRecordingControls";
/**
 * Desktop-chrome integrated shell. Uses `window.ompStudioTerminal` when the
 * Electron preload is present; otherwise shows an honest unavailable state.
 * This is not Runtime TUI attach and does not talk to the Host contract.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Icon } from "./icons";
import { useI18n } from "./i18n";

/** 每个终端的回滚行数。乘以同时存在的终端数就是本面板的内存底数。 */
const TERMINAL_SCROLLBACK_LINES = 1_000;

export type TerminalPaneHandle = {
  create: () => void;
  available: boolean;
};

export const TerminalPane = forwardRef<TerminalPaneHandle, { visible: boolean; workspaceId?: string | undefined; sessionId?: string | undefined }>(function TerminalPane(
  { visible, workspaceId, sessionId },
  ref,
) {
  const { t } = useI18n();
  const api = globalThis.ompStudioTerminal;
  const executionTarget = useExecutionTarget();
  const { store, sessions: allSessions, graphics, graphicsErrors } = useTerminalSessions();
  const sessions = allSessions.filter(session => session.targetId === executionTarget.id);
  const [activeId, setActiveId] = useState<string | null>(() => store.activeIds.get(executionTarget.id) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const bootstrapped = useRef(sessions.length > 0);
  const createLock = useRef(false);
  const targetStatus = executionTarget.inventory.statuses.find(status => status.id === executionTarget.id);
  const canCreate = !executionTarget.id || (targetStatus?.state === "connected" && !targetStatus.operation);
  const selectSession = (id: string): void => { store.activeIds.set(executionTarget.id, id); setActiveId(id); };

  const createSession = useCallback(async () => {
    if (!api || createLock.current || !canCreate) return;
    createLock.current = true;
    bootstrapped.current = true;
    setCreating(true);
    setError(null);
    try { setActiveId(await store.create(executionTarget.id, workspaceId, sessionId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { createLock.current = false; setCreating(false); }
  }, [api, store, workspaceId, sessionId, executionTarget.id, canCreate]);

  useImperativeHandle(ref, () => ({ create: () => { void createSession(); }, available: api !== undefined && canCreate }), [api, canCreate, createSession]);
  useEffect(() => {
    if (!api || bootstrapped.current || !visible || !canCreate) return;
    bootstrapped.current = true;
    void createSession();
  }, [api, visible, canCreate, createSession]);

  if (!api) {
    return (
      <div className="empty">
        <Icon name="terminal" extra="lg" />
        <p>{t("terminal.desktopOnly")}</p>
        <p className="muted small">{t("terminal.desktopOnlyDetail")}</p>
      </div>
    );
  }

  const active = sessions.find((session) => session.id === activeId) ?? sessions[0] ?? null;

  return (
    <div className="term-layout">
      <div className="term-list" role="listbox" aria-label={t("terminal.listAria")}>
        {sessions.map((session) => {
          const selected = session.id === active?.id;
          return (
            <div
              key={session.id}
              className={`term-item${selected ? " active" : ""}${session.status === "ended" ? " ended" : ""}`}
              role="option"
              tabIndex={selected ? 0 : -1}
              aria-selected={selected}
              onClick={() => selectSession(session.id)}
            >
              <span className="ti-icon" aria-hidden="true">
                <Icon name="terminal" extra="sm" />
              </span>
              <span className="ti-main">
                <span className="ti-name ellipsis">{session.name}</span>
                <span className="ti-sub">{session.status === "ended" ? t("terminal.statusEnded") : t("terminal.statusRunning")}</span>
              </span>
              <span className="ti-badge gray">
                YOU<span className="sr-only"> {t("terminal.userCreated")}</span>
              </span>
              <button className="icon-btn small" type="button" aria-label={`关闭终端 ${session.name}`} onClick={event => { event.stopPropagation(); void store.remove(session.id).catch(cause => setError(String(cause))); }}><Icon name="x" extra="sm" /></button>
            </div>
          );
        })}
        <button className="term-new" type="button" disabled={creating || !canCreate} onClick={() => void createSession()}>
          <Icon name="plus" extra="sm" />
          {t("terminal.newTerminal")}
        </button>
      </div>
      <div className="term-view">
        {active ? (
          <>
            <div className="term-cwd">
              <Icon name="folder" extra="sm" />
              <span className="ellipsis">{active.cwd}</span>
              {active.status === "ended" ? (
                <span className="chip gray xs" style={{ marginLeft: "auto" }}>
                  {t("terminal.statusEnded")}
                </span>
              ) : (
                <span className="chip green xs" style={{ marginLeft: "auto" }}>
                  {active.name}
                </span>
              )}
            </div>
            {executionTarget.id ? <p className="muted small">SSH 终端暂不支持本机录制；关闭标签会结束该终端。</p> : <TerminalRecordingControls key={active.id} api={api} id={active.id} visible={visible} ended={active.status === "ended"} workspaceId={active.workspaceId} sessionId={active.sessionId} />}
            {error ? <p role="alert" className="muted small">{error}</p> : null}
            {(graphics[active.id]?.length || graphicsErrors[active.id]) ? <div style={{ maxHeight: 240, overflow: "auto" }} aria-label="Terminal images / 终端图片">
              {graphics[active.id]?.map((image, index) => <TerminalGraphicView key={index} image={image} />)}
              {graphicsErrors[active.id] ? <p role="status">{graphicsErrors[active.id]}</p> : null}
            </div> : null}
            <div className="term-screens">
              {sessions.map((session) => (
                <XtermScreen
                  key={session.id}
                  session={session}
                  api={api}
                  hosts={store.hosts}
                  pending={store.pending}
                  active={visible && session.id === active.id}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="empty">
            <Icon name="terminal" extra="lg" />
            <p>{creating ? t("terminal.starting") : t("terminal.noSessions")}</p>
            {error ? <p className="muted small">{error}</p> : <p className="muted small">{t("terminal.clickToStart")}</p>}
          </div>
        )}
      </div>
    </div>
  );
});

function XtermScreen({
  session,
  api,
  hosts,
  pending,
  active,
}: {
  session: Session;
  api: NonNullable<typeof globalThis.ompStudioTerminal>;
  hosts: Map<string, Host>;
  pending: Map<string, string>;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { settings } = useAppSettings();

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let host = hosts.get(session.id);
    if (host === undefined) {
      const term = new Terminal({
        convertEol: true,
        disableStdin: session.status === "ended",
        cursorBlink: session.status !== "ended",
        ...readTerminalTypography(),
        lineHeight: 1.3,
        theme: readXtermTheme(),
        allowProposedApi: false,
        // xterm 的默认值也是 1000，写出来是为了让这条上限有据可查：回滚缓冲乘以
        // 同时存在的终端数就是这个面板的内存底数。
        scrollback: TERMINAL_SCROLLBACK_LINES,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(node);
      term.onData((data) => {
        void api.write(session.id, data);
      });
      host = { term, fit };
      hosts.set(session.id, host);
      const queued = pending.get(session.id);
      if (queued !== undefined) {
        term.write(queued);
        pending.delete(session.id);
      }
    } else if (termParentMissing(host.term, node)) {
      node.appendChild(host.term.element ?? node);
    }

    host.term.options.disableStdin = session.status === "ended";
    host.term.options.cursorBlink = session.status !== "ended";
    const observer = new MutationObserver(() => applyTheme(host.term));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      observer.disconnect();
    };
  }, [api, hosts, pending, session.id, session.status]);

  useEffect(() => {
    const host = hosts.get(session.id);
    if (!host) return;
    applyTheme(host.term);
    const node = containerRef.current;
    let disposed = false;
    const fit = () => {
      if (disposed || !active || !node || node.clientWidth === 0 || node.clientHeight === 0) return;
      host.fit.fit();
      void api.resize(session.id, host.term.cols, host.term.rows);
    };
    const frame = requestAnimationFrame(fit);
    void document.fonts?.ready.then(fit);
    return () => { disposed = true; cancelAnimationFrame(frame); };
  }, [active, api, hosts, session.id, settings.terminalFontFamily, settings.terminalFontSize]);

  useEffect(() => {
    const host = hosts.get(session.id);
    const node = containerRef.current;
    if (!host || !node || !active) return;
    const sync = (): void => {
      try {
        host.fit.fit();
        void api.resize(session.id, host.term.cols, host.term.rows);
      } catch {
        // Fit can throw while the panel is mid-collapse.
      }
    };
    const frame = requestAnimationFrame(() => { sync(); host.term.focus(); });
    let resizeFrame = 0;
    const ro = new ResizeObserver(() => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(sync);
    });
    ro.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizeFrame);
      ro.disconnect();
    };
  }, [active, api, hosts, session.id]);

  return <div className="term-xterm" ref={containerRef} hidden={!active} />;
}

function termParentMissing(term: Terminal, node: HTMLDivElement): boolean {
  return term.element !== undefined && term.element !== null && term.element.parentElement !== node;
}
