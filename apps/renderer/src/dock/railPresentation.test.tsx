import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { SessionId, SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";
import { ContextDockPanel } from "../conversation/ContextCard";
import { WORKBENCH_PANELS } from "../panels/registry";
import { DockProvider, useDock } from "./DockContext";
import { DockRail } from "./DockRegions";
import { DockStore } from "./store";

const liveId = "live-context" as SessionId;
const archivedId = "archived-context" as SessionId;
function telemetry(percent: number): SessionTelemetrySnapshot {
  return { sessionId: liveId, capturedAt: "2026-11-01T09:00:00Z", tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
    context: { contextWindow: 100000, usedTokens: percent * 1000, percent, anchored: true, systemPromptTokens: 1000, systemToolsTokens: 1000, systemContextTokens: 0, skillsTokens: 0, messagesTokens: percent * 1000 - 2000 } };
}
let frames: FrameRequestCallback[] = [];
function flush() { act(() => { const current = frames; frames = []; current.forEach(callback => callback(0)); }); }
function geometry() {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, this.matches(".adaptive-workbench, .convo-wrap") ? 1400 : 320, this.matches(".adaptive-workbench, .convo-wrap") ? 900 : 280);
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 320, 280)] as unknown as DOMRectList);
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); frames = []; });

function Surface({ data, query, viewedSessionId = liveId }: { data: SessionTelemetrySnapshot | undefined; query: ReturnType<typeof vi.fn>; viewedSessionId?: SessionId }) {
  const { layout } = useDock();
  return <><div className="adaptive-workbench"><div className="convo-wrap"><DockRail mode={layout.rail.mode} /></div></div>
    <ContextDockPanel client={{ query } as unknown as StudioClient} liveSessionId={liveId} viewedSessionId={viewedSessionId} liveTelemetry={data} onOpenDetails={() => {}} />
  </>;
}
function setup(mode: "expanded" | "compact", data: SessionTelemetrySnapshot | undefined = telemetry(25), archived = false) {
  geometry();
  const store = new DockStore(null);
  store.dispatch({ type: "railMode", mode });
  store.dispatch({ type: "card", panel: "context", collapsed: true });
  const query = vi.fn().mockImplementation((kind: string) => Promise.resolve(kind === "session.cache.get" ? { cache: null } : { sessionId: archivedId, source: "persisted", semantics: "last-observed", telemetry: { ...telemetry(25), sessionId: archivedId } }));
  const draw = (next: SessionTelemetrySnapshot | undefined) => <DockProvider definitions={WORKBENCH_PANELS} store={store}><Surface data={next} query={query} viewedSessionId={archived ? archivedId : liveId} /></DockProvider>;
  const rendered = render(draw(data));
  flush(); flush();
  return { store, query, update: (next: SessionTelemetrySnapshot | undefined) => rendered.rerender(draw(next)) };
}

describe("rail title menus and context presentation", () => {
  it("opens panel actions on title right-click without toggling the card", () => {
    const { store } = setup("expanded");
    expect(document.querySelectorAll(".dock-card .dock-menu-button")).toHaveLength(0);
    const title = screen.getByRole("button", { name: "Environment" });
    fireEvent.contextMenu(title, { clientX: 200, clientY: 100 });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(store.getSnapshot().layout.cards.environment.collapsed).toBe(false);
    fireEvent.click(screen.getByRole("menuitem", { name: /隐藏工具|Hide tool/ }));
    expect(store.getSnapshot().layout.hidden.environment?.region).toBe("rail");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("supports Shift+F10 and returns focus to the title on Escape", () => {
    setup("expanded");
    const title = screen.getByRole("button", { name: "Environment" });
    title.focus();
    fireEvent.keyDown(title, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    flush();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(title);
  });

  it("shows live usage when Context starts folded, and retains it in the icon ring", () => {
    const { store, query, update } = setup("expanded");
    expect(document.querySelector('.has-meter-summary .dock-meter-value')?.textContent).toBe("25%");
    expect(document.querySelector(".context-card")).toBeNull();
    act(() => store.dispatch({ type: "railMode", mode: "compact" })); flush();
    expect(document.querySelector('.dock-meter-ring-value[data-category="messagesTokens"]')?.getAttribute("stroke-dasharray")).toBe("23 100");
    update(telemetry(95));
    expect(document.querySelector('.dock-meter-ring')?.getAttribute("data-tone")).toBe("danger");
    expect(document.querySelector('.dock-meter-ring-value[data-category="messagesTokens"]')?.getAttribute("stroke-dasharray")).toBe("93 100");
    fireEvent.click(document.querySelector('[data-dock-rail-icon="context"]')!); flush(); flush();
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("95");
    expect(query).toHaveBeenCalledWith("session.cache.get", { sessionId: liveId });
    expect(query).toHaveBeenCalledOnce();
  });

  it("reads historical usage for a folded header once and shares it with the compact icon", async () => {
    const { store, query } = setup("expanded", telemetry(10), true);
    await waitFor(() => expect(document.querySelector('.dock-meter-value')?.textContent).toBe("25%"));
    expect(query).toHaveBeenCalledWith("session.telemetry.read", { sessionId: archivedId });
    act(() => store.dispatch({ type: "railMode", mode: "compact" })); flush();
    expect(document.querySelector('.dock-meter-ring-value[data-category="messagesTokens"]')?.getAttribute("stroke-dasharray")).toBe("23 100");
    expect(query).toHaveBeenCalledOnce();
    expect(document.querySelector(".context-card")).toBeNull();
  });

  it("draws each native category as a different color and fraction of the full window", () => {
    const data = telemetry(25);
    setup("compact", { ...data, context: { ...data.context!, messagesTokens: 10000, systemToolsTokens: 5000, systemContextTokens: 4000, systemPromptTokens: 3000, skillsTokens: 3000 } });
    const arcs = [...document.querySelectorAll<SVGCircleElement>(".dock-meter-ring-value")];
    expect(arcs.map(arc => arc.getAttribute("stroke-dasharray"))).toEqual(["10 100", "5 100", "4 100", "3 100", "3 100"]);
    expect(arcs.map(arc => arc.getAttribute("stroke-dashoffset"))).toEqual(["0", "-10", "-15", "-19", "-22"]);
    expect(new Set(arcs.map(arc => arc.style.stroke)).size).toBe(5);
    const icon = document.querySelector('[data-dock-rail-icon="context"]')!;
    expect(icon.getAttribute("data-tip")).toContain("10k");
    fireEvent.click(icon); flush(); flush();
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("25");
    expect(document.querySelectorAll(".context-card-dot")).toHaveLength(6);
  });

  it("keeps unknown usage neutral rather than reporting zero", () => {
    const { store } = setup("expanded", { ...telemetry(25), context: null });
    expect(document.querySelector('.dock-meter-value')?.textContent).toBe("—");
    act(() => store.dispatch({ type: "railMode", mode: "compact" })); flush();
    expect(document.querySelector('.dock-meter-ring-track')).toBeTruthy();
    expect(document.querySelector('.dock-meter-ring-value')).toBeNull();
  });
});
