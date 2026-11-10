/** Real application over a disconnected, read-only transport. No Host, Runtime or user files. */
import { createRoot } from "react-dom/client";
import { StudioClientImpl } from "@omp-studio/client";
import { contractFixtures } from "@omp-studio/testkit";
import type { ClientContextScope, ClientTransport, SessionId, WorkspaceId } from "@omp-studio/client-contract";
import { sessionSwitchPerformance } from "../sessionSwitchPerformance";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "../settings/startupNotice";
import { ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID } from "../onboarding/onboardingState";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/sidebar.css";
import "../styles/workbench.css";
import "../styles/pages.css";
import "../styles/agent-hub.css";
import "../styles/models-roles.css";
import "../styles/btw.css";
import "../styles/typography.css";
import "../styles/tabs.css";
import "../App.css";

localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID);
localStorage.setItem("omp.appSettings", JSON.stringify({ language: "en", theme: "light", startupPage: "workbench", restoreLastSession: false, rememberLayout: false }));
localStorage.setItem("omp.lastRoute", "workbench");
localStorage.setItem("omp.previewMode", "0");
localStorage.removeItem("omp.conversation-workspace.v1");
const params = new URL(location.href).searchParams;
const stalled = params.get("stalled") === "1";
const delayMs = Math.min(60_000, Math.max(0, Number(params.get("delayMs")) || 0));
const workspaceId = "ws-perf" as WorkspaceId;
const total = 24;
const counts = { contextsOpened: 0, contextsClosed: 0, activeSubscriptions: 0, pendingQueries: 0, queries: {} as Record<string, number> };
const historyFixture = contractFixtures.queryResponses["history.list"];
if (!historyFixture.ok) throw new Error("The history fixture must be a successful response.");
const sessionTemplate = historyFixture.result.entries[0]!;
const sessions = Array.from({ length: total }, (_, index) => ({
  ...sessionTemplate,
  sessionId: `perf-session-${index}` as SessionId,
  historyId: `perf-history-${index}` as never, threadId: `perf-thread-${index}` as never,
  title: `Performance session ${String(index + 1).padStart(2, "0")}`,
  messageCount: 40,
}));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function transport(scope?: ClientContextScope): ClientTransport {
  let closed = false;
  return {
    openContext: async next => { counts.contextsOpened++; return transport(next); },
    bootstrap: async () => {
      const { snapshot: _snapshot, stateVersion: _version, residents: _residents, ...base } = structuredClone(contractFixtures.bootstrap);
      return { ...base, runtime: { status: "unavailable", classification: "unavailable" },
        selected: { workspaceId, sessionId: scope?.sessionId ?? sessions[0]!.sessionId },
        residents: { generatedAt: "2026-11-09T00:00:00.000Z", residents: [] } };
    },
    query: async request => {
      const name = request.queryName;
      counts.queries[name] = (counts.queries[name] ?? 0) + 1;
      counts.pendingQueries++;
      try {
        if (delayMs) await pause(delayMs);
        const response = structuredClone((contractFixtures.queryResponses as Record<string, unknown>)[name]) as any;
        if (!response) throw new Error(`No performance fixture for ${name}`);
        if (name === "projects.list") response.result = { activeWorkspaceId: workspaceId, workspaces: [{ workspaceId, name: "Performance fixture", active: true, lastOpenedAt: "2026-11-09T00:00:00.000Z" }] };
        if (name === "history.list") response.result = { entries: sessions, total };
        if (name === "residents.list") response.result = { generatedAt: "2026-11-09T00:00:00.000Z", residents: [] };
        if (name === "session.agents.list") response.result = { sessionId: scope?.sessionId ?? sessions[0]!.sessionId, agents: [] };
        if (name === "session.transcript.readPage") {
          if (stalled) await new Promise<void>(() => {});
          const sessionId = scope?.sessionId ?? sessions[0]!.sessionId;
          response.result = { ...response.result, sessionId, items: Array.from({ length: 40 }, (_, index) => ({
            kind: "message", itemId: `${sessionId}-item-${index}`, parentId: index ? `${sessionId}-item-${index - 1}` : null,
            createdAt: "2026-11-09T00:00:00.000Z", role: index % 2 ? "assistant" : "user",
            content: [{ type: "text", text: index % 2 ? "A fixed response for session-switch measurements.\n\n- Read-only transport\n- No runtime connection\n- Bounded synthetic text" : "Inspect the local performance fixture without executing anything." }],
          })) };
        }
        return response;
      } finally { counts.pendingQueries--; }
    },
    command: async () => { throw new Error("The performance harness never executes commands."); },
    subscribe: () => { counts.activeSubscriptions++; let released = false; return () => { if (!released) { released = true; counts.activeSubscriptions--; } }; },
    close: async () => { if (!closed) { closed = true; if (scope) counts.contextsClosed++; } },
  };
}
sessionSwitchPerformance.register(() => ({ contextsOpened: counts.contextsOpened, contextsClosed: counts.contextsClosed, activeSubscriptions: counts.activeSubscriptions, pendingQueries: counts.pendingQueries }));
const { App } = await import("../App");
createRoot(document.getElementById("root")!).render(<App client={new StudioClientImpl(transport())} />);
const harness = {
  counts,
  async verifyReading() {
    if (stalled) throw new Error("Reading restoration requires a completed transcript.");
    const { captureAnchor } = await import("../conversation/useConversationScroll");
    const frame = () => new Promise<void>((resolve, reject) => {
      const id = requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
      const timer = setTimeout(() => { cancelAnimationFrame(id); reject(new Error("The preview is not producing animation frames; keep this fixture visible.")); }, 2000);
    });
    const select = async (index: number) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("#projectList .thread")].find(value => value.textContent?.includes(sessions[index]!.title));
      if (!button) throw new Error("Reading fixture row is not visible");
      button.click();
      await pause(0);
      const deadline = performance.now() + 10_000;
      while (document.querySelector('.cw-main-conversation #appRoot[aria-busy=true]') || !document.querySelector(`.cw-main-conversation [data-item-id^="${sessions[index]!.sessionId}-item-"]`) || document.querySelector('.cw-main-conversation .convo-body')?.getAttribute("data-phase") !== "idle") {
        if (performance.now() > deadline) throw new Error("Reading fixture did not become ready");
        await pause(20);
      }
      await frame(); await frame();
    };
    await select(1);
    const first = document.querySelector<HTMLElement>(".cw-main-conversation .convo-scroll")!;
    const editor = document.querySelector<HTMLElement>(".cw-main-conversation [contenteditable=true]")!;
    editor.textContent = "draft survives view release";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: editor.textContent }));
    first.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    first.scrollTop = 600; first.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame(); await frame();
    const before = captureAnchor(first)!;
    await select(2); await select(1);
    await pause(500); await frame();
    const after = captureAnchor(document.querySelector<HTMLElement>(".cw-main-conversation .convo-scroll")!)!;
    const restoredEditor = document.querySelector<HTMLElement>(".cw-main-conversation [contenteditable=true]")!;
    const result = { sameItem: before.itemId === after.itemId, offsetDelta: after.offset - before.offset,
      draftPreserved: restoredEditor.textContent === "draft survives view release", oldDomReleased: !editor.isConnected && restoredEditor !== editor };
    if (!result.sameItem || Math.abs(result.offsetDelta) > 2 || !result.draftPreserved || !result.oldDomReleased) throw new Error(`Reading restoration failed: ${JSON.stringify(result)}`);
    return result;
  },
  async run(count = 12) {
    sessionSwitchPerformance.stop();
    sessionSwitchPerformance.start();
    const before = sessionSwitchPerformance.snapshot(true).counters;
    const steps = [];
    for (let index = 1; index <= Math.min(count, total - 1); index++) {
      const title = sessions[index]!.title;
      const find = () => [...document.querySelectorAll<HTMLButtonElement>("#projectList .thread")].find(button => button.textContent?.includes(title));
      let button = find();
      if (!button) {
        const more = [...document.querySelectorAll<HTMLButtonElement>("#projectList button")].find(element => /Expand|展开/.test(element.textContent ?? ""));
        more?.click(); await pause(30); button = find();
      }
      if (!button) throw new Error(`Session row ${index + 1} is not visible`);
      const start = performance.now(); button.click();
      await pause(0);
      const nextTaskMs = performance.now() - start;
      await pause(100);
      steps.push({ index, nextTaskMs, counters: sessionSwitchPerformance.snapshot().counters });
    }
    const recording = sessionSwitchPerformance.snapshot(true);
    const result = { build: recording.build, stalled, delayMs, before, steps, after: recording.counters,
      longTasksMs: recording.events.filter(event => event.event === "longtask").map(event => event.values.durationMs), queryCounts: { ...counts.queries } };
    return result;
  },
};
declare global { interface Window { ompSessionSwitchHarness: typeof harness } }
window.ompSessionSwitchHarness = harness;
