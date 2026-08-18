import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationPages } from "@omp-studio/testkit";
import type { StudioClient } from "@omp-studio/client-contract";
import type {
  Generation,
  OperatorStateSnapshot,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
  StudioAgentSnapshot,
} from "@omp-studio/studio-protocol";
import { AgentHubPage, setHubIntent } from "./AgentHub";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { TAB_PANE_MS } from "./pageTransition";

afterEach(cleanup);

beforeAll(() => {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;
});

beforeEach(() => {
  localStorage.setItem("omp.previewMode", "0");
  localStorage.removeItem("omp.agentHub.state");
  sessionStorage.removeItem("omp.hubIntent");
});

function snapshotAgent(overrides: Partial<StudioAgentSnapshot> = {}): StudioAgentSnapshot {
  return {
    agentId: "agent-0001",
    generation: 1 as Generation,
    kind: "sub",
    displayName: "Lockfile Auditor",
    status: "idle",
    updatedAt: "2026-08-16T00:00:00.000Z",
    hasLiveSession: true,
    hasTranscript: true,
    unreadCount: 0,
    activeJobIds: [],
    ...overrides,
  } as StudioAgentSnapshot;
}

function snapshotWith(agents: StudioAgentSnapshot[]): OperatorStateSnapshot {
  return {
    runtimeId: "rt-1" as RuntimeId,
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 1 as StateVersion,
    sessionId: "sess-1" as SessionId,
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal",
    approvalMode: "write",
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 1,
    jobsRevision: 1,
    agents,
    jobs: [],
  } as OperatorStateSnapshot;
}

function mockClient(query?: unknown): StudioClient {
  return {
    query: query ?? (async (name: string) => {
      if (name === "agent.conversation.read") return conversationPages.userAssistant;
      throw new Error(name);
    }),
    command: vi.fn(),
    subscribe: () => () => undefined,
  } as unknown as StudioClient;
}

function renderHub(
  snapshot?: OperatorStateSnapshot,
  extras: {
    preview?: boolean;
    client?: StudioClient;
    canSend?: boolean;
    runtimeConnected?: boolean;
  } = {},
) {
  localStorage.setItem("omp.previewMode", extras.preview === true ? "1" : "0");
  return render(
    <PreviewModeProvider>
      <AgentHubPage
        {...(snapshot === undefined ? {} : { snapshot })}
        {...(extras.client === undefined ? {} : { client: extras.client })}
        {...(extras.canSend === undefined ? {} : { canSend: extras.canSend })}
        {...(extras.runtimeConnected === undefined ? {} : { runtimeConnected: extras.runtimeConnected })}
        {...(extras.runtimeConnected === true ? { runtime: { status: "connected", classification: "managed" } } : {})}
        onOpenMain={() => undefined}
      />
    </PreviewModeProvider>,
  );
}

describe("AgentHubPage real-mode projection", () => {
  it("maps per-agent usage, model, and artifact fields from the runtime snapshot", () => {
    renderHub(snapshotWith([
      snapshotAgent({
        status: "parked",
        usage: { tokens: 12_600, requests: 9, tools: 14, cost: 0.51, durationMs: 167_000, durationKind: "active" },
        modelRole: "@smol",
        resolvedModel: "gemini-3.6-flash",
        readOnly: false,
        outputPath: "agent-0001.md",
        patchPath: "agent-0001.patch",
        branchName: "omp/agent-0001",
      }),
    ]));
    // Card side column: tokens + cost.
    expect(screen.getAllByText("12.6k").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$0.510").length).toBeGreaterThan(0);
    // Select the agent to open the detail pane.
    fireEvent.click(screen.getByRole("option", { name: /Lockfile Auditor/ }));
    expect(screen.getAllByText(/gemini-3\.6-flash/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/agent-0001\.md/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/omp\/agent-0001/).length).toBeGreaterThan(0);
  });

  it("shows the upstream activity gist and active jobs for running agents", () => {
    renderHub(snapshotWith([
      snapshotAgent({ status: "running", assignment: "running Grep in package-lock.json", activeJobIds: ["job-7" as StudioAgentSnapshot["activeJobIds"][number]] }),
    ]));
    fireEvent.click(screen.getByRole("option", { name: /Lockfile Auditor/ }));
    expect(screen.getAllByText(/running Grep in package-lock\.json/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/job-7/).length).toBeGreaterThan(0);
  });

  it("keeps write actions disabled without an injected Studio client", () => {
    renderHub(snapshotWith([snapshotAgent({ status: "parked" })]));
    fireEvent.click(screen.getByRole("option", { name: /Lockfile Auditor/ }));
    const revive = screen.getByRole("button", { name: /Revive/ }) as HTMLButtonElement;
    expect(revive.disabled).toBe(true);
    expect(revive.getAttribute("data-tip") ?? "").toContain("无 Studio client");
  });

  it("disables kill, revive, and send for a non-advisor read-only agent", () => {
    renderHub(snapshotWith([snapshotAgent({ status: "parked", readOnly: true })]), {
      client: mockClient(),
      runtimeConnected: true,
      canSend: true,
    });
    fireEvent.click(screen.getByRole("option", { name: /Lockfile Auditor/ }));
    const revive = screen.getByRole("button", { name: /Revive/ }) as HTMLButtonElement;
    const kill = screen.getByRole("button", { name: /Kill/ }) as HTMLButtonElement;
    const chat = screen.getByRole("button", { name: /发消息/ }) as HTMLButtonElement;
    expect(revive.disabled).toBe(true);
    expect(kill.disabled).toBe(true);
    expect(chat.disabled).toBe(true);
    expect(revive.getAttribute("data-tip") ?? "").toContain("read-only");
    expect(kill.getAttribute("data-tip") ?? "").toContain("read-only");
  });

  it("keeps the selected agent when search filters it out of the list", () => {
    renderHub(snapshotWith([snapshotAgent()]));
    fireEvent.click(screen.getByRole("option", { name: /Lockfile Auditor/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Agent" }), { target: { value: "zzz-no-match" } });
    expect(screen.getByText("没有匹配的 Agent")).toBeTruthy();
    expect(screen.queryByText("No agents in this session")).toBeNull();
    expect(screen.getByRole("button", { name: "打开" })).toBeTruthy();
    expect(screen.getAllByText("Lockfile Auditor").length).toBeGreaterThan(0);
  });
});

describe("AgentHubPage conversation preview", () => {
  it("opens a main-conversation pane, narrows the list, and restores Overview on back", async () => {
    const query = vi.fn(async (name: string) => {
      if (name === "agent.conversation.read") return conversationPages.userAssistant;
      throw new Error(name);
    });
    const client = mockClient(query);
    renderHub(snapshotWith([snapshotAgent()]), { client, runtimeConnected: true, canSend: true });
    fireEvent.click(screen.getByRole("option", { name: /Lockfile Auditor/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(document.querySelector(".hub-page.is-chat-preview")).toBeTruthy();
    expect(document.querySelector(".hub-cols.is-chat-preview")).toBeTruthy();
    expect(screen.getByRole("button", { name: "返回" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Overview" })).toBeNull();
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledWith("agent.conversation.read", { agentId: "agent-0001", limit: 50 });
      expect(screen.getByText("hello")).toBeTruthy();
      expect(screen.getByText("world")).toBeTruthy();
    });
    expect(document.querySelector(".hub-tr-msg")).toBeNull();
    expect(document.querySelector(".subagent-convo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(document.querySelector(".hub-page.is-chat-preview")).toBeNull();
    expect(screen.getByRole("tab", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开" })).toBeTruthy();
  });

  it("slides the detail pane forward on 打开 and back on 返回", async () => {
    renderHub(snapshotWith([snapshotAgent()]), { client: mockClient(), runtimeConnected: true, canSend: true });
    fireEvent.click(screen.getByRole("option", { name: /Lockfile Auditor/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(document.querySelector(".hub-face-enter-fwd")).toBeTruthy();
    expect(document.querySelector('[data-hub-face="detail"].hub-face-leave-fwd')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(document.querySelector(".hub-page.is-chat-preview")).toBeNull();
    expect(document.querySelector(".hub-face-enter-back")).toBeTruthy();
    expect(document.querySelector('[data-hub-face="chat"].hub-face-leave-back')).toBeTruthy();
    await vi.waitFor(() => {
      expect(document.querySelector(".hub-face-leave-back")).toBeNull();
    }, { timeout: TAB_PANE_MS + 200 });
  });

  it("shows ChipComposer when the selected agent can receive agent.send", async () => {
    const client = mockClient();
    renderHub(snapshotWith([snapshotAgent()]), { client, runtimeConnected: true, canSend: true });
    fireEvent.click(screen.getByRole("option", { name: /Lockfile Auditor/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    await vi.waitFor(() => {
      expect(document.querySelector("#hubAgentComposer")).toBeTruthy();
      expect(screen.getByRole("button", { name: "附件 / 图片" })).toBeTruthy();
    });
  });

  it("shows a local ChipComposer in Studio preview and never queries Host", () => {
    const query = vi.fn();
    const command = vi.fn();
    const client = {
      ...mockClient(query),
      command,
    };
    renderHub(undefined, { preview: true, client, runtimeConnected: true, canSend: true });
    fireEvent.click(screen.getByRole("option", { name: /preview 子 Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(document.querySelector(".hub-page.is-chat-preview")).toBeTruthy();
    expect(screen.getAllByText("演示").length).toBeGreaterThan(0);
    expect(screen.getByText(/全屏缩放按钮在窄窗口下仍然可点/)).toBeTruthy();
    const editor = document.querySelector("#hubAgentComposer");
    expect(editor).toBeTruthy();
    expect(editor?.getAttribute("aria-placeholder")).toMatch(/发给子 Agent/);
    fireEvent.click(screen.getByRole("button", { name: "附件 / 图片" }));
    expect(query).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it("hides the preview composer for advisor agents", () => {
    renderHub(undefined, { preview: true, runtimeConnected: true, canSend: true });
    fireEvent.click(screen.getByRole("option", { name: /Idle advisor/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(document.querySelector(".hub-page.is-chat-preview")).toBeTruthy();
    expect(document.querySelector("#hubAgentComposer")).toBeNull();
  });

  it("does not send Host commands from preview roster write actions", () => {
    const query = vi.fn();
    const command = vi.fn();
    const client = { ...mockClient(query), command };
    renderHub(undefined, { preview: true, client, runtimeConnected: true, canSend: true });
    fireEvent.click(screen.getByRole("option", { name: /audit 子 Agent/ }));
    const revive = screen.getByRole("button", { name: /Revive/ }) as HTMLButtonElement;
    expect(revive.disabled).toBe(true);
    expect(revive.getAttribute("data-tip") ?? "").toContain("预览模式");
    fireEvent.click(screen.getByRole("option", { name: /typecheck 子 Agent/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Jobs" }));
    const cancel = screen.getByRole("button", { name: "取消" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    expect(command).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("opens conversation preview from a chat hub intent", async () => {
    const query = vi.fn(async (name: string) => {
      if (name === "agent.conversation.read") return conversationPages.userAssistant;
      throw new Error(name);
    });
    setHubIntent("agent-0001", "chat");
    renderHub(snapshotWith([snapshotAgent()]), {
      client: mockClient(query),
      runtimeConnected: true,
      canSend: true,
    });
    expect(screen.getByRole("button", { name: "返回" })).toBeTruthy();
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledWith("agent.conversation.read", { agentId: "agent-0001", limit: 50 });
      expect(screen.getByText("hello")).toBeTruthy();
    });
  });

  it("keeps a hub chat intent until the roster contains that agent", async () => {
    const query = vi.fn(async (name: string) => {
      if (name === "agent.conversation.read") return conversationPages.userAssistant;
      throw new Error(name);
    });
    const client = mockClient(query);
    setHubIntent("agent-0001", "chat");
    const { rerender } = renderHub(undefined, { client, runtimeConnected: true, canSend: true });
    expect(screen.queryByRole("button", { name: "返回" })).toBeNull();
    rerender(
      <PreviewModeProvider>
        <AgentHubPage
          snapshot={snapshotWith([snapshotAgent()])}
          client={client}
          canSend
          runtimeConnected
          runtime={{ status: "connected", classification: "managed" }}
          onOpenMain={() => undefined}
        />
      </PreviewModeProvider>,
    );
    expect(screen.getByRole("button", { name: "返回" })).toBeTruthy();
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledWith("agent.conversation.read", { agentId: "agent-0001", limit: 50 });
    });
  });

  it("ignores invalid hub intent ids", () => {
    setHubIntent("Main", "chat");
    expect(sessionStorage.getItem("omp.hubIntent")).toBeNull();
  });
});
