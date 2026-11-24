import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionHistoryReadModel, StudioClient, WorkspaceId } from "@omp-studio/client-contract";

import {
  PROJECT_HISTORY_INITIAL_LIMIT,
  projectHistoryEntries,
  stableHistoryOrder,
  streamingProjectHistoryRefreshKey,
  useProjectHistories,
} from "./useProjectHistories";

const workspace = (value: string) => value as WorkspaceId;

function model(title: string): SessionHistoryReadModel {
  return {
    total: 1,
    entries: [{
      historyId: `history-${title}` as SessionHistoryReadModel["entries"][number]["historyId"],
      threadId: `thread-${title}` as SessionHistoryReadModel["entries"][number]["threadId"],
      environmentId: `environment-${title}` as SessionHistoryReadModel["entries"][number]["environmentId"],
      title,
      startedAt: "2026-08-23T00:00:00.000Z",
      lastActiveAt: "2026-08-23T00:00:00.000Z",
      messageCount: 1,
      status: "active",
    }],
  };
}

describe("useProjectHistories", () => {
  it("uses a stable workspace/session key only while a real session is streaming", () => {
    const input = {
      preview: false,
      isStreaming: true,
      sessionId: "session-new" as SessionHistoryReadModel["entries"][number]["sessionId"],
      workspaceId: workspace("workspace-b"),
    };
    const first = streamingProjectHistoryRefreshKey(input);
    expect(first).toBeDefined();
    expect(streamingProjectHistoryRefreshKey({ ...input })).toBe(first);
    expect(streamingProjectHistoryRefreshKey({ ...input, isStreaming: false })).toBeUndefined();
    expect(streamingProjectHistoryRefreshKey({ ...input, preview: true })).toBeUndefined();
    expect(streamingProjectHistoryRefreshKey({ ...input, workspaceId: undefined })).toBeUndefined();
  });

  it("keeps concurrent project queries in independent workspace keys", async () => {
    const resolvers = new Map<string, (value: SessionHistoryReadModel) => void>();
    const query = vi.fn((name: string, input: { workspaceId?: WorkspaceId }) => {
      expect(name).toBe("history.list");
      return new Promise<SessionHistoryReadModel>((resolve) => {
        resolvers.set(String(input.workspaceId), resolve);
      });
    });
    const client = { query } as unknown as Pick<StudioClient, "query">;
    const { result } = renderHook(() => useProjectHistories({ client, preview: false }));

    act(() => {
      void result.current.load(workspace("workspace-a"));
      void result.current.load(workspace("workspace-b"));
    });
    expect(query).toHaveBeenNthCalledWith(1, "history.list", {
      workspaceId: workspace("workspace-a"),
      limit: PROJECT_HISTORY_INITIAL_LIMIT,
      status: "active",
    });
    expect(query).toHaveBeenNthCalledWith(2, "history.list", {
      workspaceId: workspace("workspace-b"),
      limit: PROJECT_HISTORY_INITIAL_LIMIT,
      status: "active",
    });

    await act(async () => {
      resolvers.get("workspace-b")?.(model("B"));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.cache["workspace-b"]?.model?.entries[0]?.title).toBe("B"));
    expect(result.current.cache["workspace-a"]?.status).toBe("loading");

    await act(async () => {
      resolvers.get("workspace-a")?.(model("A"));
      await Promise.resolve();
    });
    await waitFor(() => expect(projectHistoryEntries(result.current.cache, "workspace-a")[0]?.title).toBe("A"));
    expect(projectHistoryEntries(result.current.cache, "workspace-b")[0]?.title).toBe("B");

    let refreshed: Promise<SessionHistoryReadModel | undefined> | undefined;
    await act(async () => {
      refreshed = result.current.refresh(workspace("workspace-b"));
      await Promise.resolve();
    });
    expect(query).toHaveBeenNthCalledWith(3, "history.list", {
      workspaceId: workspace("workspace-b"),
      limit: PROJECT_HISTORY_INITIAL_LIMIT,
      status: "active",
    });
    resolvers.get("workspace-b")?.(model("B refreshed"));
    await refreshed;
    await waitFor(() => expect(result.current.cache["workspace-b"]?.model?.entries[0]?.title).toBe("B refreshed"));
  });

  it("does not return an older same-project response to its caller", async () => {
    const resolvers: Array<(value: SessionHistoryReadModel) => void> = [];
    const query = vi.fn(() => new Promise<SessionHistoryReadModel>((resolve) => {
      resolvers.push(resolve);
    }));
    const client = { query } as unknown as Pick<StudioClient, "query">;
    const { result } = renderHook(() => useProjectHistories({ client, preview: false }));
    let first: Promise<SessionHistoryReadModel | undefined> | undefined;
    let second: Promise<SessionHistoryReadModel | undefined> | undefined;
    await act(async () => {
      first = result.current.refresh(workspace("workspace-a"));
      second = result.current.refresh(workspace("workspace-a"));
      await Promise.resolve();
    });
    resolvers[1]?.(model("new"));
    expect(await second).toEqual(model("new"));
    resolvers[0]?.(model("old"));
    expect(await first).toBeUndefined();
    await waitFor(() => expect(result.current.cache["workspace-a"]?.model?.entries[0]?.title).toBe("new"));
  });

  it("does not query Host in preview mode", async () => {
    const query = vi.fn();
    const client = { query } as unknown as Pick<StudioClient, "query">;
    const { result } = renderHook(() => useProjectHistories({ client, preview: true }));

    await act(async () => {
      await result.current.load(workspace("preview-workspace"));
    });
    expect(query).not.toHaveBeenCalled();
    expect(result.current.cache).toEqual({});
  });

  it("clears real cache when preview mode changes", async () => {
    const query = vi.fn().mockResolvedValue(model("real"));
    const client = { query } as unknown as Pick<StudioClient, "query">;
    const { result, rerender } = renderHook(({ preview }) => useProjectHistories({ client, preview }), {
      initialProps: { preview: false },
    });
    await act(async () => { await result.current.load(workspace("workspace-a")); });
    expect(result.current.cache["workspace-a"]?.model?.entries[0]?.title).toBe("real");
    rerender({ preview: true });
    await waitFor(() => expect(result.current.cache).toEqual({}));
  });

  it("replaces a cached empty project when it is refreshed after session creation", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ entries: [], total: 0 } satisfies SessionHistoryReadModel)
      .mockResolvedValueOnce(model("New session"));
    const client = { query } as unknown as Pick<StudioClient, "query">;
    const { result } = renderHook(() => useProjectHistories({ client, preview: false }));

    await act(async () => {
      await result.current.load(workspace("workspace-new"));
    });
    expect(projectHistoryEntries(result.current.cache, "workspace-new")).toEqual([]);

    await act(async () => {
      await result.current.refresh(workspace("workspace-new"));
    });
    expect(projectHistoryEntries(result.current.cache, "workspace-new")[0]?.title).toBe("New session");
    expect(query).toHaveBeenCalledTimes(2);
  });

  function entry(id: string, extra?: Partial<SessionHistoryReadModel["entries"][number]>): SessionHistoryReadModel["entries"][number] {
    type Entry = SessionHistoryReadModel["entries"][number];
    return {
      historyId: id as Entry["historyId"],
      threadId: id as Entry["threadId"],
      environmentId: id as Entry["environmentId"],
      sessionId: id as NonNullable<Entry["sessionId"]>,
      title: id,
      startedAt: "2026-08-23T00:00:00.000Z",
      lastActiveAt: "2026-08-23T00:00:00.000Z",
      messageCount: 1,
      status: "active",
      ...extra,
    };
  }

  function listOf(...entries: SessionHistoryReadModel["entries"][number][]): SessionHistoryReadModel {
    return { entries, total: entries.length };
  }

  describe("stableHistoryOrder", () => {
    it("passes the first page through untouched", () => {
      const first = listOf(entry("a"), entry("b"), entry("c"));
      expect(stableHistoryOrder(undefined, first)).toBe(first);
    });

    it("keeps an opened session at its position when its modifiedAt jumps to the top", () => {
      // The Host sorts by modifiedAt: opening "c" re-sorts the page to [c, a, b].
      const previous = listOf(entry("a"), entry("b"), entry("c"));
      const fresh = listOf(entry("c"), entry("a"), entry("b"));
      const titles = stableHistoryOrder(previous, fresh).entries.map(e => e.title);
      expect(titles).toEqual(["a", "b", "c"]);
    });

    it("lets a genuinely new session surface at the top", () => {
      const previous = listOf(entry("a"), entry("b"));
      const fresh = listOf(entry("d"), entry("b"), entry("a"));
      const titles = stableHistoryOrder(previous, fresh).entries.map(e => e.title);
      expect(titles).toEqual(["d", "a", "b"]);
    });

    it("honours the pinned block from the Host", () => {
      const previous = listOf(entry("a"), entry("b"));
      const fresh = listOf(entry("b", { pinned: true }), entry("a"), entry("c"));
      const titles = stableHistoryOrder(previous, fresh).entries.map(e => e.title);
      expect(titles).toEqual(["b", "a", "c"]);
    });
  });
});
