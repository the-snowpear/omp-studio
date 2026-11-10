import { useEffect, useRef, useState } from "react";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, usePreviewMode } from "../preview/PreviewContext";
import { DockProvider, useDock } from "../dock/DockContext";
import { DockFloatingLayer, DockGroupRegion, DockRail } from "../dock/DockRegions";
import { PanelRegistration } from "../dock/PanelRegistration";
import { DockStore } from "../dock/store";
import { WORKBENCH_PANELS } from "../panels/registry";
import { BackgroundTasksDock } from "../backgroundTasks/BackgroundTasksDock";
import { BrowserDockInstances } from "../browser/BrowserDockInstances";
import { BrowserStartPanel } from "../browser/ManagedBrowserPane";
import { TipHost } from "../TipHost";
import { browserHub } from "../browser/browserSessions";
import type { createPreviewBrowserBackend } from "../preview/managedBrowserPreview";
import { PREVIEW_BACKGROUND_SERVICES } from "../preview/backgroundTasksPreview";
import { useWindowOrder } from "../dock/windowOrder";

/** Deterministic scene using the production windows, task bodies, and managed browser tabs. */
function Scene() {
  const { store, layout, scope } = useDock();
  const mainWindow = useWindowOrder(0, { id: "background-task-main", floating: false });
  const { preview } = usePreviewMode();
  const seeded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!preview || seeded.current === scope.session) return;
    const url = PREVIEW_BACKGROUND_SERVICES.find(service => service.previewUrl)?.previewUrl;
    if (!url) return;
    seeded.current = scope.session;
    (browserHub(true)!.backend as ReturnType<typeof createPreviewBrowserBackend>).agentOpen(scope.session, new URL("components/button", url).href);
  }, [preview, scope.session]);
  return <>
    <div className="app-titlebar" style={{ padding: "0 16px", gap: 12 }}>Background tasks
      <button className="btn small" onClick={() => store.openIn("jobs", { region: "float" })}>完整窗口</button>
      <button className="btn small" onClick={() => { store.dispatch({ type: "railMode", mode: "expanded" }); store.dispatch({ type: "card", panel: "jobs", collapsed: false }); }}>展开卡片</button>
      <button className="btn small" onClick={() => { store.dispatch({ type: "railMode", mode: "expanded" }); store.dispatch({ type: "card", panel: "jobs", collapsed: true }); }}>折叠卡片</button>
      <button className="btn small" onClick={() => store.dispatch({ type: "railMode", mode: "compact" })}>图标</button>
      <button className="btn small" onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; }}>明暗</button>
    </div>
    <main className="adaptive-workbench" data-dock-window={mainWindow.id} style={{ display: "flex", width: "100vw", height: "calc(100vh - 32px)", position: "relative", background: "var(--bg)" }}>
      <div className="convo-wrap" style={{ flex: 1, position: "relative", minWidth: 0, height: "100%" }}><DockRail mode={layout.rail.mode} /></div>
      <aside className="side-panel open" style={{ position: "relative", width: layout.right.visible ? 520 : 0, flex: "none", overflow: "hidden" }}>
        <DockGroupRegion region="right" visible={layout.right.visible} />
      </aside>
    </main>
    <PanelRegistration panels={{ browser: visibility => <BrowserStartPanel sessionId={scope.session} visible={visibility.visible} /> }} />
    <BrowserDockInstances sessionId={scope.session} available={false} capabilities={undefined} remote={false} onReferences={() => {}} />
    <DockFloatingLayer />
    <BackgroundTasksDock scopeKey="background-tasks-acceptance" available={false} jobsReady={false} workbenchVisible canListServices={false} canStopServices={false} canCancelJobs={false} />
    <TipHost />
  </>;
}
export function BackgroundTasksHarness() {
  const [store] = useState(() => {
    const value = new DockStore(null);
    value.switchScope({ target: "preview", project: "background-tasks", session: "background-tasks-acceptance" }, true);
    value.dispatch({ type: "hide", panels: ["environment", "context", "agents"] });
    value.dispatch({ type: "move", panels: ["jobs"], target: { region: "rail" } });
    value.dispatch({ type: "railMode", mode: "expanded" });
    if (new URLSearchParams(location.search).has("window")) {
      value.openIn("jobs", { region: "float" });
      const group = value.getSnapshot().layout.floats.find(group => group.panels.some(id => id === "jobs" || id.startsWith("jobs@")));
      if (group) value.dispatch({ type: "float", groupId: group.id, rect: { x: 24, y: 330, width: 430, height: 330 } });
    }
    return value;
  });
  return <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><DockProvider store={store} definitions={WORKBENCH_PANELS}><Scene /></DockProvider></PreviewModeProvider></I18nProvider>;
}
