import { afterEach, expect, it, vi } from "vitest";
import { contractFixtures } from "@omp-studio/testkit";
import type { ClientEvent, ConversationTranscriptReadPage, SessionId, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { acquireProjectReads, bindProjectReads, DisplayCache, invalidateProjectHistoryReads, WARM_SESSION_BUDGET } from "./projectReads";

afterEach(() => vi.useRealTimers());

it("a configuration write prevents an older read from replacing the new settings", async () => {
  vi.useFakeTimers();
  let resolveOld!: (value: object) => void;
  const query = vi.fn().mockReturnValueOnce(new Promise<object>(resolve => { resolveOld = resolve; })).mockResolvedValue({ version: "new" });
  const target = { subscribe: () => () => {}, openContext: async () => ({ query, close: async () => {}, subscribe: () => () => {} }) } as unknown as StudioClient;
  const handle = acquireProjectReads(target, "workspace" as WorkspaceId);
  const old = handle.reads.read("skills.get", {});
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  handle.reads.observe({ kind: "command.receipt", authorityEpoch: 1, receipt: { status: "completed", commandName: "skills.setEnabled" } } as ClientEvent);
  const fresh = handle.reads.read("skills.get", {});
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
  resolveOld({ version: "old" });
  await old; expect(await fresh).toEqual({ version: "new" });
  expect(await handle.reads.read("skills.get", {})).toEqual({ version: "new" });
  handle.release(); await vi.runAllTimersAsync();
});

it("a late context opening cannot subscribe or replace a reopened project's connection", async () => {
  vi.useFakeTimers();
  let finishOld!: (client: StudioClient) => void;
  const old = { query: vi.fn(), close: vi.fn(async () => {}), subscribe: vi.fn(() => () => {}) };
  const current = { query: vi.fn(async () => ({})), close: vi.fn(async () => {}), subscribe: vi.fn(() => () => {}) };
  const openContext = vi.fn().mockReturnValueOnce(new Promise<StudioClient>(resolve => { finishOld = resolve; })).mockResolvedValue(current);
  const target = { subscribe: () => () => {}, openContext } as unknown as StudioClient;
  const first = acquireProjectReads(target, "workspace" as WorkspaceId);
  const pending = first.reads.read("skills.get", {});
  const rejected = expect(pending).rejects.toThrow("closed while opening");
  first.release(); await vi.advanceTimersByTimeAsync(30_001);
  const second = acquireProjectReads(target, "workspace" as WorkspaceId);
  await second.reads.read("projects.list", {});
  finishOld(old as unknown as StudioClient); await rejected;
  await second.reads.read("history.list", {});
  expect(openContext).toHaveBeenCalledTimes(2);
  expect(old.close).toHaveBeenCalledTimes(1); expect(old.subscribe).not.toHaveBeenCalled(); expect(old.query).not.toHaveBeenCalled();
  expect(current.subscribe).toHaveBeenCalledTimes(1);
  second.release(); await vi.runAllTimersAsync(); expect(current.close).toHaveBeenCalledTimes(1);
});

it("reopening a conversation reuses project data and releases the project context after grace", async () => {
  vi.useFakeTimers();
  const query = vi.fn(async () => ({ entries: [] })), close = vi.fn(async () => {});
  const target = { subscribe: () => () => {}, openContext: vi.fn(async () => ({ query, close, subscribe: () => () => {} })) } as unknown as StudioClient;
  const a = acquireProjectReads(target, "workspace" as WorkspaceId);
  await Promise.all([a.reads.read("skills.get", {}), a.reads.read("skills.get", {})]);
  a.release();
  await vi.advanceTimersByTimeAsync(500);
  const b = acquireProjectReads(target, "workspace" as WorkspaceId);
  await b.reads.read("skills.get", {});
  expect(query).toHaveBeenCalledTimes(1); expect(target.openContext).toHaveBeenCalledTimes(1);
  b.release(); await vi.advanceTimersByTimeAsync(30_000);
  expect(close).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300_001);
});

it("page data is scoped to target, workspace, session and revision; equal rows keep identity", () => {
  vi.useFakeTimers();
  const target = { subscribe: () => () => {} } as unknown as StudioClient;
  const a = acquireProjectReads(target, "one" as WorkspaceId), b = acquireProjectReads(target, "two" as WorkspaceId);
  const fixture = contractFixtures.queryResponses["session.transcript.readPage"];
  if (!fixture.ok) throw new Error("fixture");
  const page = { ...fixture.result, sessionId: "session" as SessionId } as ConversationTranscriptReadPage;
  const first = a.reads.savePage(page);
  const next = a.reads.savePage({ ...structuredClone(page), transcriptRevision: "new" });
  expect(next.items[0]).toBe(first.items[0]);
  expect(b.reads.page(page.sessionId)).toBeUndefined();
  expect(a.reads.page(page.sessionId, "old")).toBeUndefined();
  expect(a.reads.page(page.sessionId, "new")).toBe(next);
  a.reads.observe({ kind: "command.receipt", authorityEpoch: 1, receipt: { status: "completed", commandName: "session.titles.inspect" } } as ClientEvent);
  expect(a.reads.page(page.sessionId, "new")).toBe(next);
  a.release(); b.release(); vi.runAllTimers();
});

it("display cache evicts by bytes and age without retaining a mounted owner", () => {
  vi.useFakeTimers();
  const cache = new DisplayCache<string>(4, 40, 30);
  cache.set("a", "1234567890", 1000); cache.set("b", "1234567890", 1000);
  expect(cache.get("a")).toBeUndefined(); expect(cache.bytes).toBeLessThanOrEqual(40);
  cache.set("large", "x".repeat(100), 1000); expect(cache.get("large")).toBeUndefined();
  vi.advanceTimersByTime(1001); expect(cache.bytes).toBe(0);
});

it("idle warming reads up to WARM_SESSION_BUDGET recent pages and is cancelled on project release", async () => {
  vi.useFakeTimers();
  const archive = contractFixtures.queryResponses["session.transcript.readPage"];
  if (!archive.ok) throw new Error("fixture");
  const query = vi.fn(async (name: string, input: { sessionId?: SessionId }) => {
    if (name === "history.list") return { entries: ["current", "one", "two", "three", "four", "five", "six", "seven"].map(sessionId => ({ sessionId })), total: 8 };
    if (name === "session.transcript.prefetch") return { status: "ready", page: { ...archive.result, sessionId: input.sessionId } };
    return {};
  });
  const target = { subscribe: () => () => {}, openContext: async () => ({ query, subscribe: () => () => {}, close: async () => {} }) } as unknown as StudioClient;
  const handle = acquireProjectReads(target, "workspace" as WorkspaceId);
  handle.reads.warm("current" as SessionId);
  await vi.advanceTimersByTimeAsync(1999); expect(query).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  expect(WARM_SESSION_BUDGET).toBe(5);
  expect(query.mock.calls.filter(call => call[0] === "session.transcript.prefetch").map(call => call[1].sessionId)).toEqual(["one", "two", "three", "four", "five"]);
  query.mockClear(); handle.reads.warm("current" as SessionId); handle.release();
  await vi.advanceTimersByTimeAsync(2001); expect(query).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
});

it("invalidates cached history.list immediately on mid-turn snapshot title updates and explicit forced refreshes", async () => {
  vi.useFakeTimers();
  let currentTitle: string | undefined;
  const query = vi.fn(async (name: string) => {
    if (name === "history.list") {
      return {
        entries: [{ sessionId: "session-live", ...(currentTitle ? { title: currentTitle } : {}) }],
        total: 1,
      };
    }
    return {};
  });
  const target = {
    subscribe: () => () => {},
    openContext: async () => ({ query, subscribe: () => () => {}, close: async () => {} }),
  } as unknown as StudioClient;
  const workspaceId = "workspace-live" as WorkspaceId;
  const handle = acquireProjectReads(target, workspaceId);
  const viewClient = { query, subscribe: () => () => {} } as unknown as StudioClient;
  bindProjectReads(viewClient, handle.reads);

  const initial = await handle.reads.read("history.list", { workspaceId, limit: 6, status: "active" });
  expect(initial.entries[0]?.title).toBeUndefined();
  expect(query).toHaveBeenCalledTimes(1);

  // Within the 3s TTL, an unchanged state stays cached.
  await handle.reads.read("history.list", { workspaceId, limit: 6, status: "active" });
  expect(query).toHaveBeenCalledTimes(1);

  // Mid-turn snapshot carrying a generated sessionTitle invalidates history.list before core.prompt completes.
  currentTitle = "审查对话标题链路";
  handle.reads.observe({
    kind: "snapshot",
    authorityEpoch: "auth-1",
    snapshot: { sessionId: "session-live", sessionTitle: currentTitle, sessionTitleSource: "auto", isStreaming: true },
  } as unknown as ClientEvent);

  const afterSnapshot = await handle.reads.read("history.list", { workspaceId, limit: 6, status: "active" });
  expect(afterSnapshot.entries[0]?.title).toBe("审查对话标题链路");
  expect(query).toHaveBeenCalledTimes(2);

  // Explicit forced refresh invalidates ProjectReads even before another event arrives.
  currentTitle = "手动重命名后的标题";
  invalidateProjectHistoryReads(viewClient, workspaceId);
  const afterForce = await handle.reads.read("history.list", { workspaceId, limit: 6, status: "active" });
  expect(afterForce.entries[0]?.title).toBe("手动重命名后的标题");
  expect(query).toHaveBeenCalledTimes(3);

  handle.release();
  await vi.runAllTimersAsync();
});
