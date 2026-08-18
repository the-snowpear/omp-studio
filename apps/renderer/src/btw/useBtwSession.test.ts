import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BtwAskOutcome, BtwBranchOutcome, BtwSnapshot, StudioClient } from "@omp-studio/client-contract";
import { useBtwSession } from "./useBtwSession";

afterEach(cleanup);

const ASK: BtwAskOutcome = {
  snapshot: {} as BtwAskOutcome["snapshot"],
  ephemeralId: "round-1",
  branchToken: "token-1",
  status: "running",
};

function completed(id = "round-1"): BtwSnapshot {
  return { ephemeralId: id, status: "completed", text: "because the rename pair was dropped", copy: "copy me" };
}

function running(id = "round-1"): BtwSnapshot {
  return { ephemeralId: id, status: "running", text: "partial" };
}

function fakeClient(outcomes: { ask?: BtwAskOutcome; branch?: BtwBranchOutcome }): StudioClient {
  const commands: Record<string, { status: "completed"; result: unknown }> = {};
  return {
    command: async (name: string) => {
      const requestId = `req-${name}`;
      const result = name === "btw.ask" ? outcomes.ask : name === "btw.branch" ? outcomes.branch : {};
      commands[requestId] = { status: "completed", result };
      return { requestId };
    },
    getState: () => ({ commands }),
    subscribe: () => () => {},
  } as unknown as StudioClient;
}

describe("useBtwSession", () => {
  it("caches the branch token from btw.ask and enables branch only for that completed round", async () => {
    const client = fakeClient({ ask: ASK });
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: BtwSnapshot | null }) =>
        useBtwSession({ snapshot, client, preview: false, canCommand: true }),
      { initialProps: { snapshot: null as BtwSnapshot | null } },
    );
    expect(result.current.canAbort).toBe(false);
    expect(result.current.canBranch).toBe(false);

    await act(async () => {
      await expect(result.current.ask("why the rename?")).resolves.toBe(true);
    });
    rerender({ snapshot: running() });
    expect(result.current.canAbort).toBe(true);
    expect(result.current.canBranch).toBe(false);
    expect(result.current.branchBlockedReason).toBe("等答案写完再分支");

    rerender({ snapshot: completed() });
    expect(result.current.canAbort).toBe(false);
    expect(result.current.canBranch).toBe(true);
    expect(result.current.question).toBe("why the rename?");
    expect(result.current.startedAt).not.toBeNull();
  });

  it("drops a stale branch token when a new ephemeralId arrives", async () => {
    const client = fakeClient({ ask: ASK });
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: BtwSnapshot | null }) =>
        useBtwSession({ snapshot, client, preview: false, canCommand: true }),
      { initialProps: { snapshot: null as BtwSnapshot | null } },
    );
    await act(async () => {
      await result.current.ask("first");
    });
    rerender({ snapshot: completed("round-1") });
    expect(result.current.canBranch).toBe(true);
    rerender({ snapshot: completed("round-2") });
    expect(result.current.canBranch).toBe(false);
    expect(result.current.branchBlockedReason).toBe("分支凭据已失效，重新问一次");
  });

  it("does not call the Host in preview mode", async () => {
    const command = vi.fn();
    const client = { command, getState: () => ({ commands: {} }), subscribe: () => () => {} } as unknown as StudioClient;
    const { result } = renderHook(() =>
      useBtwSession({
        snapshot: running(),
        client,
        preview: true,
        previewQuestion: "demo question",
        canCommand: true,
      }),
    );
    await act(async () => {
      await expect(result.current.ask("why does preview ignore /btw?")).resolves.toBe(true);
      await result.current.abort();
      await result.current.branch();
    });
    expect(command).not.toHaveBeenCalled();
    expect(result.current.question).toBe("why does preview ignore /btw?");
    expect(result.current.notice).toBe("演示：未发往 Host");
  });

  it("uses the fixture question until the operator types one", () => {
    const { result } = renderHook(() =>
      useBtwSession({
        snapshot: running(),
        client: null,
        preview: true,
        previewQuestion: "demo question",
        canCommand: false,
      }),
    );
    expect(result.current.question).toBe("demo question");
  });

  it("aborts a running round before asking again", async () => {
    const names: string[] = [];
    let seq = 0;
    const commands: Record<string, { status: "completed"; result: unknown }> = {};
    const client = {
      command: async (name: string) => {
        names.push(name);
        seq += 1;
        const requestId = `req-${seq}`;
        const result = name === "btw.ask"
          ? { ...ASK, ephemeralId: `round-${seq}`, branchToken: `token-${seq}` }
          : {};
        commands[requestId] = { status: "completed", result };
        return { requestId };
      },
      getState: () => ({ commands }),
      subscribe: () => () => {},
    } as unknown as StudioClient;
    const { result } = renderHook(() =>
      useBtwSession({ snapshot: running("round-1"), client, preview: false, canCommand: true }),
    );
    await act(async () => {
      await expect(result.current.ask("second question")).resolves.toBe(true);
    });
    expect(names).toEqual(["btw.abort", "btw.ask"]);
    expect(result.current.question).toBe("second question");
  });

  it("keeps the new question when a previous snapshot lags behind the ask receipt", async () => {
    const client = fakeClient({ ask: ASK });
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: BtwSnapshot | null }) =>
        useBtwSession({ snapshot, client, preview: false, canCommand: true }),
      { initialProps: { snapshot: completed("round-0") } },
    );
    await act(async () => {
      await expect(result.current.ask("next")).resolves.toBe(true);
    });
    rerender({ snapshot: completed("round-0") });
    expect(result.current.question).toBe("next");
    rerender({ snapshot: completed("round-1") });
    expect(result.current.canBranch).toBe(true);
  });

  it("clears the local question when the live slot disappears", async () => {
    const client = fakeClient({ ask: ASK });
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: BtwSnapshot | null }) =>
        useBtwSession({ snapshot, client, preview: false, canCommand: true }),
      { initialProps: { snapshot: null as BtwSnapshot | null } },
    );
    await act(async () => {
      await result.current.ask("why?");
    });
    rerender({ snapshot: running() });
    expect(result.current.question).toBe("why?");
    rerender({ snapshot: null });
    expect(result.current.question).toBe("");
    expect(result.current.canBranch).toBe(false);
  });

  it("rejects an oversized question before talking to the Host", async () => {
    const command = vi.fn();
    const client = { command, getState: () => ({ commands: {} }), subscribe: () => () => {} } as unknown as StudioClient;
    const { result } = renderHook(() =>
      useBtwSession({ snapshot: null, client, preview: false, canCommand: true }),
    );
    await act(async () => {
      await expect(result.current.ask("x".repeat(64 * 1024 + 1))).resolves.toBe(false);
    });
    expect(command).not.toHaveBeenCalled();
    expect(result.current.error).toBe("问题过长");
  });

  it("ignores a second ask while one is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const names: string[] = [];
    const commands: Record<string, { status: "completed"; result: unknown }> = {};
    const client = {
      command: async (name: string) => {
        names.push(name);
        await gate;
        const requestId = `req-${name}`;
        commands[requestId] = { status: "completed", result: ASK };
        return { requestId };
      },
      getState: () => ({ commands }),
      subscribe: () => () => {},
    } as unknown as StudioClient;
    const { result } = renderHook(() =>
      useBtwSession({ snapshot: null, client, preview: false, canCommand: true }),
    );
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    act(() => {
      first = result.current.ask("one");
      second = result.current.ask("two");
    });
    await act(async () => {
      release();
      await expect(second).resolves.toBe(false);
      await expect(first).resolves.toBe(true);
    });
    expect(names).toEqual(["btw.ask"]);
  });

  it("selects the new session after a successful branch", async () => {
    const onBranched = vi.fn(async () => undefined);
    const client = fakeClient({
      ask: ASK,
      branch: {
        snapshot: {} as BtwBranchOutcome["snapshot"],
        branched: true,
        newSessionId: "sess-2",
      },
    });
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: BtwSnapshot | null }) =>
        useBtwSession({ snapshot, client, preview: false, canCommand: true, onBranched }),
      { initialProps: { snapshot: null as BtwSnapshot | null } },
    );
    await act(async () => {
      await result.current.ask("why?");
    });
    rerender({ snapshot: completed() });
    await act(async () => {
      await result.current.branch();
    });
    expect(onBranched).toHaveBeenCalledWith("sess-2");
    expect(result.current.notice).toBe("已分支为新会话");
  });
});
