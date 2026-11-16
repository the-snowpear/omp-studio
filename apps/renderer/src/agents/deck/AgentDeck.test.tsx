import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { AgentDeck, type DeckLinks } from "./AgentDeck";
import { buildDeck, type DeckAgent } from "./deckModel";
import { buildLanes, concurrency, replayLanes } from "./timelineModel";
import { __resetDeckUiForTests } from "./deckState";
import { __resetSwarmForTests, readSwarm, recordSwarm } from "./swarmRecorder";
import { AgentsDock } from "./AgentsDock";
import { DockProvider } from "../../dock/DockContext";
import { DockStore } from "../../dock/store";
import { I18nProvider } from "../../i18n";
import { PreviewModeProvider } from "../../preview/PreviewContext";
import { getPreviewDockAgents } from "../../preview/agentDockPreview";
import { __resetAppSettingsForTests } from "../../settings/appSettings";

const DEPS = "agent-019fcb01";
const capabilities = { capabilities: [{ id: "agent.kill", grade: "full" }, { id: "agent.revive", grade: "full" }] } as unknown as ClientBootstrap["capabilityManifest"];

function links() {
  const onOpen = vi.fn<(row: DeckAgent) => void>(), onMain = vi.fn<() => void>(), onHub = vi.fn<(row: DeckAgent) => void>();
  return { onOpen, onMain, onHub, onBtw: vi.fn<(row: DeckAgent) => void>(), canLocate: () => false, onLocate: async () => false } satisfies DeckLinks;
}

function client() {
  return {
    command: vi.fn(async () => ({ requestId: "r1" })),
    query: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getState: () => ({ commands: { r1: { status: "completed", result: {} } } }),
  } as unknown as StudioClient & { command: ReturnType<typeof vi.fn> };
}

function deck(agents: readonly StudioAgentSnapshot[], options: { links: DeckLinks; client?: StudioClient; language?: "zh" | "en"; width?: number; online?: boolean; viewingLive?: boolean }) {
  return <I18nProvider forcedLanguage={options.language ?? "zh"}>
    <AgentDeck instanceKey="test|agents" scope="test" agents={agents} ready source="live" visible width={options.width ?? 0} height={0} region="right"
      openedIds={[]} links={options.links} commandContext={{ client: options.client, capabilities, preview: false, viewingLive: options.viewingLive ?? true, online: options.online ?? true }} />
  </I18nProvider>;
}

const card = (name: RegExp) => screen.getAllByRole("button", { pressed: false }).find(button => name.test(button.getAttribute("aria-label") ?? ""))!;

beforeEach(() => { localStorage.clear(); __resetAppSettingsForTests(null); __resetDeckUiForTests(); __resetSwarmForTests(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Agents deck", () => {
  it("selects on click, opens on double-click, and the lead returns to the main conversation", () => {
    const agents = getPreviewDockAgents(true);
    const link = links();
    render(deck(agents, { links: link }));
    fireEvent.click(card(/deps 子 Agent/));
    const sheet = screen.getByRole("dialog", { name: "deps 子 Agent" });
    expect(within(sheet).getByRole("heading", { name: "deps 子 Agent" })).toBeTruthy();
    expect(link.onOpen).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole("button", { name: "关闭详情" }));
    fireEvent.doubleClick(screen.getAllByRole("button").find(button => /打开对话 · deps 子 Agent/.test(button.getAttribute("aria-label") ?? ""))!);
    expect(link.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: DEPS }));
    fireEvent.click(screen.getAllByRole("button", { name: "回到主对话" })[0]!);
    expect(link.onMain).toHaveBeenCalledOnce();
  });

  it("stops an agent only after confirmation, with the generation the user saw", async () => {
    const agents = getPreviewDockAgents(true).map(agent => agent.agentId === DEPS ? { ...agent, generation: 7 as StudioAgentSnapshot["generation"] } : agent);
    const host = client();
    const link = links();
    const view = render(deck(agents, { links: link, client: host }));
    fireEvent.click(card(/deps 子 Agent/));
    const sheet = screen.getByRole("dialog", { name: "deps 子 Agent" });
    fireEvent.click(within(sheet).getByRole("button", { name: "停止" }));
    expect(host.command).not.toHaveBeenCalled();
    view.rerender(deck(agents.map(agent => agent.agentId === DEPS ? { ...agent, generation: 8 as StudioAgentSnapshot["generation"] } : agent), { links: link, client: host }));
    const confirm = within(sheet).getByRole("alertdialog");
    await act(async () => { fireEvent.click(within(confirm).getByRole("button", { name: "停止" })); });
    expect(host.command).toHaveBeenCalledWith("agent.kill", { agentId: DEPS, expectedGeneration: 7 });
    expect(await within(sheet).findByText("已请求停止 deps 子 Agent")).toBeTruthy();
  });

  it("never sends commands from preview", () => {
    localStorage.setItem("omp.previewMode", "1");
    const host = client();
    render(<PreviewModeProvider switchEnabled>{deck(getPreviewDockAgents(true), { links: links(), client: host })}</PreviewModeProvider>);
    fireEvent.click(card(/deps 子 Agent/));
    const stop = within(screen.getByRole("dialog", { name: "deps 子 Agent" })).getByRole("button", { name: "停止" });
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    expect(stop.getAttribute("data-tip")).toBe("预览模式");
    expect(host.command).not.toHaveBeenCalled();
  });

  it("keeps a pending stop unavailable when the connection drops or the deck becomes read-only", () => {
    const agents = getPreviewDockAgents(true), host = client(), link = links();
    const view = render(deck(agents, { links: link, client: host }));
    fireEvent.click(card(/deps 子 Agent/));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "停止" }));
    view.rerender(deck(agents, { links: link, client: host, online: false }));
    const confirm = screen.getByRole("alertdialog");
    const stop = within(confirm).getByRole("button", { name: "停止" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(stop.getAttribute("data-tip")).toBe("未连接");
    view.rerender(deck(agents, { links: link, client: host, viewingLive: false }));
    expect(stop.disabled).toBe(true);
    expect(stop.getAttribute("data-tip")).toBe("历史会话只读");
    fireEvent.click(stop);
    expect(host.command).not.toHaveBeenCalled();
  });

  it("keeps the crew order when agents change status", () => {
    const agents = getPreviewDockAgents(true);
    const view = render(deck(agents, { links: links() }));
    const order = () => [...document.querySelectorAll(".ad-card-name strong")].map(node => node.textContent);
    const before = order();
    view.rerender(deck(agents.map(agent => agent.kind === "main" ? agent : { ...agent, status: agent.status === "running" ? "idle" : "running" }), { links: links() }));
    expect(order()).toEqual(before);
  });

  it("shows matches through folded ancestors and restores the folds when filters clear", () => {
    const agents = getPreviewDockAgents(true);
    render(deck(agents, { links: links() }));
    fireEvent.click(document.querySelector<HTMLButtonElement>(".ad-card.is-main .ad-fold")!);
    expect(document.querySelectorAll(".ad-card-name strong")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "搜索与筛选" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "typecheck" } });
    const names = () => [...document.querySelectorAll(".ad-card-name strong")].map(node => node.textContent);
    expect(names()).toContain(agents.find(agent => agent.agentId === "agent-019fcb20")!.displayName);
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(names()).toEqual([agents.find(agent => agent.kind === "main")!.displayName]);
    fireEvent.click(document.querySelector<HTMLButtonElement>('.ad-ribbon-seg[data-group="running"]')!);
    expect(names()).toContain(agents.find(agent => agent.agentId === DEPS)!.displayName);
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(names()).toHaveLength(1);
  });

  it("moves keyboard focus into the sheet, keeps Tab inside, and returns to the card on close", async () => {
    render(deck(getPreviewDockAgents(true), { links: links() }));
    const origin = card(/deps 子 Agent/);
    origin.focus();
    fireEvent.click(origin);
    const sheet = screen.getByRole("dialog", { name: "deps 子 Agent" });
    const close = within(sheet).getByRole("button", { name: "关闭详情" });
    expect(document.activeElement).toBe(close);
    expect(document.querySelector('[role="tabpanel"]')?.hasAttribute("inert")).toBe(true);
    const buttons = within(sheet).getAllByRole("button").filter(button => !(button as HTMLButtonElement).disabled);
    const first = buttons[0]!, last = buttons.at(-1)!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    await act(async () => { fireEvent.click(close); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(origin);
    expect(document.querySelector('[role="tabpanel"]')?.hasAttribute("inert")).toBe(false);
  });

  it("replays the same members across the crew, counts and inspector without future usage", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const agents = getPreviewDockAgents(true).map(agent => ({ ...agent, updatedAt: new Date(now).toISOString() }));
    render(deck(agents, { links: links(), width: 1320 }));
    fireEvent.click(card(/deps 子 Agent/));
    expect(screen.getByRole("heading", { name: "deps 子 Agent" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("slider"), { key: "Home" });
    const main = agents.find(agent => agent.kind === "main")!;
    expect([...document.querySelectorAll(".ad-card-name strong")].map(node => node.textContent)).toEqual([main.displayName]);
    expect(document.querySelector(".ad-pulse-count")?.textContent).toMatch(/^1 /);
    expect(screen.queryByRole("heading", { name: "deps 子 Agent" })).toBeNull();
    expect(document.querySelector(".ad-ins-now")).toBeNull();
    expect(document.querySelector(".ad-ins-trail")).toBeNull();
    expect([...document.querySelectorAll(".ad-metrics strong")].map(node => node.textContent)).toEqual(["—", "—", "—", "—"]);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "End" });
    expect(screen.getByRole("heading", { name: "deps 子 Agent" })).toBeTruthy();
    expect(document.querySelectorAll(".ad-card-name strong")).toHaveLength(agents.length);
  });

  it("replays captured usage and stages instead of the current snapshot", () => {
    const start = Date.now() - 90_000, now = start + 90_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const original = getPreviewDockAgents(true);
    const agents = [original.find(agent => agent.kind === "main")!, original.find(agent => agent.agentId === DEPS)!];
    const past = agents.map((agent, index) => ({ ...agent, startedAt: new Date(start + index * 9000).toISOString(), updatedAt: new Date(start + 10_000).toISOString(),
      stage: "Recorded stage", usage: { tokens: 100, cost: 1, tools: 2, requests: 3, generationTps: 4, durationMs: 1000 } }));
    recordSwarm("test", past, start + 10_000);
    const current = past.map(agent => ({ ...agent, updatedAt: new Date(now).toISOString(), stage: "Future stage",
      usage: { tokens: 10_000, cost: 100, tools: 20, requests: 30, generationTps: 40, durationMs: 80_000 } }));
    recordSwarm("test", current, now);
    const host = client();
    render(deck(current, { links: links(), client: host, width: 1320 }));
    fireEvent.click(card(/deps 子 Agent/));
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "Home" });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
    const inspector = document.querySelector<HTMLElement>(".ad-inspector")!;
    expect(within(inspector).getAllByText("Recorded stage").length).toBeGreaterThan(0);
    expect(within(inspector).queryByText("Future stage")).toBeNull();
    expect(within(inspector).getByText("100")).toBeTruthy();
    expect((within(inspector).getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".ad-metrics strong")?.textContent).toBe("200");
    expect(host.command).not.toHaveBeenCalled();
    fireEvent.keyDown(slider, { key: "End" });
    expect(within(inspector).getAllByText("Future stage").length).toBeGreaterThan(0);
  });

  it("records a zero rate when the last running agent parks and displays the current rate", async () => {
    const agents = getPreviewDockAgents(true), link = links(), store = new DockStore();
    const renderRecorded = (rows: readonly StudioAgentSnapshot[]) => <DockProvider definitions={[]} store={store}>
      <AgentsDock agents={rows} ready source="live" scope="test" openedIds={[]} links={link}
        commandContext={{ preview: false, viewingLive: true, online: true }} onOpenRoster={() => {}} onMain={() => {}} />
      {deck(rows, { links: link })}
    </DockProvider>;
    const view = render(renderRecorded(agents));
    expect(readSwarm("test").samples.at(-1)!.tps).toBeGreaterThan(0);
    view.rerender(renderRecorded(agents.map(agent => ({ ...agent, status: "parked" }))));
    expect(readSwarm("test").samples.at(-1)!.tps).toBe(0);
    await waitFor(() => expect(document.querySelector(".ad-metric-rate strong")?.textContent).toBe("0.0"));
  });

  it("keeps earlier stage events replayable while token usage streams", () => {
    const start = Date.now() - 310_000;
    const base = getPreviewDockAgents(true).find(agent => agent.agentId === DEPS)!;
    const initial = { ...base, startedAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString(), stage: "Earlier stage" };
    recordSwarm("streaming", [initial], start);
    let current = { ...initial, stage: "Current stage", updatedAt: new Date(start + 2000).toISOString() };
    recordSwarm("streaming", [current], start + 2000);
    for (let index = 1; index <= 6000; index++) {
      const at = start + 2000 + index * 50;
      current = { ...current, updatedAt: new Date(at).toISOString(), usage: { ...base.usage!, tokens: index } };
      recordSwarm("streaming", [current], at);
    }
    const lanes = buildLanes(buildDeck([current], false, true), readSwarm("streaming"), start + 310_000);
    expect(lanes[0]!.marks.map(mark => mark.text)).toContain("Earlier stage");
    const replay = replayLanes(lanes, start + 1000, true);
    expect(replay[0]!.row.stage).toBe("Earlier stage");
    expect(replay[0]!.row.tokens).toBe(base.usage!.tokens);
  });

  it("excludes parked and idle intervals from the concurrency history", () => {
    const start = Date.now() - 10_000;
    const base = getPreviewDockAgents(true).find(agent => agent.agentId === DEPS)!;
    const events = [[0, "running"], [2000, "parked"], [5000, "reviving"], [6000, "running"], [8000, "idle"]] as const;
    let current: StudioAgentSnapshot = base;
    for (const [offset, status] of events) {
      current = { ...base, status, startedAt: new Date(start).toISOString(), updatedAt: new Date(start + offset).toISOString() };
      recordSwarm("concurrency", [current], start + offset);
    }
    const lanes = buildLanes(buildDeck([current], false, true), readSwarm("concurrency"), start + 10_000);
    expect(concurrency(lanes, start, start + 10_000, start + 10_000, 10)).toEqual([1, 1, 0, 0, 0, 1, 1, 1, 0, 0]);
  });

  it("localizes command feedback in the current language, including late receipts", async () => {
    const agents = getPreviewDockAgents(true).map(agent => agent.agentId === DEPS ? { ...agent, status: "parked" as const } : agent);
    const host = client(), link = links();
    let complete!: (handle: { requestId: string }) => void;
    host.command.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const view = render(deck(agents, { links: link, client: host }));
    fireEvent.click(card(/deps 子 Agent/));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "恢复" }));
    view.rerender(deck(agents, { links: link, client: host, language: "en" }));
    await act(async () => { complete({ requestId: "r1" }); });
    expect(screen.getByText("Revive requested for deps 子 Agent")).toBeTruthy();
    view.rerender(deck(agents, { links: link, client: host }));
    expect(screen.getByText("已请求恢复 deps 子 Agent")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "deps 子 Agent" })).toBeTruthy();
  });

  it("keeps the view and the selection across zh → en → zh", () => {
    const agents = getPreviewDockAgents(true);
    const link = links();
    const view = render(deck(agents, { links: link }));
    fireEvent.click(screen.getByRole("tab", { name: "时间线" }));
    fireEvent.click(screen.getAllByRole("button").find(button => button.textContent === "deps 子 Agent" && button.classList.contains("ad-tl-label"))!);
    view.rerender(deck(agents, { links: link, language: "en" }));
    expect(screen.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("dialog", { name: "deps 子 Agent" })).toBeTruthy();
    view.rerender(deck(agents, { links: link }));
    expect(screen.getByRole("tab", { name: "时间线" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("dialog", { name: "deps 子 Agent" })).toBeTruthy();
  });

  it("lets a host page own the selection: no inspector of its own, and Esc keeps the pick", () => {
    const agents = getPreviewDockAgents(true);
    const onSelect = vi.fn<(id: string) => void>();
    const embedded = (selectedId: string | null) => <I18nProvider forcedLanguage="zh">
      <AgentDeck instanceKey="test|hub" scope="test" agents={agents} ready source="live" visible width={1100} height={640} region="hub"
        openedIds={[]} links={links()} commandContext={{ preview: false, viewingLive: true, online: true }} embedded={{ selectedId, onSelect }} />
    </I18nProvider>;
    const view = render(embedded(null));
    expect(document.querySelector(".ad")?.getAttribute("data-tier")).toBe("bridge");
    fireEvent.click(card(/deps 子 Agent/));
    expect(onSelect).toHaveBeenLastCalledWith(DEPS);
    // Nothing changes until the host answers: the pick is the host's to make.
    expect(document.querySelector('.ad-card[data-selected]')).toBeNull();
    view.rerender(embedded(DEPS));
    expect(document.querySelector('.ad-card[data-selected] .ad-card-name strong')?.textContent).toBe("deps 子 Agent");
    expect(document.querySelector(".ad-inspector, .ad-side, .ad-sheet")).toBeNull();
    // A second click picks again instead of clearing; Esc leaves the pick alone.
    fireEvent.click(screen.getAllByRole("button").find(button => /打开对话 · deps 子 Agent/.test(button.getAttribute("aria-label") ?? ""))!);
    expect(onSelect).toHaveBeenLastCalledWith(DEPS);
    fireEvent.keyDown(document.querySelector(".ad")!, { key: "Escape" });
    expect(document.querySelector('.ad-card[data-selected]')).toBeTruthy();
    view.rerender(embedded("agent-019fcb20"));
    expect(document.querySelector('.ad-card[data-selected] .ad-card-name strong')?.textContent).toBe(agents.find(agent => agent.agentId === "agent-019fcb20")!.displayName);
  });

  it("shows agent messaging as not connected in real mode, with no invented messages", () => {
    render(deck(getPreviewDockAgents(true), { links: links() }));
    fireEvent.click(screen.getByRole("tab", { name: "通讯" }));
    expect(screen.getByText("Agent 间通讯尚未接入")).toBeTruthy();
    expect(document.querySelector(".ad-post")).toBeNull();
  });
});
