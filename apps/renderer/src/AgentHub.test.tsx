import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  Generation,
  OperatorStateSnapshot,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
  StudioAgentSnapshot,
} from "@omp-studio/studio-protocol";
import { AgentHubPage } from "./AgentHub";
import { PreviewModeProvider } from "./preview/PreviewContext";

afterEach(cleanup);

beforeAll(() => {
  // The hub must run on real snapshot data in these tests, never fixtures.
  localStorage.setItem("omp.previewMode", "0");
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

function renderHub(snapshot?: OperatorStateSnapshot) {
  return render(
    <PreviewModeProvider>
      <AgentHubPage
        {...(snapshot === undefined ? {} : { snapshot })}
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
});
