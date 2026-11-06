import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSubagentComposer } from "./useSubagentComposer";
import { createSubagentViewBook, createSubagentViewState, subagentViewKey } from "./subagentViewState";
import { snapshotFromText } from "../composer/serialize";

afterEach(cleanup);
const agent = { agentId: "deps", kind: "task", status: "running", generation: 1 };

describe("child composer ownership", () => {
  it("keeps draft and queued messages when hidden/disabled and flushes only after returning", async () => {
    const viewState = createSubagentViewState();
    const { result, rerender } = renderHook(({ enabled, running }) => useSubagentComposer({ enabled, running, agent, sessionId: "child", client: null, preview: true, viewState }),
      { initialProps: { enabled: true, running: true } });
    act(() => result.current.setDraft(snapshotFromText("queued for deps")));
    act(() => result.current.enqueueDraft());
    act(() => result.current.setDraft(snapshotFromText("unfinished draft")));
    rerender({ enabled: false, running: false });
    expect(viewState.draft.text).toBe("unfinished draft");
    expect(viewState.queued).toHaveLength(1);
    rerender({ enabled: true, running: false });
    await waitFor(() => expect(viewState.queued).toHaveLength(0));
    expect(viewState.draft.text).toBe("unfinished draft");
  });

  it("never automatically sends a previous generation's queue to a revived agent", async () => {
    const viewState = createSubagentViewState();
    const { result, rerender } = renderHook(({ generation, running }) => useSubagentComposer({ enabled: true, running, agent: { ...agent, generation }, sessionId: "child", client: null, preview: true, viewState }),
      { initialProps: { generation: 1, running: true } });
    act(() => result.current.setDraft(snapshotFromText("old run")));
    act(() => result.current.enqueueDraft());
    rerender({ generation: 2, running: false });
    await act(async () => {});
    expect(result.current.staleQueue).toBe(true);
    expect(viewState.queued).toHaveLength(1);
    act(() => result.current.sendQueuedNow(viewState.queued[0]!));
    await waitFor(() => expect(viewState.queued).toHaveLength(0));
  });

  it("separates drafts by execution target, parent and agent across editor remounts", () => {
    const book = createSubagentViewBook();
    const deps = book.get(subagentViewKey("local:parent-a", "deps"));
    const first = renderHook(() => useSubagentComposer({ enabled: true, running: false, agent, sessionId: "child-a", client: null, preview: true, viewState: deps }));
    act(() => first.result.current.setDraft(snapshotFromText("only parent-a deps")));
    first.unmount();
    expect(book.get(subagentViewKey("remote:parent-a", "deps")).draft.text).toBe("");
    expect(book.get(subagentViewKey("local:parent-b", "deps")).draft.text).toBe("");
    expect(book.get(subagentViewKey("local:parent-a", "preview")).draft.text).toBe("");
    const again = renderHook(() => useSubagentComposer({ enabled: true, running: false, agent, sessionId: "child-a", client: null, preview: true, viewState: book.get(subagentViewKey("local:parent-a", "deps")) }));
    expect(again.result.current.draft.text).toBe("only parent-a deps");
  });

  it("does not send or enqueue while permission or hydration is unavailable", () => {
    const command = vi.fn();
    const { result } = renderHook(() => useSubagentComposer({ enabled: false, running: true, agent, sessionId: undefined, client: { command, subscribe: vi.fn() } as never }));
    act(() => result.current.setDraft(snapshotFromText("keep this")));
    act(() => { result.current.enqueueDraft(); result.current.submitPrompt(); });
    expect(command).not.toHaveBeenCalled();
    expect(result.current.queued).toEqual([]);
    expect(result.current.draft.text).toBe("keep this");
  });
});
