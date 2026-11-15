import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TmuxAction, TmuxLayoutNode, TmuxTopology } from "../../../desktop/src/tmux/tmux-shared";
import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS } from "../../../desktop/src/terminal-shared";
import { readTerminalTypography, readXtermTheme, applyTheme } from "../terminalTheme";
import { useAppSettings } from "../settings/appSettings";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { registerTerminalBrowserLinks } from "../browser/terminalBrowserLinks";
import { BrowserLinkMenu } from "../browser/browserLinks";
import type { TerminalSessions } from "../terminalSessions";

type PaneRect = Extract<TmuxLayoutNode, { type: "pane" }>;
export const tmuxLeaves = (node: TmuxLayoutNode): PaneRect[] => node.type === "pane" ? [node] : node.children.flatMap(tmuxLeaves);
export const tmuxPaneStyle = (pane: PaneRect, width: number, height: number): CSSProperties => ({ left: pane.x * width, top: pane.y * height, width: pane.cols * width, height: pane.rows * height });
type WindowInfo = TmuxTopology["windows"][number];
type Command = (action: TmuxAction) => Promise<void>;
type Divider = { pane: PaneRect; axis: "x" | "y"; x: number; y: number; cols: number; rows: number };
function dividers(node: TmuxLayoutNode): Divider[] {
  if (node.type === "pane") return [];
  return [...node.children.slice(0, -1).map(child => ({ pane: tmuxLeaves(child).at(-1)!, axis: node.type === "row" ? "x" as const : "y" as const, x: node.type === "row" ? child.x + child.cols : node.x, y: node.type === "column" ? child.y + child.rows : node.y, cols: node.type === "row" ? 1 : node.cols, rows: node.type === "column" ? 1 : node.rows })), ...node.children.flatMap(dividers)];
}

export function TmuxWindowView({ topology, window: info, store, active, demo, command }: { topology: TmuxTopology; window: WindowInfo; store: TerminalSessions; active: boolean; demo: boolean; command: Command }) {
  const { t } = useI18n(), { marks } = usePreviewMode();
  const { settings } = useAppSettings();
  const document = useSurfaceDocument();
  const container = useRef<HTMLDivElement>(null), measure = useRef<HTMLDivElement>(null);
  const send = useRef(command); send.current = command;
  const [cell, setCell] = useState({ width: 8, height: 16 });
  const [desired, setDesired] = useState({ cols: info.cols, rows: info.rows });
  const lastSize = useRef("");
  useEffect(() => {
    const node = container.current, measurement = measure.current;
    if (!node || !measurement || !active || demo) return;
    lastSize.current = "";
    const terminal = new Terminal({ ...readTerminalTypography(), lineHeight: 1.3, scrollback: 0, theme: readXtermTheme() });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(measurement);
    let frame = 0, disposed = false;
    const measureSize = () => {
      if (disposed || !node.clientWidth || !node.clientHeight) return;
      const size = fit.proposeDimensions();
      if (!size) return;
      const cols = Math.max(2, Math.min(TERMINAL_MAX_COLS, size.cols)), rows = Math.max(1, Math.min(TERMINAL_MAX_ROWS, size.rows));
      terminal.resize(cols, rows);
      const screen = measurement.querySelector<HTMLElement>(".xterm-screen");
      if (screen?.clientWidth && screen.clientHeight) setCell({ width: screen.clientWidth / cols, height: screen.clientHeight / rows });
      setDesired({ cols, rows });
      const key = `${cols}x${rows}`;
      if (lastSize.current !== key && topology.state === "attached") { lastSize.current = key; void send.current({ kind: "resizeWindow", windowId: info.id, cols, rows }); }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measureSize); };
    const observer = new ResizeObserver(schedule); observer.observe(node);
    schedule(); void document.fonts?.ready.then(schedule);
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); terminal.dispose(); };
  }, [active, demo, info.id, topology.state, settings.terminalFontFamily, settings.terminalFontSize, document]);
  const visible = tmuxLeaves(info.layout);
  const full = tmuxLeaves(info.fullLayout ?? info.layout);
  const limited = !demo && (info.cols < desired.cols || info.rows < desired.rows);
  return <div className="tmux-window" ref={container} hidden={!active} aria-label={info.name}>
    <div className="tmux-measure" ref={measure} aria-hidden="true" />
    {limited ? <span className="chip gray xs tmux-size-notice">{t("terminal.tmux.sizeLimited")}</span> : null}
    <div className="tmux-layout" style={{ width: info.cols * cell.width, height: info.rows * cell.height }}>
      {full.map(rect => {
        const pane = topology.panes[rect.paneId];
        if (!pane) return null;
        const shown = visible.find(item => item.paneId === rect.paneId);
        const geometry = shown ?? rect;
        return <div className={`tmux-pane${pane.active ? " is-active" : ""}`} key={pane.terminalId} hidden={!shown} data-pane-id={rect.paneId} style={tmuxPaneStyle(geometry, cell.width, cell.height)} onMouseDown={() => { if (topology.state === "attached" && !pane.active) void command({ kind: "selectPane", paneId: rect.paneId }); }}>
          {demo ? <div className="tmux-demo-pane"><span className="tmux-demo-title">{pane.title}</span>{marks ? <span>{t("terminal.tmux.demoPane")}</span> : null}</div>
            : pane.off ? <div className="tmux-pane-overlay">{t("terminal.tmux.off")}</div>
              : <TmuxPaneScreen store={store} terminalId={pane.terminalId} rect={geometry} selected={active && !!shown && pane.active} ended={topology.state !== "attached" || pane.dead} onFocus={() => { if (topology.state === "attached" && !pane.active) void command({ kind: "selectPane", paneId: rect.paneId }); }} />}
          {pane.paused ? <div className="tmux-pane-overlay" role="status">{t("terminal.tmux.paused")}</div> : null}
        </div>;
      })}
      {dividers(info.layout).map(divider => <TmuxDivider key={`${divider.pane.paneId}-${divider.axis}`} divider={divider} cell={cell} command={command} disabled={topology.state !== "attached"} />)}
    </div>
  </div>;
}

function TmuxDivider({ divider, cell, command, disabled }: { divider: Divider; cell: { width: number; height: number }; command: Command; disabled: boolean }) {
  const { t } = useI18n();
  const drag = useRef<{ origin: number; cells: number } | undefined>(undefined);
  const pending = useRef<number | undefined>(undefined); const frame = useRef(0); const send = useRef(command); send.current = command;
  const flush = () => { cancelAnimationFrame(frame.current); frame.current = 0; if (pending.current !== undefined) { void send.current({ kind: "resizePane", paneId: divider.pane.paneId, axis: divider.axis, cells: pending.current }); pending.current = undefined; } };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const horizontal = divider.axis === "x", cells = horizontal ? divider.pane.cols : divider.pane.rows;
  return <div role="separator" tabIndex={disabled ? -1 : 0} aria-label={t("terminal.tmux.resizePane")} aria-orientation={horizontal ? "vertical" : "horizontal"} aria-valuenow={cells} className={`tmux-divider ${horizontal ? "vertical" : "horizontal"}`} style={{ left: divider.x * cell.width, top: divider.y * cell.height, width: divider.cols * cell.width, height: divider.rows * cell.height }}
    onPointerDown={event => { if (disabled) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { origin: horizontal ? event.clientX : event.clientY, cells }; }}
    onPointerMove={event => { if (!drag.current) return; const delta = ((horizontal ? event.clientX : event.clientY) - drag.current.origin) / (horizontal ? cell.width : cell.height); pending.current = Math.max(1, Math.min(horizontal ? TERMINAL_MAX_COLS : TERMINAL_MAX_ROWS, drag.current.cells + Math.round(delta))); if (!frame.current) frame.current = requestAnimationFrame(flush); }}
    onPointerUp={() => { drag.current = undefined; flush(); }} onPointerCancel={() => { drag.current = undefined; pending.current = undefined; cancelAnimationFrame(frame.current); frame.current = 0; }}
    onKeyDown={event => { const direction = horizontal ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"]; const index = direction.indexOf(event.key); if (disabled || index < 0) return; event.preventDefault(); pending.current = Math.max(1, cells + (index ? 1 : -1)); flush(); }} />;
}

function TmuxPaneScreen({ store, terminalId, rect, selected, ended, onFocus }: { store: TerminalSessions; terminalId: string; rect: PaneRect; selected: boolean; ended: boolean; onFocus(): void }) {
  const element = useRef<HTMLDivElement>(null), hovered = useRef<string | null>(null);
  const [linkMenu, setLinkMenu] = useState<{ url: string; x: number; y: number }>();
  const document = useSurfaceDocument(), { settings } = useAppSettings();
  useEffect(() => {
    const node = element.current!;
    let host = store.hosts.get(terminalId);
    if (!host) {
      const term = new Terminal({ ...readTerminalTypography(), cols: rect.cols, rows: rect.rows, convertEol: false, lineHeight: 1.3, scrollback: 1000, theme: readXtermTheme(), allowProposedApi: false });
      term.open(node);
      term.onData(data => { void store.api?.write(terminalId, data); });
      host = { term }; store.attachHost(terminalId, host);
    } else if (host.term.element) { node.appendChild(host.term.element); host.term.open(node); }
    const links = registerTerminalBrowserLinks(host.term, url => { hovered.current = url; });
    const observer = new MutationObserver(() => applyTheme(host.term));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { links.dispose(); observer.disconnect(); };
  }, [store, terminalId, document]);
  useEffect(() => {
    const host = store.hosts.get(terminalId);
    if (!host) return;
    applyTheme(host.term); host.term.resize(rect.cols, rect.rows);
    host.term.options.disableStdin = ended; host.term.options.cursorBlink = !ended;
  }, [store, terminalId, rect.cols, rect.rows, ended, settings.terminalFontFamily, settings.terminalFontSize]);
  useEffect(() => { if (selected) store.hosts.get(terminalId)?.term.focus(); }, [store, terminalId, selected]);
  return <><div className="tmux-xterm" ref={element} onFocus={onFocus} onContextMenu={event => { if (hovered.current) { event.preventDefault(); setLinkMenu({ url: hovered.current, x: event.clientX, y: event.clientY }); } }} />{linkMenu ? <BrowserLinkMenu url={linkMenu.url} point={linkMenu} onClose={() => setLinkMenu(undefined)} /> : null}</>;
}
