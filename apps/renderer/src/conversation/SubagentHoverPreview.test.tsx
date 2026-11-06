import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEvent, ConversationRuntimeEvent, SessionId } from "@omp-studio/client-contract";
import type { AgentId, Generation, RuntimeEpoch, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { conversationPages } from "@omp-studio/testkit";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { __resetAppSettingsForTests, updateAppSettings } from "../settings/appSettings";
import { BatchChain } from "./BatchChain";
import { SubagentHoverProvider } from "./SubagentHoverPreview";
import { activeSubagentConversationEngineCount, type SubagentConversationClient } from "./subagentConversationEngine";
import { conversationViewLeases } from "./conversationViews";
import type { ToolView } from "./conversationViewModel";

const parent = "parent" as SessionId;
const epoch = 7 as RuntimeEpoch;
const tool: ToolView = {
  toolCallId: "delegation", toolName: "task", status: "succeeded",
  arguments: { agents: [
    { id: "renderer", name: "Renderer", status: "running", task: "Review the conversation layout", lastTool: "Read · BatchChain.tsx" },
    { id: "docs", name: "Docs", status: "done", task: "Read the release notes" },
  ] },
};
const liveAgent: StudioAgentSnapshot = {
  agentId: "renderer" as AgentId, generation: 1 as Generation, kind: "task", displayName: "Renderer",
  status: "running", resolvedModel: "provider/model", modelRole: "scout", assignment: "Review the conversation layout",
  stage: "Checking Markdown and tools", updatedAt: "2026-11-04T00:00:00Z",
  hasLiveSession: true, hasTranscript: true, unreadCount: 0, activeJobIds: [],
};

function opened(agentId: string, text = `Initial **${agentId}** reply`) {
  const sessionId = `child-${agentId}` as SessionId;
  return { target: { kind: "agent", parentSessionId: parent, agentId, conversationSessionId: sessionId },
    page: { ...conversationPages.userAssistant, runtimeEpoch: epoch, sessionId,
      items: [{ kind: "message", itemId: `${agentId}-initial`, parentId: null, createdAt: "2026-11-04T00:00:00Z", role: "assistant", content: [{ type: "text", text }] }],
      hasMoreBefore: true, olderCursor: "older" },
    live: { status: "complete", watermark: 0, events: [] } };
}

function clientFixture(queryResult?: (agentId: string) => Promise<unknown>) {
  const listeners = new Set<(event: ClientEvent) => void>();
  const query = vi.fn(async (_name: string, input: { target: { agentId: string } }) =>
    queryResult ? queryResult(input.target.agentId) : opened(input.target.agentId));
  const subscribe = vi.fn((_scope: unknown, listener: (event: ClientEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const client = { query, subscribe } as unknown as SubagentConversationClient;
  let seq = 0;
  return { client, query, subscribe, listeners,
    emit(update: ConversationRuntimeEvent) {
      const event = { kind: "conversation.changed", sessionId: update.sessionId, streamSeq: ++seq, update } as ClientEvent;
      for (const listener of listeners) listener(event);
    } };
}

function Surface({ client, scope = "parent", runtimeConnected = true, agents = [liveAgent], onInspect = vi.fn(), inputTool = tool }: {
  client: SubagentConversationClient | null; scope?: string; runtimeConnected?: boolean;
  agents?: readonly StudioAgentSnapshot[]; onInspect?: ReturnType<typeof vi.fn>; inputTool?: ToolView;
}) {
  return <PreviewModeProvider switchEnabled>
    <SubagentHoverProvider scope={scope} client={client} agents={agents} runtimeConnected={runtimeConnected}
      parentSessionId={parent} liveSessionId={parent}>
      <main className="convo-scroll" data-testid="parent-scroll">
        <BatchChain items={[{ kind: "tool", tool: inputTool }]} batchKey="delegation" liveAgents={agents} onInspectSubagent={onInspect} />
      </main>
    </SubagentHoverProvider>
  </PreviewModeProvider>;
}

async function advance(ms = 300) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function frames(count = 3) {
  for (let index = 0; index < count; index++) await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
}
function rendererCard() { return screen.getByRole("button", { name: /Renderer.*打开对话/ }); }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  window.history.replaceState(null, "", "/?marks=off");
  window.localStorage.removeItem("omp.previewMode");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetAppSettingsForTests(null);
  window.history.replaceState(null, "", "/");
});

describe("subagent hover preview", () => {
  it("waits 300ms before reading, renders Markdown, and clicking opens the original agent", async () => {
    const host = clientFixture();
    const inspect = vi.fn();
    const base = activeSubagentConversationEngineCount();
    render(<Surface client={host.client} onInspect={inspect} />);
    const card = rendererCard();
    expect(card.querySelector("[data-tip], [title]")).toBeNull();
    fireEvent.pointerEnter(card, { pointerType: "mouse" });
    await advance(299);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(host.query).not.toHaveBeenCalled();
    expect(activeSubagentConversationEngineCount()).toBe(base);
    await advance(1);
    await frames();
    const preview = screen.getByRole("tooltip");
    expect(within(preview).getByText("renderer", { selector: "strong" })).toBeTruthy();
    expect(within(preview).getByText("provider/model")).toBeTruthy();
    expect(within(preview).queryByText("最近动态")).toBeNull();
    expect(preview.textContent).not.toContain("Checking Markdown and tools");
    expect(host.query).toHaveBeenCalledExactlyOnceWith("conversation.open", { target: { kind: "agent", parentSessionId: parent, agentId: "renderer" }, limit: 50 });
    expect(host.listeners.size).toBe(1);
    fireEvent.click(card);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(host.listeners.size).toBe(0);
    expect(activeSubagentConversationEngineCount()).toBe(base);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ agentId: "renderer", toolCallId: "delegation" }));
  });

  it.each(["leave", "escape", "scroll", "window blur", "focus blur"])("closes immediately on %s and releases the visible child lease", async reason => {
    const host = clientFixture();
    const report = vi.fn(async () => {});
    vi.stubGlobal("ompStudioChrome", { setConversationViewState: report });
    conversationViewLeases.setEpoch(Number(epoch));
    const base = activeSubagentConversationEngineCount();
    render(<Surface client={host.client} />);
    const card = rendererCard();
    if (reason === "focus blur") fireEvent.focus(card);
    else fireEvent.pointerEnter(card);
    await advance();
    await frames();
    const preview = screen.getByRole("tooltip");
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ visibleSessionIds: ["child-renderer"] }));
    // Following the preview's own content must never dismiss it.
    fireEvent.scroll(preview.querySelector(".sa-hover-scroll")!);
    expect(screen.getByRole("tooltip")).toBe(preview);
    if (reason === "leave") fireEvent.pointerLeave(card);
    if (reason === "escape") fireEvent.keyDown(card, { key: "Escape" });
    if (reason === "scroll") fireEvent.scroll(screen.getByTestId("parent-scroll"));
    if (reason === "window blur") fireEvent(window, new Event("blur"));
    if (reason === "focus blur") fireEvent.blur(card);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(host.listeners.size).toBe(0);
    expect(activeSubagentConversationEngineCount()).toBe(base);
    await act(async () => { await Promise.resolve(); });
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ visibleSessionIds: [] }));
  });

  it("cancels a brief sweep without reading or reopening after the delay", async () => {
    const host = clientFixture();
    render(<Surface client={host.client} />);
    fireEvent.pointerEnter(rendererCard());
    await advance(150);
    fireEvent.pointerLeave(rendererCard());
    await advance(1000);
    expect(host.query).not.toHaveBeenCalled();
    expect(host.subscribe).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("lets keyboard users preview an assignment before the agent identity is available", async () => {
    const host = clientFixture();
    const inputTool: ToolView = { toolCallId: "starting", toolName: "task", status: "succeeded", arguments: { name: "New worker", agent: "explorer", task: "Inspect the layout" } };
    render(<Surface client={host.client} agents={[]} inputTool={inputTool} />);
    const card = screen.getByRole("group", { name: /New worker.*缺少 Agent 身份/ });
    expect(card.tabIndex).toBe(0);
    fireEvent.focus(card);
    await advance();
    await frames();
    expect(screen.getByRole("tooltip").textContent).toContain("Inspect the layout");
    expect(screen.getByRole("tooltip").textContent).toContain("没有可读取的子 Agent 对话");
    expect(host.query).not.toHaveBeenCalled();
    expect(screen.getByRole("tooltip").querySelector(".sa-hover-foot")).toBeNull();
  });

  it("streams complete Markdown and tool output, then keeps the read content when offline", async () => {
    const host = clientFixture();
    const { rerender } = render(<Surface client={host.client} />);
    fireEvent.pointerEnter(rendererCard());
    await advance();
    await frames();
    const sessionId = "child-renderer" as SessionId;
    const turnId = "turn", messageId = "live-message", toolCallId = "live-check";
    await act(async () => {
      host.emit({ kind: "conversation.message.started", sessionId, turnId, messageId, role: "assistant", createdAt: "now" });
      host.emit({ kind: "conversation.message.delta", sessionId, turnId, messageId, blockId: "text", blockType: "text", delta: "Streaming **status**\n\n```ts\nconst answer = 42;\n```" });
      host.emit({ kind: "conversation.tool.started", sessionId, turnId, messageId, toolCallId, toolName: "bash", arguments: { command: "npm run typecheck" }, startedAt: "now" });
      host.emit({ kind: "conversation.tool.updated", sessionId, turnId, toolCallId, updateMode: "append", output: "Checking exports…\n" });
    });
    await frames(4);
    const preview = screen.getByRole("tooltip");
    expect(within(preview).getByText("status", { selector: "strong" })).toBeTruthy();
    expect(preview.querySelector("pre code")?.textContent).toContain("const answer = 42;");
    expect(preview.querySelector('[data-tool-call-id="live-check"] .codeblock')?.textContent).toContain("Checking exports…");
    await act(async () => {
      host.emit({ kind: "conversation.tool.updated", sessionId, turnId, toolCallId, updateMode: "append", output: "TypeScript passed.\n" });
    });
    await frames();
    expect(preview.querySelector('[data-tool-call-id="live-check"] .codeblock')?.textContent).toContain("TypeScript passed.");
    rerender(<Surface client={host.client} runtimeConnected={false} />);
    expect(host.listeners.size).toBe(0);
    expect(within(screen.getByRole("tooltip")).getByText("已离线")).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toContain("TypeScript passed.");
    expect(host.query).toHaveBeenCalledTimes(1);
    fireEvent.pointerLeave(rendererCard());
    expect(host.listeners.size).toBe(0);
  });

  it("switches agents without flashing a late response from the previous reader", async () => {
    let resolveRenderer!: (value: unknown) => void;
    const host = clientFixture(async id => id === "renderer" ? new Promise(resolve => { resolveRenderer = resolve; }) : opened(id, "Current **docs** reply"));
    render(<Surface client={host.client} />);
    fireEvent.pointerEnter(rendererCard());
    await advance();
    expect(screen.getByRole("tooltip").querySelector(".sa-hover-skeleton")).toBeTruthy();
    fireEvent.pointerLeave(rendererCard());
    fireEvent.pointerEnter(screen.getByRole("button", { name: /Docs.*打开对话/ }));
    await advance();
    await frames();
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip").textContent).toContain("Current docs reply");
    await act(async () => { resolveRenderer(opened("renderer", "Late renderer reply")); });
    await frames();
    expect(screen.getByRole("tooltip").textContent).not.toContain("Late renderer reply");
    expect(host.listeners.size).toBe(1);
    expect(host.query).toHaveBeenCalledTimes(2);
  });

  it("uses the main conversation's Thinking and tool display settings", async () => {
    updateAppSettings({ showThinkingSummary: false, toolActivity: "hidden" });
    const host = clientFixture();
    render(<Surface client={host.client} />);
    fireEvent.pointerEnter(rendererCard());
    await advance();
    await frames();
    const sessionId = "child-renderer" as SessionId;
    await act(async () => {
      host.emit({ kind: "conversation.message.started", sessionId, turnId: "turn", messageId: "live", role: "assistant", createdAt: "now" });
      host.emit({ kind: "conversation.message.delta", sessionId, turnId: "turn", messageId: "live", blockId: "thinking", blockType: "thinking", delta: "Hidden reasoning" });
      host.emit({ kind: "conversation.message.delta", sessionId, turnId: "turn", messageId: "live", blockId: "text", blockType: "text", delta: "Visible **answer**" });
      host.emit({ kind: "conversation.tool.started", sessionId, turnId: "turn", messageId: "live", toolCallId: "tool", toolName: "bash", arguments: { command: "npm run typecheck" }, startedAt: "now" });
    });
    await frames();
    const preview = screen.getByRole("tooltip");
    expect(within(preview).getByText("answer", { selector: "strong" })).toBeTruthy();
    expect(preview.textContent).not.toContain("Hidden reasoning");
    expect(preview.querySelector(".tl-item")).toBeNull();
  });

  it("closes during a session switch and ignores the unresolved old read", async () => {
    let resolve!: (value: unknown) => void;
    const host = clientFixture(() => new Promise(done => { resolve = done; }));
    const { rerender } = render(<Surface client={host.client} />);
    fireEvent.pointerEnter(rendererCard());
    await advance();
    rerender(<Surface client={host.client} scope="another-session" />);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(host.listeners.size).toBe(0);
    await act(async () => { resolve(opened("renderer")); });
    await frames();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(host.query).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending hover when the execution client changes", async () => {
    const local = clientFixture(), remote = clientFixture();
    const { rerender } = render(<Surface client={local.client} />);
    fireEvent.pointerEnter(rendererCard());
    await advance(150);
    rerender(<Surface client={remote.client} />);
    await advance(300);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(local.query).not.toHaveBeenCalled();
    expect(remote.query).not.toHaveBeenCalled();
    fireEvent.pointerLeave(rendererCard());
    fireEvent.pointerEnter(rendererCard());
    await advance();
    await frames();
    expect(remote.query).toHaveBeenCalledOnce();
    expect(local.query).not.toHaveBeenCalled();
  });

  it("reopens the reader for a new agent generation without retaining the previous content", async () => {
    let resolve!: (value: unknown) => void;
    const host = clientFixture(() => new Promise(done => { resolve = done; }));
    const { rerender } = render(<Surface client={host.client} />);
    fireEvent.pointerEnter(rendererCard());
    await advance();
    const previous = resolve;
    rerender(<Surface client={host.client} agents={[{ ...liveAgent, generation: 2 as Generation }]} />);
    await frames();
    expect(host.query).toHaveBeenCalledTimes(2);
    await act(async () => { previous(opened("renderer", "Previous generation")); });
    expect(screen.getByRole("tooltip").textContent).not.toContain("Previous generation");
    await act(async () => { resolve(opened("renderer", "Current generation")); });
    await frames();
    expect(screen.getByRole("tooltip").textContent).toContain("Current generation");
    expect(host.listeners.size).toBe(1);
  });

  it("plays the preview stream locally, respects hidden demo marks, and releases it on leave", async () => {
    window.history.replaceState(null, "", "/?preview=1&marks=off");
    const host = clientFixture();
    const inputTool: ToolView = { ...tool, arguments: { agents: [{ id: "agent-019fcb01", name: "deps", status: "running" }] } };
    const base = activeSubagentConversationEngineCount();
    render(<Surface client={host.client} agents={[]} inputTool={inputTool} />);
    const card = screen.getByRole("button", { name: /deps.*打开对话/ });
    fireEvent.pointerEnter(card);
    await advance();
    await frames();
    expect(screen.getByRole("tooltip").textContent).toContain("已扫过 lockfile");
    await advance(2300);
    await frames();
    expect(screen.getByRole("tooltip").querySelector("pre code")?.textContent).toContain("packages.every");
    await advance(3000);
    await frames();
    expect(screen.getByRole("tooltip").textContent).toContain("TypeScript check passed.");
    expect(screen.getByRole("tooltip").textContent).not.toContain("演示");
    expect(host.query).not.toHaveBeenCalled();
    expect(host.subscribe).not.toHaveBeenCalled();
    fireEvent.pointerLeave(card);
    expect(activeSubagentConversationEngineCount()).toBe(base);
    await advance(10000);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps an empty real conversation empty and reports read failures without fixtures", async () => {
    const host = clientFixture(async id => ({ ...opened(id), page: { ...opened(id).page, items: [] } }));
    render(<Surface client={host.client} />);
    fireEvent.pointerEnter(rendererCard());
    await advance();
    await frames();
    expect(screen.getByRole("tooltip").textContent).toContain("暂无子 Agent 对话");
    expect(screen.getByRole("tooltip").textContent).not.toContain("已扫过 lockfile");
    cleanup();
    const failed = { query: vi.fn(async () => { throw new Error("Transcript unavailable"); }), subscribe: () => () => {} } as unknown as SubagentConversationClient;
    render(<Surface client={failed} />);
    fireEvent.pointerEnter(rendererCard());
    await advance();
    await frames();
    expect(screen.getByRole("tooltip").textContent).toContain("Transcript unavailable");
    expect(screen.getByRole("tooltip").textContent).not.toContain("已扫过 lockfile");
  });

  it("mounts the portal in the original card's document", async () => {
    const iframe = document.body.appendChild(document.createElement("iframe"));
    const doc = iframe.contentDocument!;
    const win = iframe.contentWindow!;
    vi.spyOn(win, "setTimeout").mockImplementation(window.setTimeout.bind(window));
    vi.spyOn(win, "clearTimeout").mockImplementation(window.clearTimeout.bind(window));
    const container = doc.body.appendChild(doc.createElement("div"));
    render(<Surface client={null} />, { container });
    const card = container.querySelector<HTMLElement>(".sa-card")!;
    fireEvent.pointerEnter(card);
    await advance();
    expect(doc.body.querySelector(".sa-hover-preview")).toBeTruthy();
    expect(document.body.querySelector(".sa-hover-preview")).toBeNull();
    fireEvent.pointerLeave(card);
    expect(doc.body.querySelector(".sa-hover-preview")).toBeNull();
    cleanup();
    iframe.remove();
  });
});
