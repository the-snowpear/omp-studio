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

export type TerminalPaneHandle = {
  create: () => void;
  available: boolean;
};

type SessionStatus = "running" | "ended";

type Session = {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly status: SessionStatus;
};

type Host = {
  readonly term: Terminal;
  readonly fit: FitAddon;
};

function readCssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

function readXtermTheme(): {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
} {
  return {
    background: readCssVar("--surface", "#ffffff"),
    foreground: readCssVar("--text", "#1d2129"),
    cursor: readCssVar("--text", "#1d2129"),
    cursorAccent: readCssVar("--surface", "#ffffff"),
    selectionBackground: readCssVar("--accent-soft", "rgba(110, 86, 207, 0.18)"),
    selectionForeground: readCssVar("--text", "#1d2129"),
  };
}

function applyTheme(term: Terminal): void {
  term.options.theme = readXtermTheme();
  term.options.fontFamily = readCssVar("--font-mono", "Consolas, monospace");
}

export const TerminalPane = forwardRef<TerminalPaneHandle, { visible: boolean }>(function TerminalPane(
  { visible },
  ref,
) {
  const { t } = useI18n();
  const api = globalThis.ompStudioTerminal;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const hosts = useRef(new Map<string, Host>());
  const pending = useRef(new Map<string, string>());
  const sessionsRef = useRef<Session[]>([]);
  const bootstrapped = useRef(false);
  const createLock = useRef(false);
  sessionsRef.current = sessions;

  const createSession = useCallback(async () => {
    if (!api || createLock.current) return;
    createLock.current = true;
    setCreating(true);
    setError(null);
    try {
      const info = await api.create({ cols: 80, rows: 24 });
      const session: Session = { id: info.id, name: info.name, cwd: info.cwd, status: "running" };
      setSessions((current) => [...current, session]);
      setActiveId(info.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      createLock.current = false;
      setCreating(false);
    }
  }, [api]);

  useImperativeHandle(
    ref,
    () => ({
      create: () => {
        void createSession();
      },
      available: api !== undefined,
    }),
    [api, createSession],
  );

  useEffect(() => {
    if (!api || bootstrapped.current || !visible) return;
    bootstrapped.current = true;
    void createSession();
  }, [api, visible, createSession]);

  useEffect(() => {
    if (!api) return;
    const offData = api.onData((event) => {
      const host = hosts.current.get(event.id);
      if (host) {
        host.term.write(event.data);
        return;
      }
      pending.current.set(event.id, (pending.current.get(event.id) ?? "") + event.data);
    });
    const offExit = api.onExit((event) => {
      setSessions((current) =>
        current.map((session) => (session.id === event.id ? { ...session, status: "ended" } : session)),
      );
    });
    return () => {
      offData();
      offExit();
    };
  }, [api]);

  useEffect(() => {
    if (!api) return;
    return () => {
      for (const host of hosts.current.values()) host.term.dispose();
      hosts.current.clear();
      for (const session of sessionsRef.current) void api.dispose(session.id);
    };
  }, [api]);

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
              onClick={() => setActiveId(session.id)}
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
            </div>
          );
        })}
        <button className="term-new" type="button" disabled={creating} onClick={() => void createSession()}>
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
            <div className="term-screens">
              {sessions.map((session) => (
                <XtermScreen
                  key={session.id}
                  session={session}
                  api={api}
                  hosts={hosts.current}
                  pending={pending.current}
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

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let host = hosts.get(session.id);
    if (host === undefined) {
      const term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontSize: 12,
        lineHeight: 1.3,
        fontFamily: readCssVar("--font-mono", "Consolas, monospace"),
        theme: readXtermTheme(),
        allowProposedApi: false,
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

    const observer = new MutationObserver(() => applyTheme(host.term));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      observer.disconnect();
    };
  }, [api, hosts, pending, session.id]);

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
      host.term.focus();
    };
    const frame = requestAnimationFrame(sync);
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(sync);
    });
    ro.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [active, api, hosts, session.id]);

  return <div className="term-xterm" ref={containerRef} hidden={!active} />;
}

function termParentMissing(term: Terminal, node: HTMLDivElement): boolean {
  return term.element !== undefined && term.element !== null && term.element.parentElement !== node;
}
