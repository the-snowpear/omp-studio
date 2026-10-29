import { createRoot } from "react-dom/client";
import { StudioClientImpl } from "@omp-studio/client";
import { createContractFixtureApi } from "@omp-studio/testkit";
import type { ClientEvent, ClientTransport } from "@omp-studio/client-contract";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "./settings/startupNotice";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/sidebar.css";
import "./styles/workbench.css";
import "./styles/pages.css";
import "./styles/agent-hub.css";
import "./styles/models-roles.css";
import "./styles/btw.css";
import "./styles/typography.css";
import "./App.css";

localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
localStorage.setItem("omp.appSettings", JSON.stringify({ language: "en", theme: "light", startupPage: "workbench", restoreLastSession: false, rememberLayout: false }));
localStorage.setItem("omp.lastRoute", "workbench");
localStorage.removeItem("omp.background");
const fixture = createContractFixtureApi();
const initial = await fixture.bootstrap();
fixture.overrideBootstrap({ ...initial, cursor: "0" });
const queryCounts: Record<string, number> = {};
const transport: ClientTransport = {
  bootstrap: () => fixture.bootstrap(),
  query: (request) => { queryCounts[request.queryName] = (queryCounts[request.queryName] ?? 0) + 1; return fixture.query(request); },
  command: (request) => fixture.command(request),
  subscribe: (scope, listener) => fixture.subscribe(scope, listener),
  close: () => fixture.close(),
};
const client = new StudioClientImpl(transport);
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
let cursor = 0;
const longTasks: number[] = [];
const observer = new PerformanceObserver((list) => { for (const task of list.getEntries()) longTasks.push(task.duration); });
observer.observe({ type: "longtask", buffered: true });
const { App } = await import("./App");
createRoot(document.getElementById("root")!).render(<App client={client} />);
const deadline = performance.now() + 20000;
while (!document.querySelector("#appRoot") && performance.now() < deadline) await frame();
await frame(); await frame();
const readyMs = performance.now();
const harness = {
  readyMs,
  queryCounts,
  async deltas(frames = 180) {
    longTasks.length = 0;
    const intervals: number[] = [];
    let last = performance.now();
    for (let index = 0; index < frames; index++) {
      for (let n = 0; n < 4; n++) {
        const event = {
          kind: "conversation.changed", authorityEpoch: initial.authority.authorityEpoch,
          runtimeEpoch: initial.runtime.runtimeEpoch, stateVersion: initial.stateVersion,
          cursor: String(++cursor), occurredAt: "2026-10-29T00:00:00.000Z",
          sessionId: initial.selected!.sessionId!, streamSeq: cursor, eventSeq: cursor,
          update: { kind: "conversation.message.delta", sessionId: initial.selected!.sessionId!, turnId: "perf", messageId: "perf-cursor-only", blockId: "text", blockType: "text", delta: "test " },
        } as ClientEvent;
        fixture.emit(event);
      }
      await frame();
      const now = performance.now(); intervals.push(now - last); last = now;
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    return { frames, events: frames * 4, cursor: client.getState().connection.cursor, resyncRequired: client.getState().connection.resyncRequired, intervals, p95Ms: sorted[Math.floor(sorted.length * 0.95)], longTasks: [...longTasks], queryCounts: { ...queryCounts } };
  },
};
Object.assign(window, { ompWorkbenchPerf: harness });
