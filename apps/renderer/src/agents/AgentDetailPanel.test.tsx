import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { AgentDetailPanel } from "./AgentDetailPanel";
import { AgentRosterPanel } from "./AgentRosterPanel";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_DOCK_AGENTS } from "../preview/agentDockPreview";
import { createSubagentViewBook, createSubagentViewState, subagentViewKey } from "../conversation/subagentViewState";
import type { SubagentHubTarget } from "../conversation/toolMeta";
import { DockProvider, DockPanel, DockSlot, useDock, useDockEngine } from "../dock/DockContext";
import { WORKBENCH_PANELS } from "../panels/registry";
import { locatePanel } from "../dock/model";
import { DockStore } from "../dock/store";
import { conversationPages } from "@omp-studio/testkit";
import type { SessionId } from "@omp-studio/client-contract";

beforeEach(() => {
  localStorage.setItem("omp.previewMode", "1");
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 480, 700));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 480, 700)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); window.dispatchEvent(new Event("pagehide")); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Agent dock entry points", () => {
  it("does not locate a pinned agent's delegation in a different parent conversation", () => {
    const client = { query: vi.fn(), command: vi.fn(), subscribe: () => () => {} } as unknown as StudioClient;
    render(<PreviewModeProvider switchEnabled><AgentDetailPanel target={{ agentId: "agent-019fcb01", toolCallId: "delegate" }} scope="old-parent"
      agents={[]} visible client={client} conversationClient={null} runtimeConnected={false} canSend={false} canBtw={false} contextAvailable={false}
      onMain={vi.fn()} onOpenHub={vi.fn()} onRevealSource={async () => true} /></PreviewModeProvider>);
    expect(screen.queryByRole("button", { name: "定位委派" })).toBeNull();
    expect((screen.getByRole("button", { name: "主 Agent" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("所属会话未激活 · 只读")).toBeTruthy();
  });
  it("keeps simultaneous agent drafts and content tabs independent across close and reopen", async () => {
    const book = createSubagentViewBook();
    const command = vi.fn(), query = vi.fn();
    const client = { query, command, subscribe: () => () => {} } as unknown as StudioClient;
    const first = "agent-019fcb01", second = "agent-019fcb17";
    function Views() {
      const [shown, setShown] = useState(true);
      const panel = (agentId: string) => <AgentDetailPanel key={agentId} target={{ agentId }} scope="parallel" agents={PREVIEW_DOCK_AGENTS}
        viewState={book.get(subagentViewKey("parallel", agentId))} visible client={client} conversationClient={null}
        runtimeConnected={false} canSend={false} canBtw={false} onMain={vi.fn()} onOpenHub={vi.fn()} onRevealSource={async () => false} />;
      return <><button onClick={() => setShown(value => !value)}>Toggle first</button>{shown ? panel(first) : null}{panel(second)}</>;
    }
    render(<PreviewModeProvider switchEnabled><Views /></PreviewModeProvider>);
    const pane = (agentId: string) => screen.getByRole("region", { name: `子 Agent ${agentId}` });
    const editor = (agentId: string) => within(pane(agentId)).getByRole("textbox");
    await waitFor(() => expect(editor(first)).toBeTruthy());
    editor(first).textContent = "first draft"; fireEvent.input(editor(first));
    editor(second).textContent = "second draft"; fireEvent.input(editor(second));
    fireEvent.click(within(pane(first)).getByRole("tab", { name: "详情" }));
    const toggle = screen.getByRole("button", { name: "Toggle first" });
    toggle.focus(); fireEvent.click(toggle); fireEvent.click(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(within(pane(first)).getByRole("tab", { name: "详情" }).getAttribute("aria-selected")).toBe("true");
    expect(editor(second).textContent).toBe("second draft");
    fireEvent.click(within(pane(first)).getByRole("tab", { name: "对话" }));
    expect(editor(first).textContent).toBe("first draft");
    expect(command).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("loads earlier history to restore a saved reading anchor displaced by new messages", async () => {
    localStorage.setItem("omp.previewMode", "0");
    const base = conversationPages.userAssistant;
    const query = vi.fn(async (_name: string, input: { cursor?: string }) => input.cursor
      ? { ...base, items: [{ ...base.items[0]!, itemId: "older-user", content: [{ type: "text", text: "earlier reading position" }] }], hasMoreBefore: false, olderCursor: undefined }
      : { ...base, olderCursor: "older", hasMoreBefore: true });
    const client = { query, command: vi.fn(), subscribe: () => () => {} } as unknown as StudioClient;
    const viewState = createSubagentViewState();
    viewState.reading = { following: false, rows: 2, conversationSessionId: base.sessionId,
      anchor: { itemId: "older-user", offset: 12, scrollTop: 40, scrollHeight: 1000 } };
    render(<PreviewModeProvider switchEnabled><AgentDetailPanel target={{ agentId: "agent-019fcb01" }} scope="restore" viewState={viewState}
      agents={PREVIEW_DOCK_AGENTS} visible client={client} conversationClient={client} runtimeConnected canSend={false} canBtw={false}
      parentSessionId={"history" as SessionId} liveSessionId={"live" as SessionId} onMain={vi.fn()} onOpenHub={vi.fn()} onRevealSource={async () => false} /></PreviewModeProvider>);
    await waitFor(() => expect(query).toHaveBeenCalledWith("session.transcript.readPage", { sessionId: "history", agentId: "agent-019fcb01", cursor: "older", limit: 50 }));
    await waitFor(() => expect(screen.getByText("earlier reading position")).toBeTruthy());
  });

  it("reads a historical child from its own parent and keeps it read-only despite live send capability", async () => {
    localStorage.setItem("omp.previewMode", "0");
    const query = vi.fn(async () => conversationPages.userAssistant);
    const command = vi.fn();
    const client = { query, command, subscribe: () => () => {} } as unknown as StudioClient;
    render(<PreviewModeProvider switchEnabled><AgentDetailPanel target={{ agentId: "agent-019fcb01" }} scope="history"
      agents={PREVIEW_DOCK_AGENTS} visible client={client} conversationClient={client} runtimeConnected canSend canBtw
      parentSessionId={"history" as SessionId} liveSessionId={"live" as SessionId} onMain={vi.fn()} onOpenHub={vi.fn()} onRevealSource={async () => false} /></PreviewModeProvider>);
    await waitFor(() => expect(screen.getByText("world")).toBeTruthy());
    expect(query).toHaveBeenCalledWith("session.transcript.readPage", { sessionId: "history", agentId: "agent-019fcb01", limit: 50 });
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.getByText("历史对话 · 只读")).toBeTruthy();
    expect(screen.queryByText("Thinking")).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });

  it("reuses one detail pane and editor when reopened from either entry after docking or hiding", async () => {
    const store = new DockStore(null);
    const query = vi.fn(), command = vi.fn(), onMain = vi.fn();
    const client = { query, command, subscribe: () => () => {} } as unknown as StudioClient;
    function Workbench() {
      const dock = useDock();
      const { hosts } = useDockEngine();
      const [target, setTarget] = useState<SubagentHubTarget | null>(null);
      const [book] = useState(createSubagentViewBook);
      const open = (next: SubagentHubTarget) => { setTarget(next); store.dispatch({ type: "open", panel: "agent-detail" }); };
      const location = locatePanel(dock.layout, "agent-detail");
      return <><AgentRosterPanel agents={PREVIEW_DOCK_AGENTS} visible ready onMain={onMain} onOpen={agent => open({ agentId: agent.agentId })} />
        <button onClick={() => open({ agentId: "agent-019fcb01", toolCallId: "delegation" })}>对话委派卡片</button>
        <button onClick={() => hosts.flush()}>测量面板</button>
        {location ? <div key={location.region}><DockSlot id="agent-detail" /></div> : null}
        <DockPanel id="agent-detail">{visibility => <AgentDetailPanel target={target} scope="local:parent" agents={PREVIEW_DOCK_AGENTS}
          {...(target ? { viewState: book.get(subagentViewKey("local:parent", target.agentId)) } : {})}
          visible={visibility.visible} client={client} conversationClient={null} runtimeConnected={false} canSend={false} canBtw={false}
          onMain={onMain} onOpenHub={vi.fn()} onRevealSource={async () => true} />}</DockPanel></>;
    }
    render(<PreviewModeProvider switchEnabled><DockProvider definitions={WORKBENCH_PANELS} store={store}><Workbench /></DockProvider></PreviewModeProvider>);
    fireEvent.click(screen.getByRole("button", { name: "打开子 Agent deps 子 Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "测量面板" }));
    await waitFor(() => expect(document.querySelector('.subagent-convo [contenteditable="true"]')).not.toBeNull());
    const editor = document.querySelector<HTMLElement>('.subagent-convo [contenteditable="true"]')!;
    editor.textContent = "保留这份 deps 草稿";
    fireEvent.input(editor);
    expect(document.querySelectorAll('[data-panel="agent-detail"]')).toHaveLength(1);
    expect(document.querySelector('.subagent-convo .convo-scroll .convo-doc .ev-body')).not.toBeNull();
    act(() => store.dispatch({ type: "move", panels: ["agent-detail"], target: { region: "bottom" } }));
    fireEvent.click(screen.getByRole("button", { name: "测量面板" }));
    fireEvent.click(screen.getByRole("button", { name: "对话委派卡片" }));
    expect(locatePanel(store.getSnapshot().layout, "agent-detail")?.region).toBe("bottom");
    expect(document.querySelector('.subagent-convo [contenteditable="true"]')).toBe(editor);
    expect(editor.textContent).toBe("保留这份 deps 草稿");
    act(() => store.dispatch({ type: "hide", panels: ["agent-detail"] }));
    fireEvent.click(screen.getByRole("button", { name: "测量面板" }));
    fireEvent.click(screen.getByRole("button", { name: "对话委派卡片" }));
    fireEvent.click(screen.getByRole("button", { name: "测量面板" }));
    expect(locatePanel(store.getSnapshot().layout, "agent-detail")?.region).toBe("bottom");
    expect(editor.textContent).toBe("保留这份 deps 草稿");
    fireEvent.click(screen.getByRole("button", { name: "打开子 Agent preview 子 Agent" }));
    await waitFor(() => expect(document.querySelector('.agent-detail-identity h2')?.textContent).toContain("preview"));
    expect(document.querySelector('.subagent-convo [contenteditable="true"]')?.textContent).not.toContain("保留这份 deps 草稿");
    fireEvent.click(screen.getByRole("button", { name: "对话委派卡片" }));
    await waitFor(() => expect(document.querySelector('.subagent-convo [contenteditable="true"]')?.textContent).toBe("保留这份 deps 草稿"));
    fireEvent.click(screen.getByRole("button", { name: "返回主 Agent 对话" }));
    expect(onMain).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });
});
