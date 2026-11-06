import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { AgentRosterMeter, buildAgentRosterMeter } from "./AgentRosterMeter";
import { DockProvider } from "../dock/DockContext";
import { DockRail } from "../dock/DockRegions";
import { DockStore } from "../dock/store";
import { WORKBENCH_PANELS } from "../panels/registry";
import { PREVIEW_DOCK_AGENTS } from "../preview/agentDockPreview";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Agent status in dock chrome", () => {
  it("updates initially folded headers and compact icons without mounting an Agent body", () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1400, 900));
    const store = new DockStore(null);
    store.dispatch({ type: "railMode", mode: "expanded" });
    store.dispatch({ type: "card", panel: "agents", collapsed: true });
    let agents: readonly StudioAgentSnapshot[] = PREVIEW_DOCK_AGENTS;
    const draw = (mode: "expanded" | "compact", source: "live" | "offline" = "live") =>
      <DockProvider definitions={WORKBENCH_PANELS} store={store}><div className="adaptive-workbench"><div className="convo-wrap"><DockRail mode={mode} /></div></div>
        <AgentRosterMeter agents={agents} ready source={source} /></DockProvider>;
    const view = render(draw("expanded"));
    expect(screen.getByRole("button", { name: /Agents · 3 个子代理 · 1 失败 · 2 运行/ })).toBeTruthy();
    expect(document.querySelector(".agent-roster")).toBeNull();
    agents = agents.map(agent => agent.kind === "main" ? agent : { ...agent, status: "idle" });
    view.rerender(draw("expanded"));
    expect(screen.getByRole("button", { name: /Agents · 3 个子代理 · 3 未运行/ })).toBeTruthy();
    act(() => store.dispatch({ type: "railMode", mode: "compact" }));
    view.rerender(draw("compact", "offline"));
    const icon = screen.getByRole("button", { name: /Agents · 已断连 · 3 个子代理 · 3 未运行/ });
    expect(icon.querySelector(".dock-meter-badge")?.textContent).toBe("3");
    expect(icon.querySelector('.dock-meter-ring-value[data-category="inactive"]')?.getAttribute("stroke-dasharray")).toBe("100 100");
    expect(icon.getAttribute("data-tip")).toContain("上次收到的状态");
    expect(document.querySelector(".agent-roster")).toBeNull();
  });

  it("keeps preview waiting states isolated, and distinguishes loading from an empty roster", () => {
    const base = { agents: PREVIEW_DOCK_AGENTS, ready: true, source: "live" as const, zh: true, marks: false };
    const demo = buildAgentRosterMeter({ ...base, preview: true });
    expect(demo.counts.map(item => [item.id, item.count])).toEqual([["failed", 1], ["waiting", 1], ["running", 1]]);
    expect(demo.label).not.toContain("演示");
    expect(buildAgentRosterMeter({ ...base, preview: false }).counts.some(item => item.id === "waiting")).toBe(false);
    expect(buildAgentRosterMeter({ ...base, preview: false, ready: false }).emptyLabel).toBe("读取中");
    expect(buildAgentRosterMeter({ ...base, preview: false, agents: [PREVIEW_DOCK_AGENTS[0]!] }).emptyLabel).toBe("无子代理");
  });
});
