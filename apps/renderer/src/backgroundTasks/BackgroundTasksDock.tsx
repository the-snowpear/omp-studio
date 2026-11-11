import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot, StudioJobSnapshot, StudioJobAgentLink } from "@omp-studio/studio-protocol";
import { DockPanel, useDock, usePanelInstances } from "../dock/DockContext";
import { locatePanel, panelInstanceIds } from "../dock/model";
import { DockPanelMeter, type PanelStatusMeter } from "../dock/panelMeters";
import type { DockLayout, PanelId } from "../dock/types";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { BackgroundTasksPanel, type BackgroundTaskIntent, type BackgroundTasksSource } from "./BackgroundTasksPanel";
import { backgroundTaskCounts, taskStatusLabel } from "./backgroundTasksModel";
import { useBackgroundTasks } from "./useBackgroundTasks";
import { routeBrowserLink } from "../browser/browserLinks";
import { useConversationView } from "../conversationWorkspace/Context";
import { surfaceWindow, useSurfaceDocument } from "../dock/SurfaceContext";
import { useWindowFocusStore } from "../dock/windowOrder";

const NO_JOBS: readonly StudioJobSnapshot[] = [];
const NO_LINKS: readonly StudioJobAgentLink[] = [];

export function buildBackgroundTasksMeter(source: BackgroundTasksSource, options: { available: boolean; preview: boolean; marks: boolean; zh: boolean }): PanelStatusMeter {
  const { available, preview, marks, zh } = options;
  const count = backgroundTaskCounts(source.rows);
  const groups = [
    { id: "active", count: count.active, label: zh ? "活动" : "Active", color: "var(--green)" },
    { id: "failed", count: count.failed, label: zh ? "失败" : "Failed", color: "var(--red)" },
    { id: "finished", count: count.total - count.active - count.failed, label: zh ? "结束" : "Finished", color: "var(--text-3)" },
  ].filter(group => group.count > 0);
  const unavailable = !preview && (!available || source.servicesState === "error" || source.servicesState === "unavailable");
  const emptyLabel = !preview && !available ? zh ? "不可读取" : "Unavailable" : !source.jobsReady || source.servicesState === "loading" ? zh ? "读取中" : "Loading" : zh ? "无任务" : "No tasks";
  const note = !preview && !available ? zh ? "非实时" : "Offline" : unavailable ? zh ? "部分不可用" : "Partly unavailable" : undefined;
  const label = ["Background tasks", note, groups.map(group => `${group.count} ${group.label}`).join(" · ") || emptyLabel, preview && marks ? zh ? "演示" : "Demo" : undefined].filter(Boolean).join(" · ");
  return { kind: "status", total: count.total, badge: count.active, counts: groups, emptyLabel, ...(note ? { note } : {}), stale: unavailable,
    tone: count.failed ? "danger" : unavailable ? "warning" : "normal", label,
    detail: [label, ...source.rows.map(row => `${row.label} · ${taskStatusLabel(row, zh)}`)].join("\n") };
}

/** Right-side detail pages win; another window is reused only while it owns focus. */
export function backgroundTasksDetailTarget(layout: DockLayout, activeWindowId: string | null, windowId: (groupId: string) => string): PanelId | undefined {
  const panels = new Set(panelInstanceIds(layout, "jobs"));
  const isJobs = (id: PanelId) => panels.has(id);
  for (const group of layout.right.groups) {
    const panel = group.panels.find(isJobs);
    if (panel) return panel;
  }
  return layout.floats.find(group => !group.minimized && isJobs(group.active) && windowId(group.id) === activeWindowId)?.active;
}

/** A card opens another surface, not another data source or another running task. */
export function BackgroundTasksDock({ client, snapshot, sessionId, scopeKey, available, jobsReady, canListServices, canStopServices, canCancelJobs, workbenchVisible }: {
  client?: StudioClient | undefined;
  snapshot?: OperatorStateSnapshot | null | undefined;
  sessionId?: string | undefined;
  scopeKey: string;
  available: boolean;
  jobsReady: boolean;
  canListServices: boolean;
  canStopServices: boolean;
  canCancelJobs: boolean;
  workbenchVisible: boolean;
}) {
  const dock = useDock();
  const { hosts, store, layout } = dock;
  const { preview, marks } = usePreviewMode();
  const view = useConversationView();
  const originDocument = useSurfaceDocument();
  const fallbackFocus = useWindowFocusStore();
  const focus = store.windowManager?.focus ?? fallbackFocus;
  const focusState = useSyncExternalStore(focus.subscribe, focus.getSnapshot);
  const pointerFocus = useRef<{ button: HTMLButtonElement; id: string | null } | null>(null);
  const clickFocus = useRef<string | null | undefined>(undefined);
  const openPreview = (url: string, key: string) => routeBrowserLink(url, true, { reuse: true, reuseKey: JSON.stringify([dock.scope.target, dock.scope.project, key]), sessionId: dock.scope.session, documentId: view?.document.id, preview });
  const { resolvedLanguage } = useI18n();
  const instanceKey = usePanelInstances("jobs").join("|");
  const ids = useMemo(() => instanceKey.split("|") as PanelId[], [instanceKey]);
  useLayoutEffect(() => {
    const win = surfaceWindow(originDocument);
    const cardButton = (target: EventTarget | null) => {
      const button = (target as Element | null)?.closest?.<HTMLButtonElement>(".bt-task-main");
      return button?.closest(".background-tasks.is-card") && ids.some(id => hosts.get(id).element.contains(button)) ? button : null;
    };
    let clearTimer: number | undefined;
    const clear = () => {
      if (clearTimer !== undefined) win.clearTimeout(clearTimer);
      clearTimer = undefined; clickFocus.current = undefined; pointerFocus.current = null;
    };
    // Window capture precedes the focus authority's document capture listener.
    const pointer = (event: PointerEvent) => {
      clear();
      const button = event.button === 0 ? cardButton(event.target) : null;
      pointerFocus.current = button ? { button, id: focus.getSnapshot().activeId } : null;
    };
    const click = (event: MouseEvent) => {
      const button = cardButton(event.target), previous = pointerFocus.current;
      if (!button) { clear(); return; }
      clickFocus.current = event.detail > 0 && previous?.button === button ? previous.id : undefined;
      // Microtasks can run between native event listeners, before React's click handler.
      clearTimer = win.setTimeout(clear, 0);
    };
    win.addEventListener("pointerdown", pointer, true);
    win.addEventListener("click", click, true);
    return () => {
      win.removeEventListener("pointerdown", pointer, true);
      win.removeEventListener("click", click, true);
      clear();
    };
  }, [originDocument, focus, hosts, ids]);
  // Chrome remains visible while a rail card's body is folded or reduced to an icon.
  const summaryVisible = workbenchVisible && ids.some(id => {
    const location = locatePanel(layout, id);
    return location?.region === "rail" ? layout.rail.mode !== "hidden" : location?.region === "left" && layout.left.visible;
  });
  const subscribe = useCallback((listener: () => void) => {
    const docs = new Set<Document>();
    const syncDocuments = () => {
      for (const id of ids) {
        const doc = hosts.get(id).surfaceSnapshot();
        if (!docs.has(doc)) { docs.add(doc); doc.addEventListener("visibilitychange", changed); }
      }
    };
    const changed = () => { syncDocuments(); listener(); };
    syncDocuments();
    const stops = ids.map(id => hosts.get(id).subscribe(changed));
    return () => { stops.forEach(stop => stop()); docs.forEach(doc => doc.removeEventListener("visibilitychange", changed)); };
  }, [hosts, ids]);
  const bodyVisible = useSyncExternalStore(subscribe, () => ids.some(id => hosts.get(id).snapshot().visible && !hosts.get(id).surfaceSnapshot().hidden));
  const sourceDocument = useSyncExternalStore(subscribe, () => ids.map(id => hosts.get(id)).find(host => host.snapshot().visible && !host.surfaceSnapshot().hidden)?.surfaceSnapshot() ?? originDocument);
  const active = bodyVisible || summaryVisible;
  const source = useBackgroundTasks({
    ...(client ? { client } : {}), ...(sessionId ? { sessionId } : {}), scopeKey,
    jobs: jobsReady ? snapshot?.jobs ?? NO_JOBS : NO_JOBS, jobAgents: snapshot?.jobAgents ?? NO_LINKS,
    mainAgentId: snapshot?.agents.find(agent => agent.kind === "main")?.agentId,
    jobsReady, available, canListServices, canStopServices, canCancelJobs, active, preview, document: sourceDocument,
  });
  const [now, setNow] = useState(Date.now);
  const running = source.rows.some(row => row.active);
  useEffect(() => {
    if (!bodyVisible || !running) return;
    setNow(Date.now());
    const timer = setInterval(() => { if (!sourceDocument.hidden) setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [bodyVisible, running, sourceDocument]);
  const meter = useMemo(() => buildBackgroundTasksMeter(source, { available, preview, marks, zh: resolvedLanguage === "zh" }),
    [source.rows, source.jobsReady, source.servicesState, available, preview, marks, resolvedLanguage]);
  const [intents, setIntents] = useState<{ scope: string; values: Partial<Record<PanelId, BackgroundTaskIntent>> }>({ scope: scopeKey, values: {} });
  const sequence = useRef(0);
  const openWindow = (key?: string) => {
    const activeWindowId = clickFocus.current !== undefined ? clickFocus.current : focus.getSnapshot().activeId;
    const current = store.getSnapshot();
    let target = backgroundTasksDetailTarget(current.layout, activeWindowId, id => store.windowId(id));
    if (target) store.dispatch({ type: "reveal", panel: target });
    else {
      if (current.preferences.locked) return;
      const groupId = current.layout.right.groups[0]?.id;
      store.openIn("jobs", { region: "right", ...(groupId ? { groupId } : {}) });
      target = backgroundTasksDetailTarget(store.getSnapshot().layout, null, id => store.windowId(id));
    }
    if (target) {
      const id = target;
      const intent = { key, serial: ++sequence.current };
      setIntents(current => ({ scope: scopeKey, values: { ...(current.scope === scopeKey ? current.values : {}), [id]: intent } }));
    }
  };
  return <>
    <DockPanelMeter id="jobs" value={meter} />
    {ids.map(id => <DockPanel id={id} key={id}>{visibility => <BackgroundTasksPanel key={scopeKey}
      source={source} client={client} sessionId={sessionId} scopeKey={scopeKey} available={available} onOpenPreview={openPreview}
      visible={visibility.visible} card={["rail", "left"].includes(locatePanel(layout, id)?.region ?? "")}
      now={now} locked={dock.preferences.locked && !backgroundTasksDetailTarget(layout, clickFocus.current !== undefined ? clickFocus.current : pointerFocus.current?.id ?? focusState.activeId, id => store.windowId(id))}
      intent={intents.scope === scopeKey ? intents.values[id] : undefined} onOpenWindow={openWindow} />}</DockPanel>)}
  </>;
}
