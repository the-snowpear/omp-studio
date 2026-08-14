import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";
import type {
  AuthorityEpoch,
  AuthorityId,
  ClientBootstrap,
  ClientError,
  ClientEvent,
  ClientInteraction,
  CommandName,
  CommandInput,
  DiagnosticReadModel,
  EnvironmentReadModel,
  HomeReadModel,
  InteractionResponseValue,
  SessionHistoryEntry,
  SessionHistoryReadModel,
  StudioClient,
  Unsubscribe,
  WorkspaceId,
  WorkspaceListReadModel,
} from "@omp-studio/client-contract";
import type { ClientState } from "@omp-studio/client";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import type { OperatorCommandManifest } from "@omp-studio/studio-protocol";
import { AppIcon, Icon } from "./icons";
import { HomePage, SecondaryPage } from "./HomePage";
import { HistoryPage } from "./HistoryPage";
import { AgentHubPage, setHubIntent } from "./AgentHub";
import { CapabilitiesPage, setCapIntent, type CapTab } from "./CapabilitiesPage";
import { ModelConfigPage } from "./ModelConfigPage";
import { SettingsPage } from "./SettingsPage";
import { DiagnosticsPage } from "./DiagnosticsPage";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import { SkillsDrawer } from "./SkillsDrawer";
import { countEnabledDrawerItems, createPreviewDrawerItems } from "./skillsPreview";
import { pagePhaseClass, useDeferredKey } from "./pageTransition";
import { PreviewModeProvider, usePreviewMode } from "./preview/PreviewContext";
import { PREVIEW_MODE_SWITCH_ENABLED, readStoredPreviewMode } from "./preview/mode";
import {
  PREVIEW_PROJECTS,
  defaultPreviewSelection,
  findPreviewProject,
  findPreviewThread,
} from "./preview/fixtures";
import {
  PreviewChanges,
  PreviewContextPanel,
  PreviewContextTrigger,
  PreviewFileTree,
  PreviewLogs,
  PreviewMinimap,
  PreviewProblems,
  PreviewSideAgents,
  PreviewSidePreview,
  PreviewSwitch,
  PreviewTests,
  PreviewTokenPanel,
  PreviewTokenTrigger,
  PreviewTranscript,
} from "./preview/surfaces";

type Model = {
  environment?: EnvironmentReadModel;
  capabilities?: ClientBootstrap["capabilityManifest"];
  commandManifest?: OperatorCommandManifest;
  diagnostics?: DiagnosticReadModel;
  history?: SessionHistoryReadModel;
  home?: HomeReadModel;
  workspaces?: WorkspaceListReadModel;
};

type ClientStateSource = StudioClient & {
  getState?: () => ClientState;
  onState?: (listener: (state: ClientState) => void) => Unsubscribe;
};

type Route = "home" | "workbench" | "history" | "agent-hub" | "capabilities" | "model-config" | "settings" | "diagnostics";
type SecondaryRoute = Exclude<Route, "workbench">;

function isSecondary(route: Route): route is SecondaryRoute {
  return route === "home" || route === "history" || route === "agent-hub" || route === "capabilities" || route === "model-config" || route === "settings" || route === "diagnostics";
}

const SECONDARY_META: Record<SecondaryRoute, { title: string; icon: string }> = {
  home: { title: "首页", icon: "home" },
  history: { title: "会话历史与 Time Travel", icon: "history" },
  "agent-hub": { title: "Agent Hub", icon: "bot" },
  capabilities: { title: "能力中心", icon: "package" },
  "model-config": { title: "模型配置", icon: "server" },
  settings: { title: "设置", icon: "settings" },
  diagnostics: { title: "诊断中心", icon: "pulse" },
};

type ViewState = {
  loading: boolean;
  bootstrap?: ClientBootstrap;
  clientState?: ClientState;
  model: Model;
  error?: ClientError;
  hostError?: ClientError;
  events: ClientEvent[];
  route: Route;
};

type Action =
  | { type: "ready"; bootstrap: ClientBootstrap; clientState?: ClientState; hostError?: ClientError }
  | { type: "state"; clientState: ClientState }
  | { type: "model"; model: Model }
  | { type: "error"; error: ClientError }
  | { type: "event"; event: ClientEvent };

function reduce(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case "ready": {
      const { error: _clearedError, hostError: _clearedHostError, ...rest } = state;
      return { ...rest, loading: false, bootstrap: action.bootstrap, ...(action.hostError ? { hostError: action.hostError } : {}), ...(action.clientState ? { clientState: action.clientState } : {}) };
    }
    case "state":
      return { ...state, clientState: action.clientState };
    case "model":
      return { ...state, model: { ...state.model, ...action.model } };
    case "error":
      return { ...state, loading: false, error: action.error };
    case "event":
      return { ...state, events: [...state.events.slice(-199), action.event] };
  }
}

function unavailableBootstrap(): ClientBootstrap {
  return {
    contractVersion: CLIENT_CONTRACT_VERSION,
    authority: { authorityId: "desktop-unavailable" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
    runtime: { status: "unavailable", classification: "unavailable" },
    surface: { terminalAttach: false, fileReveal: false, previewInput: false, openExternal: false },
    capabilityManifest: { profile: "limited", generatedAt: "1970-01-01T00:00:00.000Z", hash: "unavailable", capabilities: [] },
    commandManifestHash: "unavailable",
    selected: {},
  };
}

function asError(cause: unknown): ClientError {
  const value = cause as { code?: unknown; message?: unknown } | null;
  if (value && typeof value.code === "string" && typeof value.message === "string") {
    return { code: value.code as ClientError["code"], message: value.message };
  }
  return {
    code: "TRANSPORT_ERROR",
    message: cause instanceof Error && cause.message ? cause.message : "Unknown client error",
  };
}

function snapshotFrom(state: ViewState): OperatorStateSnapshot | undefined {
  return state.clientState?.entities.snapshot ?? (state.bootstrap && "snapshot" in state.bootstrap ? state.bootstrap.snapshot : state.model.home?.snapshot);
}

function chipTone(value: string): "green" | "amber" | "red" {
  if (value.includes("connected") || value === "managed" || value === "completed") return "green";
  if (value.includes("reject") || value.includes("failed") || value === "error") return "red";
  return "amber";
}

function Chip({ children }: { children: ReactNode }) {
  return <span className={`chip ${chipTone(String(children))}`}>{children}</span>;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d`;
  return new Date(then).toLocaleDateString();
}

function runtimeStatusLabel(runtime?: ClientBootstrap["runtime"]): { text: string; tone: "ok" | "warn" | "err" } {
  const status = runtime?.status ?? "unavailable";
  if (status === "connected") return { text: "OMP Ready", tone: "ok" };
  if (status === "unavailable") return { text: "OMP Unavailable", tone: "err" };
  return { text: `OMP ${status}`, tone: "warn" };
}

type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";
type ShellDialog = "about" | "shortcuts";

function execEditCommand(command: EditCommand): void {
  try {
    document.execCommand(command);
  } catch {
    /* Chromium may reject an unsupported edit command; the focused field is unchanged. */
  }
}

function TitleMenu({ id, label, openId, onToggle, children }: {
  id: string;
  label: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  children: ReactNode;
}) {
  const open = openId === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setAnchor({ top: rect.bottom + 2, left: rect.left });
  }, [open]);

  return (
    <div className={`title-menu${open ? " open" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className="title-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onToggle(open ? null : id)}
      >
        {label}
      </button>
      {open
        ? createPortal(
            <div
              className="menu title-menu-popover"
              role="menu"
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function MenuItem({ icon, children, hint, disabled, title, current, onClick }: {
  icon?: string;
  children: ReactNode;
  hint?: string;
  disabled?: boolean;
  title?: string;
  current?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="menu-item"
      role="menuitem"
      disabled={disabled}
      title={title}
      aria-current={current ? "true" : undefined}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} extra="sm" /> : null}
      <span>{children}</span>
      {hint ? <span className="hint">{hint}</span> : null}
    </button>
  );
}

function CrumbMenu({ id, openId, onToggle, tip, current, children, menu }: {
  id: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  tip: string;
  current?: boolean;
  children: ReactNode;
  menu: ReactNode;
}) {
  const open = openId === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setAnchor({ top: rect.bottom + 4, left: rect.left });
  }, [open]);

  return (
    <div className="crumb-menu" onMouseDown={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className={`crumb-item${current ? " crumb-current" : ""}${open ? " open" : ""}`}
        data-tip={tip}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onToggle(open ? null : id)}
      >
        {children}
      </button>
      {open
        ? createPortal(
            <div
              className="menu title-menu-popover crumb-popover"
              role="menu"
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {menu}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

const CTX_PARTS: ReadonlyArray<{ name: string; color: string }> = [
  { name: "系统提示词", color: "#8a919c" },
  { name: "Skills", color: "#6e56cf" },
  { name: "对话历史", color: "#3b9bd4" },
  { name: "文件内容", color: "#d9930d" },
  { name: "工具定义", color: "#64748b" },
  { name: "子 Agent 汇总", color: "#2f9e6e" },
];

function AnchoredPop({ id, openId, onToggle, tip, label, align = "start", triggerClassName, popoverClassName, children, panel }: {
  id: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  tip: string;
  label: string;
  align?: "start" | "end";
  triggerClassName: string;
  popoverClassName?: string;
  children: ReactNode;
  panel: ReactNode;
}) {
  const open = openId === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const width = popRef.current?.offsetWidth ?? (align === "end" ? 360 : 240);
    const left = align === "end"
      ? Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
      : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setAnchor({ top: rect.bottom + 4, left });
  }, [align, open]);

  return (
    <div className="anchored-pop" onMouseDown={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className={`${triggerClassName}${open ? " open" : ""}`}
        data-tip={tip}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onToggle(open ? null : id)}
      >
        {children}
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className={`menu title-menu-popover${popoverClassName ? ` ${popoverClassName}` : ""}`}
              role="dialog"
              aria-label={label}
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {panel}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function Titlebar({
  canBack,
  canForward,
  onBack,
  onForward,
  onToggleSidebar,
  sidebarCollapsed,
  menus,
}: {
  canBack?: boolean;
  canForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onToggleSidebar?: () => void;
  sidebarCollapsed?: boolean;
  menus?: ReactNode;
}) {
  const previewMode = usePreviewMode();
  return (
    <header className="app-titlebar">
      <button
        className="icon-btn"
        data-tip={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
        aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
        aria-expanded={sidebarCollapsed === false}
        disabled={!onToggleSidebar}
        onClick={onToggleSidebar}
      >
        <Icon name="layout" />
      </button>
      <button className="icon-btn" data-tip="后退" aria-label="后退" disabled={!canBack} onClick={onBack}>
        <Icon name="arrow-l" />
      </button>
      <button className="icon-btn" data-tip="前进" aria-label="前进" disabled={!canForward} onClick={onForward}>
        <Icon name="arrow-r" />
      </button>
      <nav className="title-menus" aria-label="应用菜单">{menus}</nav>
      <div className="titlebar-end">
        <PreviewSwitch
          enabled={previewMode.enabled}
          preview={previewMode.preview}
          onToggle={() => previewMode.setPreview(!previewMode.preview)}
        />
      </div>
    </header>
  );
}

export function Unavailable() {
  return (
    <PreviewModeProvider>
      <div className="app">
        <Titlebar />
        <div className="main-col">
          <div className="empty" style={{ flex: 1, justifyContent: "center" }}>
            <Icon name="alert" extra="lg" />
            <h1>Studio client unavailable</h1>
            <p className="muted">Inject a StudioClient through the desktop shell or WebUI bridge.</p>
          </div>
        </div>
      </div>
    </PreviewModeProvider>
  );
}

function Deferred({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <Icon name="info" extra="lg" />
      <p>{title}</p>
      <p className="muted small">{detail}</p>
    </div>
  );
}

function InteractionPrompt({ interaction, onRespond, disabled }: { interaction: ClientInteraction; onRespond: (decision: "submit" | "cancel", value?: InteractionResponseValue) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const toggleOption = (optionId: string) => {
    if (disabled || interaction.kind !== "select") return;
    setSelected((previous) => interaction.multiple
      ? (previous.includes(optionId) ? previous.filter((id) => id !== optionId) : [...previous, optionId])
      : (previous.length === 1 && previous[0] === optionId ? [] : [optionId]));
  };
  const cancel = <button className="btn outline" disabled={disabled} onClick={() => onRespond("cancel")}>Cancel</button>;
  if (interaction.kind === "confirm") {
    return (
      <div className="approval-card">
        <div className="approval-head"><Icon name="alert" extra="sm" />Input required</div>
        <div className="approval-body">{interaction.message}</div>
        <div className="approval-foot"><button className="btn primary" disabled={disabled} onClick={() => onRespond("submit", true)}>Confirm</button>{cancel}</div>
      </div>
    );
  }
  if (interaction.kind === "select") {
    const canSubmit = interaction.multiple ? selected.length > 0 : selected.length === 1;
    return (
      <div className="ask-card">
        <div className="ask-head"><Icon name="message" extra="sm" />Input required</div>
        <div className="ask-body">
          <p className="muted small">Runtime requests select{interaction.multiple ? " (multiple)" : ""}.</p>
          {interaction.options.map((option) => (
            <button key={option.id} type="button" className={`ask-opt${selected.includes(option.id) ? " sel" : ""}`} aria-checked={selected.includes(option.id)} disabled={disabled} onClick={() => toggleOption(option.id)}>
              <span>{option.label}</span>
              {option.description ? <span className="muted small">{option.description}</span> : null}
            </button>
          ))}
        </div>
        <div className="approval-foot"><button className="btn primary" disabled={disabled || !canSubmit} onClick={() => onRespond("submit", interaction.multiple ? selected : selected[0])}>Submit</button>{cancel}</div>
      </div>
    );
  }
  if (interaction.kind === "input") {
    return (
      <div className="ask-card">
        <div className="ask-head"><Icon name="pencil" extra="sm" />Input required</div>
        <div className="ask-body">
          <input className="input" value={text} onChange={(event) => setText(event.target.value)} disabled={disabled} placeholder={interaction.placeholder ?? "Response"} type={interaction.secret ? "password" : "text"} />
        </div>
        <div className="approval-foot"><button className="btn primary" disabled={disabled || !text.trim()} onClick={() => onRespond("submit", text)}>Submit</button>{cancel}</div>
      </div>
    );
  }
  const note = interaction.kind === "editor" ? `Runtime requests editor${interaction.language ? ` (${interaction.language})` : ""}.` : `Runtime requests approval (${interaction.approvalType}).`;
  return (
    <div className="approval-card">
      <div className="approval-head"><Icon name="alert" extra="sm" />Input required</div>
      <div className="approval-body">
        <p>{note}</p>
        <p className="muted small">此交互类型未实现安全提交；请使用 Cancel 拒绝。</p>
      </div>
      <div className="approval-foot"><button className="btn" disabled title="此交互类型未实现安全提交">Submit</button>{cancel}</div>
    </div>
  );
}

function GenericCommandForm({ manifest, busy, enabled, onInvoke }: { manifest: OperatorCommandManifest; busy: boolean; enabled: boolean; onInvoke: (commandId: string, args?: unknown) => void }) {
  const [selected, setSelected] = useState("");
  const [args, setArgs] = useState("{}");
  const command = manifest.commands.find((entry) => entry.id === selected);
  return (
    <div className="generic-command">
      <div className="panel-head"><div><h2>Command form</h2><p className="muted">Manifest-driven operator entry; capability and Host validate the mutation.</p></div></div>
      <div className="actions">
        <select className="select" value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Select command</option>
          {manifest.commands.filter((entry) => entry.presentation === "generic-form" && entry.availability === "available").map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        <input className="input" value={args} onChange={(event) => setArgs(event.target.value)} aria-label="Command arguments JSON" placeholder="{}" />
        <button className="btn primary" disabled={!command || !enabled || busy} onClick={() => { try { onInvoke(command!.id, JSON.parse(args)); } catch { /* malformed JSON stays local */ } }}>Invoke</button>
      </div>
    </div>
  );
}

function VirtualEventTranscript({ events }: { events: ClientEvent[] }) {
  const [scrollTop, setScrollTop] = useState(0);
  const rowHeight = 32;
  const viewportHeight = 224;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 3);
  const visible = events.slice(start, start + Math.ceil(viewportHeight / rowHeight) + 6);
  return (
    <div className="event-transcript" style={{ height: viewportHeight }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <div style={{ height: events.length * rowHeight, position: "relative" }}>
        {visible.map((event, index) => {
          const actual = start + index;
          return <div className="event-row" key={`${event.cursor}-${event.kind}`} style={{ transform: `translateY(${actual * rowHeight}px)` }}><span className="mono event-cursor">{event.cursor}</span><span>{event.kind}</span><span className="muted">{event.occurredAt}</span></div>;
        })}
      </div>
    </div>
  );
}

const CURRENT_PROJECT = { id: "omp-studio", name: "OMP Studio" } as const;

type SelectedProject = { readonly id: string; readonly name: string };

type ShellChrome = {
  collapsed: boolean;
  skillsOpen: boolean;
  explorerOpen: boolean;
  theme: "light" | "dark";
  sidebarWidth: number;
  splitRatio: number;
  selectedHistoryId: string | null;
  selectedProject: SelectedProject | null;
  skillsEnabledCount: number;
  previewProjectId: string;
  previewThreadId: string;
  onToggleSidebar: () => void;
  onToggleSkills: () => void;
  onSkillsEnabledCount: (count: number) => void;
  onToggleExplorer: () => void;
  onToggleTheme: () => void;
  onResizeSidebar: (width: number) => void;
  onResizeSplit: (ratio: number) => void;
  onSelectProject: (project: SelectedProject) => void;
  onSelectThread: (entry: SessionHistoryEntry) => void;
  onSelectPreviewProject: (id: string) => void;
  onSelectPreviewThread: (id: string) => void;
  onPickProject: () => void;
  onOpenCapabilities: (tab?: CapTab, name?: string) => void;
  onToggleOmpMenu: () => void;
  ompMenuOpen: boolean;
};

function AppSidebar({ state, chrome, client, onRoute }: { state: ViewState; chrome: ShellChrome; client: StudioClient; onRoute: (route: Route) => void }) {
  const sidebarRef = useRef<HTMLElement>(null);
  const ompBtnRef = useRef<HTMLButtonElement>(null);
  const ompMenuRef = useRef<HTMLDivElement>(null);
  const [ompMenuPos, setOmpMenuPos] = useState<{ left: number; bottom?: number; top?: number }>({ left: 0, bottom: 0 });
  const runtime = state.clientState?.connection.runtime ?? state.bootstrap?.runtime;
  const history = state.model.history;
  const omp = runtimeStatusLabel(runtime);
  const { preview } = usePreviewMode();
  const ompConnected = runtime?.status === "connected";
  const ompVersion = runtime?.runtimeVersion ?? (preview ? "v0.82.1" : "—");
  const ompMeta = preview ? "rpc/2.1 · 演示" : (runtime?.classification ?? "unavailable");
  useLayoutEffect(() => {
    if (!chrome.ompMenuOpen || !ompBtnRef.current) return;
    const place = () => {
      const rect = ompBtnRef.current?.getBoundingClientRect();
      const menu = ompMenuRef.current;
      if (!rect) return;
      const pad = 8;
      const next: { left: number; bottom?: number; top?: number } = {
        left: rect.left,
        bottom: window.innerHeight - rect.top + 6,
      };
      if (menu) {
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        if (next.left + width > window.innerWidth - pad) {
          next.left = Math.max(pad, window.innerWidth - width - pad);
        }
        if (next.left < pad) next.left = pad;
        const top = window.innerHeight - (next.bottom ?? 0) - height;
        if (top < pad) {
          next.top = pad;
          delete next.bottom;
        }
      }
      setOmpMenuPos(next);
    };
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [chrome.ompMenuOpen]);
  useEffect(() => {
    if (!chrome.ompMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (ompBtnRef.current?.contains(target) || ompMenuRef.current?.contains(target)) return;
      chrome.onToggleOmpMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") chrome.onToggleOmpMenu();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [chrome.ompMenuOpen, chrome.onToggleOmpMenu]);
  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const pinDrawer = () => {
      const topBar = sidebar.querySelector(".sb-top");
      const foot = sidebar.querySelector(".sb-footer");
      if (!(topBar instanceof HTMLElement) || !(foot instanceof HTMLElement)) return;
      const box = sidebar.getBoundingClientRect();
      const top = topBar.getBoundingClientRect();
      const bottom = foot.getBoundingClientRect();
      sidebar.style.setProperty("--drawer-top", `${Math.max(0, Math.round(top.bottom - box.top))}px`);
      sidebar.style.setProperty("--drawer-bottom", `${Math.max(0, Math.round(box.bottom - bottom.top))}px`);
    };
    pinDrawer();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(pinDrawer);
    observer?.observe(sidebar);
    window.addEventListener("resize", pinDrawer);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", pinDrawer);
    };
  }, [chrome.skillsOpen, chrome.collapsed, chrome.sidebarWidth]);
  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (chrome.collapsed) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const handle = event.currentTarget;
    const sidebar = handle.closest(".sidebar");
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = chrome.sidebarWidth;
    document.body.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";
    let latest = startWidth;
    const apply = (width: number) => {
      latest = width;
      if (sidebar instanceof HTMLElement) sidebar.style.width = `${width}px`;
      document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
    };
    const move = (next: PointerEvent) => {
      next.preventDefault();
      apply(Math.min(400, Math.max(200, startWidth + next.clientX - startX)));
    };
    const up = () => {
      document.body.classList.remove("is-resizing");
      document.body.style.cursor = "";
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      chrome.onResizeSidebar(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const onSplitPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!chrome.explorerOpen) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const handle = event.currentTarget;
    const sidebar = handle.closest(".sidebar");
    if (!(sidebar instanceof HTMLElement)) return;
    const projects = sidebar.querySelector("#sbProjects");
    const files = sidebar.querySelector("#sbFiles");
    if (!(projects instanceof HTMLElement) || !(files instanceof HTMLElement)) return;
    const top = projects.getBoundingClientRect().top;
    const span = files.getBoundingClientRect().bottom - top;
    if (span <= 0) return;
    handle.classList.add("dragging");
    sidebar.classList.add("sb-splitting");
    handle.setPointerCapture(event.pointerId);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.classList.add("is-resizing");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    let latest = chrome.splitRatio;
    const apply = (ratio: number) => {
      latest = ratio;
      projects.style.flex = `1 1 ${(ratio * 100).toFixed(3)}%`;
      files.style.flex = `1 1 ${((1 - ratio) * 100).toFixed(3)}%`;
      handle.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    };
    const move = (next: PointerEvent) => {
      next.preventDefault();
      apply(Math.min(0.85, Math.max(0.15, (next.clientY - top) / span)));
    };
    const up = () => {
      handle.classList.remove("dragging");
      sidebar.classList.remove("sb-splitting");
      document.body.classList.remove("is-resizing");
      projects.style.flex = "";
      files.style.flex = "";
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      chrome.onResizeSplit(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const projectShare = chrome.splitRatio * 100;
  const fileShare = 100 - projectShare;
  return (
    <aside ref={sidebarRef} className={`sidebar${chrome.collapsed ? " collapsed" : ""}${chrome.explorerOpen ? "" : " explorer-collapsed"}`} id="sidebar" aria-label="项目与文件侧栏" style={{ width: chrome.sidebarWidth }}>
      <div className="sidebar-resizer" id="sbResizer" role="separator" aria-orientation="vertical" aria-label="调整侧栏宽度" tabIndex={0} onPointerDown={onResizePointerDown} />
      <div className="sb-top">
        <button className="icon-btn" data-tip="应用菜单" aria-label="应用菜单" disabled title="应用菜单不在公共 contract 中"><Icon name="menu" /></button>
        <button className="sb-brand" data-tip="项目主页" onClick={() => onRoute("home")}>
          <AppIcon className="logo" size={22} />
          <span className="name">OMP Studio</span>
        </button>
        <button className="icon-btn" data-tip="统一搜索 (Ctrl K)" aria-label="搜索会话" onClick={() => onRoute("history")}><Icon name="search" /></button>
      </div>
      <div className="sb-actions">
        <button className="action-row new-convo-btn" aria-label="新建对话" onClick={() => {
          if (preview) {
            chrome.onSelectPreviewProject(chrome.previewProjectId);
            onRoute("workbench");
            return;
          }
          const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
          if (active) {
            chrome.onSelectProject({ id: active.workspaceId, name: active.name });
            onRoute("workbench");
          } else {
            chrome.onPickProject();
          }
        }}>
          <Icon name="plus" />
          <span className="lbl">新建对话</span>
          <span className="meta"><span className="hint">Ctrl ⇧ O</span></span>
        </button>
        <button className="action-row skills-btn" aria-label="技能与插件" aria-expanded={chrome.skillsOpen} aria-controls="skillsDrawer" onClick={chrome.onToggleSkills}>
          <Icon name="layers" />
          <span className="lbl">技能 & 插件</span>
          <span className="meta"><span className="count">{chrome.skillsEnabledCount}</span><Icon name="chevron-r" extra="sm chev" /></span>
        </button>
      </div>
      <section className="sb-section" id="sbProjects" aria-labelledby="sbProjectsTitle" style={{ ["--sb-proj-basis" as string]: `${projectShare.toFixed(3)}%` }}>
        <div className="sb-section-head">
          <h2 id="sbProjectsTitle">项目与对话</h2>
          <div className="sb-head-actions">
            <button className="icon-btn" data-tip="新建项目" disabled title="新建项目不在公共 contract 中"><Icon name="plus" extra="sm" /></button>
          </div>
        </div>
        <div className="sb-scroll" id="projectList">
          {preview ? PREVIEW_PROJECTS.map((project) => {
            const open = chrome.previewProjectId === project.id;
            return (
              <div className="project" key={project.id}>
                <button className="project-head" type="button" onClick={() => chrome.onSelectPreviewProject(project.id)}>
                  <span className="tw"><Icon name={open ? "chevron-d" : "chevron-r"} extra="sm" /></span>
                  <span className="p-name">{project.name}</span>
                  <span className="project-flags">
                    {project.running ? <span className="dot green pulse" aria-hidden="true" /> : null}
                    {project.dirty > 0 ? <span className="muted tiny">{project.dirty}</span> : null}
                  </span>
                </button>
                {open ? project.threads.map((thread) => (
                  <button
                    key={thread.id}
                    className={`thread${chrome.previewThreadId === thread.id ? " active" : ""}`}
                    onClick={() => chrome.onSelectPreviewThread(thread.id)}
                  >
                    <span className="t-title ellipsis">{thread.title}</span>
                    <span className="t-meta">{thread.time}</span>
                  </button>
                )) : null}
              </div>
            );
          }) : state.model.workspaces && state.model.workspaces.workspaces.length ? (
            state.model.workspaces.workspaces.map((workspace) => {
              const open = chrome.selectedProject?.id === workspace.workspaceId;
              return (
                <div className="project" key={workspace.workspaceId}>
                  <button className="project-head" type="button" onClick={() => chrome.onSelectProject({ id: workspace.workspaceId, name: workspace.name })}>
                    <span className="tw"><Icon name={open ? "chevron-d" : "chevron-r"} extra="sm" /></span>
                    <span className="p-name ellipsis">{workspace.name}</span>
                    <span className="project-flags">
                      {workspace.active ? <span className="chip gray xs">当前</span> : null}
                      {open ? <span className="muted tiny">{history?.total ?? 0}</span> : null}
                    </span>
                  </button>
                  {open ? (history?.entries ?? []).slice(0, 12).map((entry) => (
                    <button
                      key={entry.historyId}
                      className={`thread${chrome.selectedHistoryId === entry.historyId ? " active" : ""}`}
                      onClick={() => chrome.onSelectThread(entry)}
                    >
                      <span className="t-title ellipsis">{entry.title}</span>
                      <span className="t-meta">{relativeTime(entry.lastActiveAt)}</span>
                    </button>
                  )) : null}
                  {open && !history?.entries.length ? <div className="empty" style={{ padding: "16px 8px" }}><p className="muted small">暂无会话</p></div> : null}
                </div>
              );
            })
          ) : (
            <div className="project">
              <div className="empty" style={{ padding: "16px 8px" }}>
                <p className="muted small">暂无项目</p>
                <button className="btn small outline" type="button" onClick={chrome.onPickProject}>
                  <Icon name="folder-open" extra="sm" />打开本地文件夹
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
      <div
        className="sb-divider"
        id="sbDivider"
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label="调整 Explorer 高度"
        aria-valuemin={15}
        aria-valuemax={85}
        aria-valuenow={Math.round(projectShare)}
        onPointerDown={onSplitPointerDown}
        onDoubleClick={() => chrome.onResizeSplit(0.5)}
        onKeyDown={(event) => {
          if (!chrome.explorerOpen) return;
          const step = event.shiftKey ? 0.15 : 0.05;
          if (event.key === "ArrowUp") { event.preventDefault(); chrome.onResizeSplit(Math.max(0.15, chrome.splitRatio - step)); }
          else if (event.key === "ArrowDown") { event.preventDefault(); chrome.onResizeSplit(Math.min(0.85, chrome.splitRatio + step)); }
          else if (event.key === "Home") { event.preventDefault(); chrome.onResizeSplit(0.15); }
          else if (event.key === "End") { event.preventDefault(); chrome.onResizeSplit(0.85); }
        }}
      />
      <section className={`sb-section${chrome.explorerOpen ? "" : " collapse"}`} id="sbFiles" aria-labelledby="sbFilesTitle" style={{ ["--sb-files-basis" as string]: `${fileShare.toFixed(3)}%` }}>
        <div className="sb-section-head">
          <h2 id="sbFilesTitle">Explorer</h2>
          <div className="sb-head-actions">
            <button className="icon-btn" data-tip="新建文件" disabled title="文件树不在公共 contract 中"><Icon name="plus" extra="sm" /></button>
            <button className="icon-btn" data-tip="新建目录" disabled title="文件树不在公共 contract 中"><Icon name="folder" extra="sm" /></button>
            <button className="icon-btn" data-tip="搜索文件" disabled title="文件树不在公共 contract 中"><Icon name="search" extra="sm" /></button>
            <button className="icon-btn" data-tip="刷新" disabled title="文件树不在公共 contract 中"><Icon name="refresh" extra="sm" /></button>
          </div>
          <button className={`icon-btn sb-collapse-btn${chrome.explorerOpen ? "" : " is-collapsed"}`} aria-label={chrome.explorerOpen ? "收起 Explorer" : "展开 Explorer"} aria-expanded={chrome.explorerOpen} onClick={chrome.onToggleExplorer}>
            <Icon name="chevron-d" extra="sm" />
          </button>
        </div>
        <div className="sb-scroll">
          {preview ? (
            <PreviewFileTree label={findPreviewProject(chrome.previewProjectId)?.name ?? "项目"} />
          ) : chrome.selectedProject ? (
            <div className="tree" role="tree" aria-label={`${chrome.selectedProject.name} 文件树`}>
              <div className="tree-row open" data-dir role="treeitem" aria-expanded="true" tabIndex={0}>
                <span className="tw"><Icon name="chevron-d" extra="sm" /></span>
                <span className="fi"><Icon name="folder-open" /></span>
                <span className="fname ellipsis">{chrome.selectedProject.name}</span>
              </div>
            </div>
          ) : (
            <div className="empty">暂无选择项目</div>
          )}
        </div>
      </section>
      <SkillsDrawer
        open={chrome.skillsOpen}
        client={client}
        onClose={chrome.onToggleSkills}
        onEnabledCountChange={chrome.onSkillsEnabledCount}
        onOpenHub={(intent) => chrome.onOpenCapabilities(intent?.tab, intent?.name)}
      />
      <footer className="sb-footer">
        <button
          ref={ompBtnRef}
          type="button"
          className="sb-user"
          aria-label="Studio · OMP 状态与环境菜单"
          aria-haspopup="menu"
          aria-expanded={chrome.ompMenuOpen}
          onClick={chrome.onToggleOmpMenu}
        >
          <span className="avatar" aria-hidden="true">S</span>
          <span>
            <span className="u-name">Studio</span>
            <span className={`u-status ${omp.tone}`} role="status" aria-live="polite">
              <span className={`dot ${omp.tone === "ok" ? "green" : omp.tone === "err" ? "red" : "amber"}${omp.tone === "ok" ? " pulse" : ""}`} aria-hidden="true" />
              <span>{omp.text}</span>
            </span>
          </span>
          <Icon name="chevron-ud" extra="sm" />
        </button>
      </footer>
      {chrome.ompMenuOpen
        ? createPortal(
            <div
              ref={ompMenuRef}
              className="menu title-menu-popover omp-menu"
              role="menu"
              aria-label="OMP 状态与环境"
              style={{
                position: "fixed",
                left: ompMenuPos.left,
                ...(ompMenuPos.top !== undefined ? { top: ompMenuPos.top } : { bottom: ompMenuPos.bottom }),
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <div className="omp-menu-head">
                <span className="logo" aria-hidden="true">π</span>
                <div>
                  <div style={{ fontWeight: "var(--fw-semibold)" }}>OMP</div>
                  <div className="v">
                    <span style={{ color: ompConnected ? "var(--green)" : "var(--red)" }}>
                      {ompConnected ? "Ready" : "Disconnected"}
                    </span>
                    {` · ${ompVersion} · ${ompMeta}`}
                  </div>
                </div>
              </div>
              {!ompConnected ? (
                <div className="omp-menu-err">
                  <Icon name="alert" extra="sm" />
                  <span>{state.hostError?.message ?? "Runtime 未连接。"}</span>
                </div>
              ) : null}
              <div className="menu-sep" />
              <MenuItem icon="refresh" disabled title="重启 Bridge 不在公共 contract 中">重启 OMP Bridge</MenuItem>
              <MenuItem icon="pulse" onClick={() => { chrome.onToggleOmpMenu(); onRoute("diagnostics"); }}>重新检测 OMP</MenuItem>
              <MenuItem icon="wrench" onClick={() => { chrome.onToggleOmpMenu(); onRoute("model-config"); }}>打开 OMP 配置</MenuItem>
              <MenuItem icon="pulse" onClick={() => { chrome.onToggleOmpMenu(); onRoute("diagnostics"); }}>打开诊断中心</MenuItem>
              <MenuItem icon="update" disabled title="检查更新不在公共 contract 中" {...(preview ? { hint: "v0.82.2 可用" } : {})}>检查更新</MenuItem>
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
}

function AppTopbar({ state, chrome, onRoute, threadTitle, sideOpen, onToggleSide }: {
  state: ViewState;
  chrome: ShellChrome;
  onRoute: (route: Route) => void;
  threadTitle: string;
  sideOpen: boolean;
  onToggleSide: () => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const unavailable = "不在公共 contract 中";
  const { preview } = usePreviewMode();
  const previewProject = findPreviewProject(chrome.previewProjectId);
  const previewHit = findPreviewThread(chrome.previewThreadId);
  const realActiveWorkspace = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
  const crumbProject = preview
    ? (previewProject?.name ?? "omp-web")
    : (realActiveWorkspace?.name ?? "未选择项目");
  const crumbBranch = preview ? (previewProject?.branch ?? "main") : "—";
  const crumbThread = preview ? (previewHit?.thread.title ?? threadTitle) : threadTitle;

  useEffect(() => {
    if (openMenu === null) return;
    const close = () => setOpenMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  const run = (action?: () => void) => {
    setOpenMenu(null);
    action?.();
  };

  return (
    <header className="topbar">
      <div className="tb-left">
        <nav className="tb-crumb" aria-label="当前位置">
          <CrumbMenu
            id="project"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="切换项目"
            menu={
              <>
                <div className="menu-label">切换项目</div>
                {preview ? PREVIEW_PROJECTS.map((project) => (
                  <MenuItem
                    key={project.id}
                    icon="folder-open"
                    current={project.id === chrome.previewProjectId}
                    hint={project.id === chrome.previewProjectId ? "当前" : project.branch}
                    onClick={() => run(() => chrome.onSelectPreviewProject(project.id))}
                  >
                    {project.name}
                  </MenuItem>
                )) : (
                  <>
                    {(state.model.workspaces?.workspaces ?? []).map((workspace) => (
                      <MenuItem
                        key={workspace.workspaceId}
                        icon="folder-open"
                        current={workspace.active}
                        {...(workspace.active ? { hint: "当前" } : {})}
                        onClick={() => run(() => chrome.onSelectProject({ id: workspace.workspaceId, name: workspace.name }))}
                      >
                        {workspace.name}
                      </MenuItem>
                    ))}
                    {!state.model.workspaces?.workspaces.length ? (
                      <MenuItem icon="folder-open" disabled title="暂无项目，请先打开本地文件夹">暂无项目</MenuItem>
                    ) : null}
                  </>
                )}
                <div className="menu-sep" />
                <MenuItem icon="external" disabled title={`在外部编辑器中打开项目：${unavailable}`}>在外部编辑器中打开项目</MenuItem>
                <MenuItem icon="terminal" disabled title={`在终端中打开：${unavailable}`}>在终端中打开</MenuItem>
                <MenuItem icon="folder-open" disabled title={`打开项目目录：${unavailable}`}>打开项目目录</MenuItem>
                <div className="menu-sep" />
                <MenuItem icon="home" onClick={() => run(() => onRoute("home"))}>项目主页</MenuItem>
              </>
            }
          >
            <Icon name="folder-open" extra="sm" />
            <span>{crumbProject}</span>
            <Icon name="chevron-d" extra="sm crumb-chevron" />
          </CrumbMenu>
          <span className="crumb-sep" aria-hidden="true">›</span>
          <CrumbMenu
            id="branch"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="查看分支详情"
            menu={
              <>
                <div className="branch-menu-head">
                  <div className="bmh-title"><Icon name="branch" extra="sm" /><b>{crumbBranch}</b></div>
                  <div className="bmh-meta">{preview ? `${previewProject?.dirty ?? 0} 个未提交 · 演示` : "Git 分支不在公共 contract 中"}</div>
                </div>
                <MenuItem icon="commit" disabled title={`未提交修改：${unavailable}`}>未提交修改</MenuItem>
                <div className="menu-sep" />
                <MenuItem icon="columns" disabled title={`Changes：${unavailable}`}>查看 Changes</MenuItem>
                <MenuItem icon="commit" disabled title={`创建 Commit：${unavailable}`}>创建 Commit</MenuItem>
                <MenuItem icon="branch" disabled title={`切换分支：${unavailable}`}>切换分支</MenuItem>
                <MenuItem icon="worktree" disabled title={`新建 Worktree：${unavailable}`}>新建 Worktree</MenuItem>
              </>
            }
          >
            <Icon name="branch" extra="sm" />
            <span>{crumbBranch}</span>
          </CrumbMenu>
          <span className="crumb-sep" aria-hidden="true">›</span>
          <CrumbMenu
            id="thread"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="对话选项"
            current
            menu={
              <>
                <MenuItem icon="pencil" disabled title={`重命名对话：${unavailable}`}>重命名对话</MenuItem>
                <MenuItem icon="fork" disabled title={`Fork 当前对话：${unavailable}`}>Fork 当前对话</MenuItem>
                <MenuItem icon="handoff" disabled title={`Handoff 到新对话：${unavailable}`}>Handoff 到新对话</MenuItem>
                <div className="menu-sep" />
                <MenuItem icon="minimize" disabled title={`Compact：${unavailable}`}>Compact 当前上下文</MenuItem>
                <MenuItem icon="export" disabled title={`导出对话：${unavailable}`}>导出对话</MenuItem>
                <div className="menu-sep" />
                <MenuItem icon="history" onClick={() => run(() => onRoute("history"))}>会话历史</MenuItem>
                <MenuItem icon="archive" disabled title={`归档：${unavailable}`}>归档</MenuItem>
              </>
            }
          >
            <span className="ellipsis" title={crumbThread}>{crumbThread}</span>
            <Icon name="chevron-d" extra="sm crumb-chevron" />
          </CrumbMenu>
        </nav>
        <button className="icon-btn" data-tip="Fork 对话" disabled title="Fork 不在公共 contract 中"><Icon name="fork" /></button>
        <button className="icon-btn" data-tip="Handoff 到新 Thread" disabled title="Handoff 不在公共 contract 中"><Icon name="handoff" /></button>
      </div>
      <button className="icon-btn lg" data-tip="Agent Hub" aria-label="Agent Hub" onClick={() => onRoute("agent-hub")}><Icon name="bot" extra="lg" /></button>
      <button className="icon-btn" data-tip="会话历史" aria-label="会话历史" onClick={() => onRoute("history")}><Icon name="history" /></button>
      <div className="tb-right">
        <div className="telemetry">
          <AnchoredPop
            id="tokens"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="输入 / 输出 Token 详情"
            label="Token 用量详情"
            align="end"
            triggerClassName="t-group"
            popoverClassName="telemetry-pop tok-pop"
            panel={preview ? <PreviewTokenPanel /> : (
              <>
                <div className="tp-head"><Icon name="zap" extra="sm" />Token 用量<span className="spacer" /><span className="chip gray xs">不可用</span></div>
                <div className="tok-hero">
                  <div className="th-cell">
                    <div className="th-k">总消耗</div>
                    <div className="th-v">—</div>
                    <div className="th-sub">本轮 —</div>
                  </div>
                  <div className="th-cell">
                    <div className="th-k">Cost</div>
                    <div className="th-v">—</div>
                    <div className="th-sub">缓存已省 <b>—</b></div>
                  </div>
                </div>
                <div className="tok-split">
                  <div className="ts-top"><span>构成</span><b>— 入 / — 出</b></div>
                  <div className="tok-bar"><i className="tb-none" /></div>
                  <div className="tok-keys">
                    <span><i className="tb-in" />输入</span>
                    <span><i className="tb-out" />输出</span>
                    <span><i className="tb-cache" />缓存 —</span>
                  </div>
                </div>
                <div className="tok-rows">
                  <div className="tr-row">本轮输入 / 输出<span className="tr-v dim">—</span></div>
                  <div className="tr-row">本轮耗时<span className="tr-v dim">—</span></div>
                  <div className="tr-row">会话总耗时<span className="tr-v dim">—</span></div>
                  <div className="tr-row">子 Agent 消耗<span className="tr-v dim">—</span></div>
                  <div className="tr-row">重试 / Fallback<span className="tr-v dim">—</span></div>
                </div>
                <div className="tp-ctx">
                  <div className="tiny muted">公共 contract 不暴露 token 用量、成本与缓存命中。</div>
                </div>
              </>
            )}
          >
            {preview ? <PreviewTokenTrigger /> : (
              <>
                <span className="t-item"><Icon name="arrow-u" extra="sm" /><b>—</b></span>
                <span className="t-item"><Icon name="arrow-d" extra="sm" /><b>—</b></span>
                <span className="t-sep" aria-hidden="true" />
                <span className="t-item"><b>—</b>&nbsp;cache</span>
              </>
            )}
          </AnchoredPop>
          <span className="t-sep" aria-hidden="true" />
          <AnchoredPop
            id="context"
            openId={openMenu}
            onToggle={setOpenMenu}
            tip="Context 构成"
            label="Context 构成详情"
            align="end"
            triggerClassName="t-group"
            popoverClassName="telemetry-pop ctx-pop"
            panel={preview ? <PreviewContextPanel /> : (
              <>
                <div className="tp-head"><Icon name="layers" extra="sm" />CONTEXT 构成<span className="spacer" /><span className="chip gray xs">—</span></div>
                <div className="tp-ctx" style={{ paddingTop: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span>已使用</span>
                    <b className="mono" style={{ fontSize: 13 }}>— / —</b>
                  </div>
                  <div className="ctxbar"><i className="cb-none" /></div>
                  <div className="ctx-legend">
                    {CTX_PARTS.map((part) => (
                      <div key={part.name} className="cl-row">
                        <span className="cl-dot" style={{ background: part.color }} />
                        <span>{part.name}</span>
                        <span className="cl-v">—</span>
                      </div>
                    ))}
                  </div>
                  <div className="tiny muted" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    Compact：— · 公共 contract 无 context 构成 read model
                  </div>
                </div>
              </>
            )}
          >
            {preview ? <PreviewContextTrigger /> : (
              <>
                <span className="ctx-ring" style={{ ["--p" as string]: 0 }} aria-hidden="true" />
                <span className="t-item"><b>—</b></span>
              </>
            )}
          </AnchoredPop>
          <span className="t-sep" aria-hidden="true" />
          <span className="t-item"><b>auto</b>&nbsp;compact</span>
          <button className="tb-compact" disabled title="Compact 不在公共 contract 中">
            <Icon name="minimize" extra="sm" />Compact
          </button>
        </div>
        <button className={`icon-btn${sideOpen ? " active" : ""}`} data-tip="展开 / 收起右侧面板" aria-controls="sidePanel" aria-expanded={sideOpen} onClick={onToggleSide}><Icon name="panel" /></button>
        <button className="icon-btn" data-tip="切换 Light / Dark" onClick={chrome.onToggleTheme} aria-label="切换主题">
          <Icon name={chrome.theme === "dark" ? "moon" : "light"} />
        </button>
        <button className="icon-btn" data-tip="项目主页" onClick={() => onRoute("home")}><Icon name="home" /></button>
      </div>
    </header>
  );
}

function WorkbenchCanvas({ state, client, sideOpen, onCloseSide, bottomOpen, onBottomOpenChange, onRoute }: {
  state: ViewState;
  client: ClientStateSource;
  sideOpen: boolean;
  onCloseSide: () => void;
  bottomOpen: boolean;
  onBottomOpenChange: (open: boolean) => void;
  onRoute: (route: Route) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sideTab, setSideTab] = useState<"changes" | "preview" | "agents">("changes");
  const [bottomTab, setBottomTab] = useState<"terminal" | "problems" | "tests" | "output" | "logs" | "pvlogs">("logs");
  const terminalRef = useRef<TerminalPaneHandle>(null);
  const terminalAvailable = typeof globalThis.ompStudioTerminal !== "undefined";
  const { preview } = usePreviewMode();
  const snapshot = snapshotFrom(state);
  const connection = state.clientState?.connection;
  const runtime = connection?.runtime ?? state.bootstrap?.runtime;
  const commands = state.clientState?.commands ?? {};
  const pendingInteraction = Object.values(commands).find((command) => command.status === "interaction_required");
  const capabilities = state.model.capabilities ?? state.bootstrap?.capabilityManifest;
  const commandManifest = state.model.commandManifest;
  const capabilityById = useMemo(() => new Map((capabilities?.capabilities ?? []).map((capability) => [capability.id, capability])), [capabilities]);
  const can = (id: string) => {
    const entry = capabilityById.get(id);
    if (!entry || entry.grade === "unavailable") return false;
    if (connection?.resyncRequired) return false;
    if (runtime?.classification === "limited-system") return false;
    return true;
  };
  const run = useCallback(async <T extends CommandName>(name: T, input: CommandInput<T>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      await client.command(name, input);
      return true;
    } catch { return false; } finally { setBusy(false); }
  }, [busy, client]);
  const respond = useCallback((decision: "submit" | "cancel", value?: InteractionResponseValue) => {
    if (!pendingInteraction || pendingInteraction.status !== "interaction_required") return;
    void run("interaction.respond", { interactionId: pendingInteraction.interaction.interactionId, decision, ...(value === undefined ? {} : { value }) });
  }, [pendingInteraction, run]);
  const commandRows = useMemo(() => Object.values(commands).slice(-20).reverse(), [commands]);
  const runtimeConnected = runtime?.status === "connected";
  const snapshotReady = snapshot !== undefined;
  const gated = busy || Boolean(connection?.resyncRequired) || !runtimeConnected || !snapshotReady;
  const interactionDisabled = gated || !can("interaction.respond");
  const textReady = text.trim().length > 0;
  const canSend = textReady && !gated;
  const abortEligible = Boolean(snapshot?.isStreaming) || (snapshot?.pendingMessages ?? 0) > 0;
  const running = Boolean(snapshot?.isStreaming);
  const dispatchText = async (name: "core.prompt" | "core.steer" | "core.followUp" | "queue.enqueue") => {
    if (!canSend || !can(name)) return;
    const accepted = await run(name, { text: text.trim() });
    if (accepted) setText("");
  };
  const marks = state.events.slice(-24);

  return (
    <>
      <div className={`workbench${sideOpen ? " split-right" : ""}`} id="workbench">
        <div className="convo-wrap">
          <main className="convo-scroll" id="convoScroll" tabIndex={-1} aria-label="对话内容">
            <div className="convo-doc" id="convoDoc" role="log" aria-live="polite" aria-relevant="additions">
              {preview ? (
                <PreviewTranscript />
              ) : pendingInteraction?.status === "interaction_required" ? (
                <InteractionPrompt interaction={pendingInteraction.interaction} onRespond={respond} disabled={interactionDisabled} />
              ) : (
                <div className="empty" style={{ paddingTop: 72 }}>
                  <Icon name="message" extra="lg" />
                  <p>开始一段对话</p>
                  <p className="muted small">公共 contract 不暴露消息 transcript。语义事件显示在底部 OMP Logs。</p>
                </div>
              )}
            </div>
          </main>
          <div className="minimap" id="minimap">
            <div className="minimap-track" id="mmTrack" aria-hidden="true">
              <span className="mm-rail" />
              {preview ? <PreviewMinimap /> : marks.map((event, index, events) => (
                <span key={event.cursor} className="mm-mark" style={{ top: `${14 + (index / Math.max(1, events.length - 1)) * 72}%` }} />
              ))}
            </div>
            <div className="mm-viewport" id="mmViewport" aria-hidden="true" />
            <div className="minimap-tools">
              <button className="icon-btn" data-tip="筛选事件" disabled title="Minimap 筛选不在公共 contract 中"><Icon name="filter" extra="sm" /></button>
              <button className="icon-btn" data-tip="回到最新" onClick={() => document.getElementById("convoScroll")?.scrollTo({ top: 9e6, behavior: "smooth" })}><Icon name="arrow-d" extra="sm" /></button>
            </div>
          </div>
          <div className="composer-region">
            <div className={`ctx-strip${running ? " hidden" : ""}`} role="status" aria-live="polite">
              <span className="ctx-item"><Icon name="folder-open" extra="sm" /><span>{preview ? "omp-web" : (state.model.workspaces?.workspaces.find((workspace) => workspace.active)?.name ?? "未选择项目")}</span></span>
              <span className="ctx-item"><Icon name="cpu" extra="sm" /><span>{preview ? "gemini-3.6-flash" : (runtime?.classification ?? "runtime unavailable")}</span></span>
              <span className="ctx-item muted"><Icon name="branch" extra="sm" /><span>{preview ? "main" : "—"}</span></span>
              <span className="spacer" />
              <span className="ctx-item muted"><Icon name="file" extra="sm" />{preview ? "18 个文件" : "文件树不可用"}</span>
            </div>
            <div className={`run-strip${running ? "" : " hidden"}`} role="status" aria-live="polite">
              <span className="rs-label st-running"><span className="spinner" aria-hidden="true" />{snapshot?.isStreaming ? "Run 进行中" : "Queued"}</span>
              <span className="muted small">{snapshot ? `${snapshot.activeMode} · ${snapshot.pendingMessages} pending` : "No Runtime snapshot."}</span>
              <span className="spacer" />
              {snapshot && snapshot.pendingMessages > 0 && <span className="fq-chip"><Icon name="queue" extra="sm" />Follow-up ×{snapshot.pendingMessages}</span>}
              <button className="btn small outline" disabled={!canSend || !can("core.steer")} onClick={() => void dispatchText("core.steer")}><Icon name="steering" extra="sm" />Steering</button>
              <button className="btn small danger" disabled={gated || !abortEligible || !can("core.abort")} onClick={() => void run("core.abort", {})}><Icon name="stop" extra="sm" />Abort</button>
            </div>
            <div className={`composer${running ? " running" : ""}`} id="composer">
              <div className="composer-ctx" aria-label="已引用的上下文" role="group" />
              <label className="sr-only" htmlFor="composerInput">消息输入框。发送给 Runtime 的文本。</label>
              <textarea
                id="composerInput"
                rows={2}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="输入消息… 输入 / 触发命令，@ 引用文件、Agent、Diff、Preview 元素"
                aria-describedby="composerHint"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && canSend && can("core.prompt")) {
                    event.preventDefault();
                    void dispatchText("core.prompt");
                  }
                }}
              />
              <p className="sr-only" id="composerHint">按 Enter 发送，Shift+Enter 换行</p>
              <div className="composer-bar">
                <div className="cb-group">
                  <button className="icon-btn small" data-tip="附件 / 图片" disabled title="附件不在公共 contract 中"><Icon name="attach" extra="sm" /></button>
                  <button className="icon-btn small" data-tip="@ 引用" disabled title="@ 引用不在公共 contract 中"><Icon name="at" extra="sm" /></button>
                  <button className="icon-btn small" data-tip="Slash Commands" disabled title="Slash Commands 不在公共 contract 中"><Icon name="slash" extra="sm" /></button>
                </div>
                <button className="pill-btn" disabled title="权限模式不在公共 contract 中" aria-label="权限模式：default">
                  <Icon name="shield" extra="sm" /><span>default</span>
                </button>
                <span className="spacer" />
                <button className="pill-btn meta-model" disabled title="模型切换不在公共 contract 中" aria-label="当前模型不可用">
                  <Icon name="cpu" extra="sm" /><span>—</span>
                </button>
                <button className="pill-btn" disabled title="思考强度不在公共 contract 中" aria-label="思考强度不可用">
                  <Icon name="brain" extra="sm" /><span>—</span>
                </button>
                <button className="send-btn" disabled={!canSend || !can("core.prompt")} onClick={() => void dispatchText("core.prompt")} data-tip="发送 (Enter)" title="发送 (Enter)">
                  <Icon name="send" extra="sm" />
                </button>
              </div>
            </div>
          </div>
        </div>
        <aside className={`side-panel${sideOpen ? " open" : ""}`} id="sidePanel" aria-label="功能面板">
          <div className="sp-resizer" id="spResizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="调整右侧面板宽度" />
          <div className="sp-head">
            <div className="tabs" role="tablist" aria-label="面板视图">
              <button className={sideTab === "changes" ? "active" : ""} role="tab" aria-selected={sideTab === "changes"} aria-controls="spChanges" onClick={() => setSideTab("changes")}>
                <Icon name="diff" extra="sm" />Changes
              </button>
              <button className={sideTab === "preview" ? "active" : ""} role="tab" aria-selected={sideTab === "preview"} aria-controls="spPreview" onClick={() => setSideTab("preview")}>
                <Icon name="globe" extra="sm" />Preview
              </button>
              <button className={sideTab === "agents" ? "active" : ""} role="tab" aria-selected={sideTab === "agents"} aria-controls="spAgents" onClick={() => setSideTab("agents")}>
                <Icon name="bot" extra="sm" />Agents
                {preview ? <span className="chip gray xs">4<span className="sr-only"> 个 Agent</span></span> : snapshot ? <span className="chip gray xs">{snapshot.agents.length}<span className="sr-only"> 个 Agent</span></span> : null}
              </button>
            </div>
            <span className="spacer" />
            <button className="icon-btn small" data-tip="关闭面板" onClick={onCloseSide}><Icon name="x" extra="sm" /></button>
          </div>
          <div className="sp-body">
            <div className={`sp-page${sideTab === "changes" ? " active" : ""}`} id="spChanges" role="tabpanel">
              {preview ? <PreviewChanges /> : <Deferred title="Changes 不可用" detail="公共 contract 没有文件树 / diff read model。" />}
            </div>
            <div className={`sp-page${sideTab === "preview" ? " active" : ""}`} id="spPreview" role="tabpanel">
              {preview ? <PreviewSidePreview /> : <Deferred title="Preview 不可用" detail="没有 Preview URL 可供嵌入。" />}
            </div>
            <div className={`sp-page${sideTab === "agents" ? " active" : ""}`} id="spAgents" role="tabpanel">
              {preview ? (
                <PreviewSideAgents onOpenHub={() => onRoute("agent-hub")} />
              ) : snapshot ? (
                snapshot.agents.length ? (
                  snapshot.agents.map((agent) => (
                    <div className="agent-row" key={agent.agentId}>
                      <span className="ag-ic" aria-hidden="true"><Icon name="bot" extra="sm" /></span>
                      <div className="ag-main">
                        <button
                          className="ag-open"
                          type="button"
                          onClick={() => { setHubIntent(agent.agentId); onRoute("agent-hub"); }}
                        >
                          <span className="ag-name">
                            {agent.displayName}
                            <span className="chip gray xs">{agent.status}</span>
                          </span>
                          <span className="ag-task">{agent.assignment ?? agent.summary ?? "—"}</span>
                          <span className="ag-meta">gen {agent.generation}{agent.parentAgentId ? ` · of ${agent.parentAgentId}` : ""}</span>
                        </button>
                      </div>
                      <div className="ag-acts">
                        <button
                          className="icon-btn small"
                          type="button"
                          data-tip="在 Agent Hub 打开"
                          aria-label="在 Agent Hub 打开"
                          onClick={() => { setHubIntent(agent.agentId); onRoute("agent-hub"); }}
                        >
                          <Icon name="external" extra="sm" />
                        </button>
                      </div>
                    </div>
                  ))
                ) : <Deferred title="No agents" detail="当前 snapshot 中没有 Agent。" />
              ) : <Deferred title="Agents deferred" detail="等待 Runtime snapshot。" />}
            </div>
          </div>
        </aside>
      </div>
      <div className={`bottom-panel${bottomOpen ? "" : " collapsed"}`} id="bottomPanel">
        <div className="bp-resizer" id="bpResizer" />
        <div className="bp-head">
          <div className="tabs" role="tablist" aria-label="运行面板视图">
            <button className={bottomTab === "terminal" ? "active" : ""} role="tab" aria-selected={bottomTab === "terminal"} onClick={() => { setBottomTab("terminal"); onBottomOpenChange(true); }}>
              <Icon name="terminal" extra="sm" />Terminal
            </button>
            <button className={bottomTab === "problems" ? "active" : ""} role="tab" aria-selected={bottomTab === "problems"} onClick={() => { setBottomTab("problems"); onBottomOpenChange(true); }}>
              <Icon name="alert-c" extra="sm" />Problems
            </button>
            <button className={bottomTab === "tests" ? "active" : ""} role="tab" aria-selected={bottomTab === "tests"} onClick={() => { setBottomTab("tests"); onBottomOpenChange(true); }}>
              <Icon name="test" extra="sm" />Tests
            </button>
            <button className={bottomTab === "output" ? "active" : ""} role="tab" aria-selected={bottomTab === "output"} onClick={() => { setBottomTab("output"); onBottomOpenChange(true); }}>
              <Icon name="console" extra="sm" />Output
            </button>
            <button className={bottomTab === "logs" ? "active" : ""} role="tab" aria-selected={bottomTab === "logs"} onClick={() => { setBottomTab("logs"); onBottomOpenChange(true); }}>
              <Icon name="book" extra="sm" />OMP Logs
              {state.events.length > 0 && <span className="chip gray xs">{state.events.length}<span className="sr-only"> 条事件</span></span>}
            </button>
            <button className={bottomTab === "pvlogs" ? "active" : ""} role="tab" aria-selected={bottomTab === "pvlogs"} onClick={() => { setBottomTab("pvlogs"); onBottomOpenChange(true); }}>
              <Icon name="globe" extra="sm" />Preview Logs
            </button>
          </div>
          <span className="spacer" />
          <button
            className="icon-btn small"
            data-tip="新建终端"
            disabled={!terminalAvailable}
            title={terminalAvailable ? "新建终端" : "终端仅桌面端可用"}
            onClick={() => terminalRef.current?.create()}
          >
            <Icon name="plus" extra="sm" />
          </button>
          <button className="icon-btn small" data-tip="展开 / 收起 (Ctrl J)" aria-expanded={bottomOpen} aria-controls="bottomPanel" onClick={() => onBottomOpenChange(!bottomOpen)}>
            <Icon name={bottomOpen ? "chevron-d" : "chevron-u"} extra="sm" />
          </button>
        </div>
        <div className="bp-body">
          <div className={`bp-page${bottomTab === "terminal" ? " active" : ""}`} id="bpTerminal" role="tabpanel">
            <TerminalPane ref={terminalRef} visible={bottomTab === "terminal" && bottomOpen} />
          </div>
          <div className={`bp-page${bottomTab === "problems" ? " active" : ""}`} id="bpProblems" role="tabpanel">
            {preview ? <PreviewProblems /> : <Deferred title="Problems 不可用" detail="Problems 不在公共 contract 中。" />}
          </div>
          <div className={`bp-page${bottomTab === "tests" ? " active" : ""}`} id="bpTests" role="tabpanel">
            {preview ? <PreviewTests /> : <Deferred title="Tests 不可用" detail="Tests 不在公共 contract 中。" />}
          </div>
          <div className={`bp-page${bottomTab === "output" ? " active" : ""}`} id="bpOutput" role="tabpanel">
            <div className="panel-head"><div><h2>Command lifecycle</h2><p className="muted">Semantic command ledger from client state.</p></div></div>
            {commandRows.length ? (
              <ul className="lifecycle-list">
                {commandRows.map((command) => (
                  <li key={command.requestId}>
                    <span className="mono">{command.commandName}</span>
                    <Chip>{command.status}</Chip>
                    {"reason" in command && <span className="muted">{command.reason}</span>}
                    {"error" in command && <span className="muted">{command.error.message}</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="muted">No commands issued.</p>}
            <div className="p4-grid">
              <div>
                <h2>Modes</h2>
                <div className="actions">
                  <button className="btn outline" disabled={!can("mode.plan") || busy} onClick={() => void run("mode.plan.enter", {})}>Plan</button>
                  <button className="btn outline" disabled={!can("mode.vibe") || busy} onClick={() => void run("mode.vibe.enter", {})}>Vibe</button>
                  <button className="btn outline" disabled={!can("mode.plan") || busy} onClick={() => void run("mode.plan.exit", {})}>Exit plan</button>
                  <button className="btn outline" disabled={!can("mode.vibe") || busy} onClick={() => void run("mode.vibe.exit", {})}>Exit vibe</button>
                </div>
              </div>
              <div>
                <h2>Goal / loop</h2>
                <div className="actions">
                  <button className="btn outline" disabled={!can("goal.create") || busy} onClick={() => void run("goal.create", { objective: "Continue current work" })}>Create goal</button>
                  <button className="btn outline" disabled={!can("goal.pause") || busy} onClick={() => void run("goal.pause", {})}>Pause goal</button>
                  <button className="btn outline" disabled={!can("goal.resume") || busy} onClick={() => void run("goal.resume", {})}>Resume goal</button>
                  <button className="btn outline" disabled={!can("loop.enable") || busy} onClick={() => void run("loop.enable", {})}>Start loop</button>
                  <button className="btn outline" disabled={!can("loop.pause") || busy} onClick={() => void run("loop.pause", {})}>Pause loop</button>
                  <button className="btn outline" disabled={!can("loop.disable") || busy} onClick={() => void run("loop.disable", {})}>Stop loop</button>
                </div>
              </div>
            </div>
            {commandManifest && <GenericCommandForm manifest={commandManifest} busy={busy} enabled={can("operator.invoke")} onInvoke={(commandId, args) => void run("operator.invoke", { commandId, ...(args === undefined ? {} : { arguments: args }) })} />}
            {runtime?.classification === "limited-system" && <p className="capability-note">Runtime is Limited. P4 mutations are disabled until the capability manifest grants them.</p>}
          </div>
          <div className={`bp-page${bottomTab === "logs" ? " active" : ""}`} id="bpLogs" role="tabpanel">
            <div className="panel-head"><div><h2>OMP Logs</h2><p className="muted">Virtualized semantic events；消息 transcript 不在公共 contract 中。</p></div><span className="mono">{state.events.length} events</span></div>
            <VirtualEventTranscript events={state.events} />
          </div>
          <div className={`bp-page${bottomTab === "pvlogs" ? " active" : ""}`} id="bpPvlogs" role="tabpanel">
            {preview ? <PreviewLogs /> : <Deferred title="Preview Logs 不可用" detail="Preview 不在公共 contract 中。" />}
          </div>
        </div>
      </div>
    </>
  );
}

function AppShell({ state, client, onRoute, selectedHistoryId, onSelectThread, onWorkspacesChange }: {
  state: ViewState;
  client: ClientStateSource;
  onRoute: (route: Route) => void;
  selectedHistoryId: string | null;
  onSelectThread: (entry: SessionHistoryEntry) => void;
  onWorkspacesChange: (workspaces: WorkspaceListReadModel) => void;
}) {
  const previewMode = usePreviewMode();
  const previewOn = () => PREVIEW_MODE_SWITCH_ENABLED && readStoredPreviewMode();
  const [collapsed, setCollapsed] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsEnabledCount, setSkillsEnabledCount] = useState(() => previewOn() ? countEnabledDrawerItems(createPreviewDrawerItems()) : 0);
  const [explorerOpen, setExplorerOpen] = useState(() => previewOn());
  const [selectedProject, setSelectedProject] = useState<SelectedProject | null>(() => previewOn() ? CURRENT_PROJECT : null);
  const initialPreview = defaultPreviewSelection();
  const [previewProjectId, setPreviewProjectId] = useState(initialPreview.projectId);
  const [previewThreadId, setPreviewThreadId] = useState(initialPreview.threadId);
  const [theme, setTheme] = useState<"light" | "dark">(() => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"));
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const [splitRatio, setSplitRatio] = useState(0.46);
  const [sideOpen, setSideOpen] = useState(() => previewOn());
  const [bottomOpen, setBottomOpen] = useState(() => previewOn());
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [ompMenuOpen, setOmpMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<ShellDialog | null>(null);
  const [trail, setTrail] = useState<Route[]>([state.route]);
  const lastPageRoute = useRef<SecondaryRoute>("home");
  if (isSecondary(state.route)) lastPageRoute.current = state.route;
  const wantPage = isSecondary(state.route);
  const { shown: showPage, phase: shellPhase } = useDeferredKey(wantPage);
  const pageRoute = isSecondary(state.route) ? state.route : lastPageRoute.current;
  const pageMeta = SECONDARY_META[pageRoute];
  const shellClass = pagePhaseClass(shellPhase);
  const [trailAt, setTrailAt] = useState(0);
  const [capNonce, setCapNonce] = useState(0);
  const snapshot = snapshotFrom(state);
  const runtime = state.clientState?.connection.runtime ?? state.bootstrap?.runtime;
  const capabilities = state.model.capabilities ?? state.bootstrap?.capabilityManifest;
  const environment = state.model.environment;
  const selected = state.model.history?.entries.find((entry) => entry.historyId === selectedHistoryId);
  const previewThread = findPreviewThread(previewThreadId);
  const threadTitle = previewMode.preview
    ? (previewThread?.thread.title ?? "跟踪上游 pi-web 更新到 omp-web")
    : selected?.title ?? (state.route === "history" ? "会话历史" : state.route === "home" ? "项目主页" : state.route === "agent-hub" ? "Agent Hub" : state.route === "capabilities" ? "能力中心" : state.route === "model-config" ? "模型配置" : "新对话");

  useEffect(() => {
    if (previewMode.preview) {
      setExplorerOpen(true);
      const project = findPreviewProject(previewProjectId);
      if (project) setSelectedProject({ id: project.id, name: project.name });
    }
  }, [previewMode.preview, previewProjectId]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.setProperty("--sidebar-w", `${sidebarWidth}px`);
    void globalThis.ompStudioChrome?.setTheme(theme);
  }, [theme, sidebarWidth]);

  useEffect(() => {
    if (openMenu === null) return;
    const close = () => setOpenMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [openMenu]);

  const refreshProjects = async () => {
    try {
      const workspaces = await client.query("projects.list", {});
      onWorkspacesChange(workspaces);
    } catch {
      // A failed projects.list never blocks navigation; the stale list stays.
    }
  };

  const selectProject = (project: SelectedProject) => {
    setSelectedProject(project);
    setExplorerOpen(true);
    if (!previewMode.preview) {
      // Host remembers the selection; the registry is the only path holder.
      void client.command("workspace.open", { workspaceId: project.id as WorkspaceId }).then(() => {
        void refreshProjects();
      });
    }
  };

  /** System directory picker → register + activate + enter the workbench. */
  const pickProject = async () => {
    if (previewMode.preview) return;
    const handle = await client.command("workspace.pick", {});
    const unsub = client.subscribe({ scope: "command", requestId: handle.requestId }, (event) => {
      if (event.kind !== "command.receipt" || event.receipt.requestId !== handle.requestId) return;
      unsub();
      if (event.receipt.status !== "completed") {
        // Cancelled or failed: keep the current selection untouched.
        return;
      }
      const result = event.receipt.result as WorkspaceListReadModel;
      onWorkspacesChange(result);
      const active = result.workspaces.find((workspace) => workspace.active);
      if (active) {
        setSelectedProject({ id: active.workspaceId, name: active.name });
        setExplorerOpen(true);
        go("workbench");
      }
    });
  };

  /** Enter the workbench selecting the active workspace (or the empty explorer state). */
  const enterWorkbench = () => {
    const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
    if (active) {
      selectProject({ id: active.workspaceId, name: active.name });
    } else {
      setExplorerOpen(true);
    }
  };

  const openWorkspace = (workspaceId: string) => {
    const workspace = state.model.workspaces?.workspaces.find((entry) => entry.workspaceId === workspaceId);
    if (workspace === undefined) return;
    selectProject({ id: workspace.workspaceId, name: workspace.name });
    go("workbench");
  };

  const go = useCallback((next: Route) => {
    setOpenMenu(null);
    setOmpMenuOpen(false);
    if (next === "home") {
      setSelectedProject(null);
      setExplorerOpen(false);
    } else if (next === "workbench") {
      const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
      if (active) {
        setSelectedProject({ id: active.workspaceId, name: active.name });
        setExplorerOpen(true);
      } else {
        setExplorerOpen(true);
      }
    }
    if (next === trail[trailAt]) {
      onRoute(next);
      return;
    }
    setTrail((current) => [...current.slice(0, trailAt + 1), next]);
    setTrailAt((value) => value + 1);
    onRoute(next);
  }, [onRoute, trail, trailAt, state.model.workspaces]);

  const runMenu = (action: () => void) => {
    setOpenMenu(null);
    action();
  };

  const runEdit = (command: EditCommand) => {
    runMenu(() => execEditCommand(command));
  };

  const openDialog = (next: ShellDialog) => {
    setOpenMenu(null);
    setDialog(next);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (dialog) {
          setDialog(null);
          return;
        }
        setOpenMenu(null);
        if (skillsOpen) setSkillsOpen(false);
        setOmpMenuOpen(false);
        return;
      }
      if (event.isComposing || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "b" && !event.shiftKey) {
        event.preventDefault();
        setCollapsed((value) => !value);
      } else if (key === "k" && event.shiftKey) {
        event.preventDefault();
        setSkillsOpen((value) => !value);
      } else if (key === "k") {
        event.preventDefault();
        go("history");
      } else if (key === "o" && event.shiftKey) {
        event.preventDefault();
        go("workbench");
      } else if (key === "j" && !event.shiftKey) {
        event.preventDefault();
        setBottomOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, go, skillsOpen]);

  const chrome: ShellChrome = {
    collapsed,
    skillsOpen,
    explorerOpen,
    theme,
    sidebarWidth,
    splitRatio,
    selectedHistoryId,
    selectedProject,
    skillsEnabledCount,
    previewProjectId,
    previewThreadId,
    onToggleSidebar: () => setCollapsed((value) => !value),
    onToggleSkills: () => setSkillsOpen((value) => !value),
    onSkillsEnabledCount: setSkillsEnabledCount,
    onToggleExplorer: () => setExplorerOpen((value) => !value),
    onToggleTheme: () => setTheme((value) => (value === "light" ? "dark" : "light")),
    onResizeSidebar: setSidebarWidth,
    onResizeSplit: setSplitRatio,
    onSelectProject: selectProject,
    onSelectThread: (entry) => {
      if (previewMode.preview) {
        onSelectThread(entry);
        return;
      }
      const active = state.model.workspaces?.workspaces.find((workspace) => workspace.active);
      if (active) {
        selectProject({ id: active.workspaceId, name: active.name });
      } else {
        setExplorerOpen(true);
      }
      onSelectThread(entry);
    },
    onPickProject: () => {
      void pickProject();
    },
    onSelectPreviewProject: (id) => {
      setPreviewProjectId(id);
      const project = findPreviewProject(id);
      if (project) {
        setSelectedProject({ id: project.id, name: project.name });
        setExplorerOpen(true);
        const first = project.threads[0];
        if (first) setPreviewThreadId(first.id);
      }
    },
    onSelectPreviewThread: (id) => {
      setPreviewThreadId(id);
      const hit = findPreviewThread(id);
      if (hit) {
        setPreviewProjectId(hit.project.id);
        setSelectedProject({ id: hit.project.id, name: hit.project.name });
        setExplorerOpen(true);
      }
      go("workbench");
    },
    onOpenCapabilities: (tab, name) => {
      if (tab) {
        setCapIntent(tab, name);
        setCapNonce((value) => value + 1);
      }
      setSkillsOpen(false);
      go("capabilities");
    },
    onToggleOmpMenu: () => setOmpMenuOpen((value) => !value),
    ompMenuOpen,
  };

  return (
    <div className="app" id="appRoot">
      <a className="skip-link" href="#convoScroll">跳到对话内容</a>
      <Titlebar
        canBack={trailAt > 0}
        canForward={trailAt < trail.length - 1}
        onBack={() => {
          if (trailAt <= 0) return;
          const next = trailAt - 1;
          const route = trail[next] ?? "workbench";
          setTrailAt(next);
          if (route === "home") {
            setSelectedProject(null);
            setExplorerOpen(false);
          } else if (route === "workbench") {
            enterWorkbench();
          }
          onRoute(route);
        }}
        onForward={() => {
          if (trailAt >= trail.length - 1) return;
          const next = trailAt + 1;
          const route = trail[next] ?? "workbench";
          setTrailAt(next);
          if (route === "home") {
            setSelectedProject(null);
            setExplorerOpen(false);
          } else if (route === "workbench") {
            enterWorkbench();
          }
          onRoute(route);
        }}
        onToggleSidebar={() => setCollapsed((value) => !value)}
        sidebarCollapsed={collapsed}
        menus={
          <>
            <TitleMenu id="file" label="文件" openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => go("workbench")}>新建对话<span className="kbd">Ctrl ⇧ O</span></button>
              <button className="menu-item" role="menuitem" onClick={() => go("history")}>会话历史</button>
              <button className="menu-item" role="menuitem" onClick={() => go("agent-hub")}>Agent Hub</button>
              <button className="menu-item" role="menuitem" onClick={() => go("capabilities")}>能力中心</button>
              <button className="menu-item" role="menuitem" onClick={() => go("model-config")}>模型配置</button>
              <button className="menu-item" role="menuitem" onClick={() => go("settings")}>设置</button>
              <button className="menu-item" role="menuitem" onClick={() => go("diagnostics")}>诊断中心</button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => go("history")}>搜索会话<span className="kbd">Ctrl K</span></button>
              <button className="menu-item" role="menuitem" onClick={() => go("home")}>项目主页</button>
            </TitleMenu>
            <TitleMenu id="edit" label="编辑" openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("undo")}>撤销<span className="kbd">Ctrl Z</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("redo")}>重做<span className="kbd">Ctrl Y</span></button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => runEdit("cut")}>剪切<span className="kbd">Ctrl X</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("copy")}>复制<span className="kbd">Ctrl C</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("paste")}>粘贴<span className="kbd">Ctrl V</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runEdit("selectAll")}>全选<span className="kbd">Ctrl A</span></button>
            </TitleMenu>
            <TitleMenu id="view" label="视图" openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setCollapsed((value) => !value))}>{collapsed ? "展开侧栏" : "收起侧栏"}<span className="kbd">Ctrl B</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setExplorerOpen((value) => !value))}>{explorerOpen ? "收起 Explorer" : "展开 Explorer"}</button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setSkillsOpen((value) => !value))}>{skillsOpen ? "关闭技能与插件" : "打开技能与插件"}<span className="kbd">Ctrl ⇧ K</span></button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setSideOpen((value) => !value))}>{sideOpen ? "收起右侧面板" : "展开右侧面板"}</button>
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => setBottomOpen((value) => !value))}>{bottomOpen ? "收起底部面板" : "展开底部面板"}<span className="kbd">Ctrl J</span></button>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => runMenu(() => chrome.onToggleTheme())}>{theme === "dark" ? "切换为浅色" : "切换为深色"}</button>
            </TitleMenu>
            <TitleMenu id="help" label="帮助" openId={openMenu} onToggle={setOpenMenu}>
              <button className="menu-item" role="menuitem" onClick={() => openDialog("shortcuts")}>键盘快捷键</button>
              <button className="menu-item" role="menuitem" onClick={() => openDialog("about")}>关于 OMP Studio</button>
              <button className="menu-item" role="menuitem" disabled title="文档页尚未接入公共 contract">文档</button>
            </TitleMenu>
          </>
        }
      />
      {showPage ? (
        <SecondaryPage
          route={pageRoute}
          title={pageMeta.title}
          titleIcon={pageMeta.icon}
          theme={theme}
          className={shellClass}
          onRoute={go}
          onToggleTheme={chrome.onToggleTheme}
        >
          {state.hostError && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>host unavailable</b> · <span className="banner-detail">{state.hostError.message}</span></span>
            </div>
          )}
          {state.clientState?.connection.resyncRequired && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>resync required</b> · <span className="banner-detail">正在恢复最新 Runtime 状态，敏感操作已暂停。</span></span>
            </div>
          )}
          {pageRoute === "home" ? (
            <HomePage
              {...(runtime ? { runtime } : {})}
              {...(snapshot ? { snapshot } : {})}
              {...(state.model.home ? { home: state.model.home } : {})}
              {...(state.model.history ? { history: state.model.history } : {})}
              {...(state.model.workspaces ? { workspaces: state.model.workspaces } : {})}
              onPickFolder={() => {
                if (previewMode.preview) return;
                void pickProject();
              }}
              onOpenWorkspace={(workspaceId) => openWorkspace(workspaceId)}
              onRoute={go}
            />
          ) : pageRoute === "history" ? (
            <HistoryPage
              {...(state.model.history ? { history: state.model.history } : {})}
              onRoute={go}
              onSelectThread={chrome.onSelectThread}
            />
          ) : pageRoute === "agent-hub" ? (
            <AgentHubPage
              {...(snapshot ? { snapshot } : {})}
              {...(runtime ? { runtime } : {})}
              {...(state.clientState?.connection.resyncRequired ? { resyncRequired: true } : {})}
              {...(capabilities ? { capabilities } : {})}
              onOpenMain={() => go("workbench")}
            />
          ) : pageRoute === "model-config" ? (
            <ModelConfigPage client={client} />
          ) : pageRoute === "settings" ? (
            <SettingsPage theme={theme} onSetTheme={(next) => setTheme(next)} onRoute={go} />
          ) : pageRoute === "diagnostics" ? (
            <DiagnosticsPage
              client={client}
              {...(state.model.diagnostics ? { diagnostics: state.model.diagnostics } : {})}
              {...(capabilities ? { capabilities } : {})}
              {...(runtime ? { runtime } : {})}
              {...(environment ? { environment } : {})}
            />
          ) : (
            <CapabilitiesPage key={capNonce} client={client} />
          )}
        </SecondaryPage>
      ) : (
      <div className={`app-body ${shellClass}`}>
        <AppSidebar state={state} chrome={chrome} client={client} onRoute={go} />
        <div className="main-col">
          <AppTopbar state={state} chrome={chrome} onRoute={go} threadTitle={threadTitle} sideOpen={sideOpen} onToggleSide={() => setSideOpen((value) => !value)} />
          {state.hostError && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>host unavailable</b> · <span className="banner-detail">{state.hostError.message}</span></span>
            </div>
          )}
          {state.clientState?.connection.resyncRequired && (
            <div className="banner amber" role="alert">
              <Icon name="alert" />
              <span><b>resync required</b> · <span className="banner-detail">正在恢复最新 Runtime 状态，敏感操作已暂停。</span></span>
            </div>
          )}
          <WorkbenchCanvas state={state} client={client} sideOpen={sideOpen} onCloseSide={() => setSideOpen(false)} bottomOpen={bottomOpen} onBottomOpenChange={setBottomOpen} onRoute={go} />
          <span className="sr-only">client contract v{CLIENT_CONTRACT_VERSION}{snapshot ? ` · session ${snapshot.sessionId}` : ""}</span>
        </div>
      </div>
      )}
      {dialog ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="shellDialogTitle" onMouseDown={(event) => event.stopPropagation()}>
            {dialog === "about" ? (
              <>
                <div className="modal-head" id="shellDialogTitle">关于 OMP Studio</div>
                <div className="modal-body">
                  <dl className="about-list">
                    <div className="about-row"><dt>产品</dt><dd>OMP Studio</dd></div>
                    <div className="about-row"><dt>Client contract</dt><dd>v{CLIENT_CONTRACT_VERSION}</dd></div>
                    <div className="about-row"><dt>Runtime</dt><dd>{runtime?.status ?? "unavailable"}{runtime?.classification ? ` · ${runtime.classification}` : ""}</dd></div>
                    {runtime?.runtimeVersion ? <div className="about-row"><dt>Runtime 版本</dt><dd>{runtime.runtimeVersion}</dd></div> : null}
                    {environment ? <div className="about-row"><dt>平台</dt><dd>{environment.platform} · {environment.arch}</dd></div> : null}
                    {snapshot ? <div className="about-row"><dt>Session</dt><dd className="mono">{snapshot.sessionId}</dd></div> : null}
                  </dl>
                </div>
              </>
            ) : (
              <>
                <div className="modal-head" id="shellDialogTitle">键盘快捷键</div>
                <div className="modal-body">
                  <dl className="about-list">
                    <div className="about-row"><dt>新建对话</dt><dd><span className="kbd">Ctrl ⇧ O</span></dd></div>
                    <div className="about-row"><dt>搜索会话</dt><dd><span className="kbd">Ctrl K</span></dd></div>
                    <div className="about-row"><dt>展开 / 收起侧栏</dt><dd><span className="kbd">Ctrl B</span></dd></div>
                    <div className="about-row"><dt>技能与插件</dt><dd><span className="kbd">Ctrl ⇧ K</span></dd></div>
                    <div className="about-row"><dt>底部面板</dt><dd><span className="kbd">Ctrl J</span></dd></div>
                    <div className="about-row"><dt>关闭菜单或面板</dt><dd><span className="kbd">Esc</span></dd></div>
                  </dl>
                </div>
              </>
            )}
            <div className="modal-foot">
              <button type="button" className="btn primary" onClick={() => setDialog(null)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function App({ client: inputClient }: { readonly client: StudioClient }) {
  const client = inputClient as ClientStateSource;
  const [state, dispatch] = useReducer(reduce, { loading: true, model: {}, events: [], route: "workbench" });
  const [route, setRoute] = useState<Route>("workbench");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const offEvent = client.subscribe({ scope: "all" }, (event) => { if (!cancelled) dispatch({ type: "event", event }); });
    const offState = client.onState?.((clientState) => { if (!cancelled) dispatch({ type: "state", clientState }); });
    const load = async () => {
      try {
        const bootstrap = await client.bootstrap();
        if (cancelled) return;
        const clientState = client.getState?.();
        dispatch({ type: "ready", bootstrap, ...(clientState ? { clientState } : {}) });
        const results = await Promise.allSettled([
          client.query("environment.get", {}),
          client.query("capabilities.get", {}),
          client.query("commands.getManifest", {}),
          client.query("diagnostics.get", {}),
          client.query("history.list", { limit: 20 }),
          client.query("home.get", {}),
          client.query("projects.list", {}),
        ]);
        if (cancelled) return;
        const [environment, capabilities, commandManifest, diagnostics, history, home, workspaces] = results;
        dispatch({ type: "model", model: {
          ...(environment.status === "fulfilled" ? { environment: environment.value } : {}),
          ...(capabilities.status === "fulfilled" ? { capabilities: capabilities.value } : {}),
          ...(commandManifest.status === "fulfilled" ? { commandManifest: commandManifest.value } : {}),
          ...(diagnostics.status === "fulfilled" ? { diagnostics: diagnostics.value } : {}),
          ...(history.status === "fulfilled" ? { history: history.value } : {}),
          ...(home.status === "fulfilled" ? { home: home.value } : {}),
          ...(workspaces.status === "fulfilled" ? { workspaces: workspaces.value } : {}),
        } });
      } catch (error) {
        if (!cancelled) dispatch({ type: "ready", bootstrap: unavailableBootstrap(), hostError: asError(error) });
      }
    };
    void load();
    return () => {
      cancelled = true;
      offEvent();
      offState?.();
      // The shell owns the injected client. Closing it here kills the singleton
      // (and, over desktop IPC, the Host facade) on Vite HMR / remount, after
      // which every bootstrap fails with "transport is closed".
    };
  }, [client]);

  const routedState = { ...state, route };
  const body = state.loading ? (
    <div className="app">
      <Titlebar />
      <div className="main-col">
        <div className="empty" style={{ flex: 1, justifyContent: "center" }}>
          <span className="spinner" />
          <h1>Connecting</h1>
          <p className="muted">Requesting bootstrap…</p>
        </div>
      </div>
    </div>
  ) : state.error && state.bootstrap === undefined ? (
    <div className="app">
      <Titlebar />
      <div className="main-col">
        <div className="empty" style={{ flex: 1, justifyContent: "center" }}>
          <Icon name="alert" extra="lg" />
          <h1>Bootstrap failed</h1>
          <p><span className="mono">{state.error.code}</span> {state.error.message}</p>
        </div>
      </div>
    </div>
  ) : (
    <AppShell
      state={routedState}
      client={client}
      onRoute={setRoute}
      selectedHistoryId={selectedHistoryId}
      onSelectThread={(entry) => { setSelectedHistoryId(entry.historyId); setRoute("workbench"); }}
      onWorkspacesChange={(workspaces) => dispatch({ type: "model", model: { workspaces } })}
    />
  );
  return <PreviewModeProvider>{body}</PreviewModeProvider>;
}
