import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRosterPanel } from "./AgentRosterPanel";
import { PREVIEW_DOCK_AGENTS } from "../preview/agentDockPreview";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { __resetAppSettingsForTests, getAppSettings } from "../settings/appSettings";

beforeEach(() => { localStorage.clear(); __resetAppSettingsForTests(null); });
afterEach(() => { cleanup(); localStorage.clear(); __resetAppSettingsForTests(null); });

describe("Agent roster density", () => {
  it("keeps the selected density after remounting and shows the actual model in single-line rows", () => {
    const onOpen = vi.fn(), onMain = vi.fn();
    const agents = PREVIEW_DOCK_AGENTS.map(agent => ({ ...agent, resolvedModel: "openai/gpt-5-mini", modelRole: "@worker" }));
    const draw = () => <AgentRosterPanel agents={agents} visible ready onOpen={onOpen} onMain={onMain} />;
    const first = render(draw());
    expect(document.querySelector(".agent-roster-task")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "极简" }));
    expect(document.querySelector(".agent-roster-task")).toBeNull();
    expect(screen.getAllByText("gpt-5-mini")).toHaveLength(4);
    const child = screen.getByRole("button", { name: "打开子 Agent deps 子 Agent" });
    expect(child.title).toContain("openai/gpt-5-mini");
    fireEvent.click(child);
    expect(onOpen).toHaveBeenCalledWith(agents[1]);
    fireEvent.click(screen.getByRole("button", { name: "返回主 Agent 对话" }));
    expect(onMain).toHaveBeenCalledOnce();
    const stored = localStorage.getItem("omp.appSettings");
    first.unmount();
    __resetAppSettingsForTests(stored);
    render(draw());
    expect(screen.getByRole("button", { name: "极简" }).getAttribute("aria-pressed")).toBe("true");
    expect(getAppSettings().agentRosterDensity).toBe("minimal");
    fireEvent.click(screen.getByRole("button", { name: "标准" }));
    expect(document.querySelector(".agent-roster-task")).toBeTruthy();
  });

  it("does not mistake a model role for a resolved model", () => {
    __resetAppSettingsForTests('{"agentRosterDensity":"minimal"}');
    const { resolvedModel: _model, ...agent } = PREVIEW_DOCK_AGENTS[1]!;
    render(<AgentRosterPanel agents={[{ ...agent, modelRole: "@smol" }]} visible ready onOpen={vi.fn()} onMain={vi.fn()} />);
    expect(screen.getByText("模型未知")).toBeTruthy();
    expect(document.querySelector(".agent-roster-model")?.textContent).not.toContain("@smol");
  });

  it("switches preview density locally without overwriting the real preference", () => {
    localStorage.setItem("omp.previewMode", "1");
    const stored = localStorage.getItem("omp.appSettings");
    render(<PreviewModeProvider switchEnabled><AgentRosterPanel agents={PREVIEW_DOCK_AGENTS} visible ready onOpen={vi.fn()} onMain={vi.fn()} /></PreviewModeProvider>);
    fireEvent.click(screen.getByRole("button", { name: "极简" }));
    expect(document.querySelector('.agent-roster[data-density="minimal"]')).toBeTruthy();
    expect(screen.getByText("gpt-5-mini")).toBeTruthy();
    expect(getAppSettings().agentRosterDensity).toBe("standard");
    expect(localStorage.getItem("omp.appSettings")).toBe(stored);
  });
});
