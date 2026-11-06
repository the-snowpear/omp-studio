import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerDraft } from "./useComposerDraft";
import { snapshotFromDoc, snapshotFromText } from "./serialize";
import { emptySnapshot } from "./types";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("composer draft publication", () => {
  it("keeps exact text live and publishes only after a trailing typing pause", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const { result } = renderHook(() => useComposerDraft(emptySnapshot(), publish));
    act(() => result.current.publishDraft(snapshotFromText("a")));
    expect(publish).toHaveBeenCalledTimes(1);
    act(() => result.current.publishDraft(snapshotFromText("ab")));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.publishDraft(snapshotFromText("abc")));
    expect(result.current.draftLive.current.text).toBe("abc");
    act(() => vi.advanceTimersByTime(139));
    expect(publish).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.lastCall?.[0].text).toBe("abc");
  });

  it("publishes capsule and empty boundaries immediately and never revives a cleared draft", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const { result } = renderHook(() => useComposerDraft(snapshotFromText("draft"), publish));
    act(() => result.current.publishDraft(snapshotFromText("draft pending")));
    const withMode = snapshotFromDoc({ nodes: [{ type: "chip", chip: { id: "plan", kind: "mode", label: "plan", name: "plan" } }] });
    act(() => result.current.publishDraft(withMode));
    expect(publish).toHaveBeenLastCalledWith(withMode);
    act(() => result.current.publishDraft(snapshotFromText("another draft")));
    act(() => result.current.publishDraft(snapshotFromText("pending again")));
    act(() => result.current.commitDraft(emptySnapshot()));
    const calls = publish.mock.calls.length;
    act(() => vi.advanceTimersByTime(300));
    expect(publish).toHaveBeenCalledTimes(calls);
    expect(result.current.draftLive.current.text).toBe("");
    expect(publish.mock.lastCall?.[0].text).toBe("");
  });

  it("uses the current target publisher and cancels pending publication on unmount", () => {
    vi.useFakeTimers();
    const first = vi.fn(), second = vi.fn();
    const { result, rerender, unmount } = renderHook(({ publish }) => useComposerDraft(snapshotFromText("a"), publish), { initialProps: { publish: first } });
    const publishDraft = result.current.publishDraft;
    act(() => publishDraft(snapshotFromText("ab")));
    rerender({ publish: second });
    expect(result.current.publishDraft).toBe(publishDraft);
    act(() => vi.advanceTimersByTime(140));
    expect(first).not.toHaveBeenCalled();
    expect(second.mock.lastCall?.[0].text).toBe("ab");
    act(() => result.current.publishDraft(snapshotFromText("abc")));
    unmount();
    act(() => vi.advanceTimersByTime(300));
    expect(second).toHaveBeenCalledTimes(1);
  });
});
