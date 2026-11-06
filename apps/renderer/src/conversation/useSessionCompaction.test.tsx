import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient, ThreadId } from "@omp-studio/client-contract";
import { useSessionCompaction } from "./useSessionCompaction";

afterEach(cleanup);

it("saving a historical conversation resumes that exact conversation before setting its threshold", async () => {
  const commands: Record<string, unknown> = {};
  const command = vi.fn(async (name: string, input: { sessionId?: string }) => {
    commands[name] = { status: "completed", result: name === "session.resume" ? { sessionId: "history" }
      : { result: { sessionId: input.sessionId, threshold: { kind: "tokens", value: 150000 }, contextWindow: 1000000, automatic: true, triggerTokens: 150000 } } };
    return { requestId: name };
  });
  const client = { command, query: vi.fn().mockResolvedValue({ sessionId: "history", threshold: null }), getState: () => ({ commands }) } as unknown as StudioClient;
  const { result } = renderHook(() => useSessionCompaction({ client, sessionId: "history", threadId: "history-thread" as ThreadId, liveSessionId: "live", enabled: true, visible: true, preview: false, contextWindow: 1000000 }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { expect(await result.current.save("150k")).toBe(true); });
  expect(command.mock.calls).toEqual([
    ["session.resume", { threadId: "history-thread" }],
    ["session.compaction.set", { sessionId: "history", input: "150k" }],
  ]);
});

it("switching conversation while resume is pending cancels the stale threshold write", async () => {
  let release!: (value: { requestId: string }) => void;
  const resume = new Promise<{ requestId: string }>(resolve => { release = resolve; });
  const command = vi.fn(() => resume);
  const client = { command, query: vi.fn(async (_name, input) => ({ sessionId: input.sessionId, threshold: null })),
    getState: () => ({ commands: { resume: { status: "completed", result: { sessionId: "history" } } } }) } as unknown as StudioClient;
  const props = { client, sessionId: "history", threadId: "history-thread" as ThreadId, liveSessionId: "live", enabled: true, visible: true, preview: false, contextWindow: 1000000 };
  const { result, rerender } = renderHook(input => useSessionCompaction(input), { initialProps: props });
  await waitFor(() => expect(result.current.loading).toBe(false));
  let saved!: Promise<boolean>;
  act(() => { saved = result.current.save("80"); });
  rerender({ ...props, sessionId: "another", threadId: "another-thread" as ThreadId });
  await act(async () => { release({ requestId: "resume" }); expect(await saved).toBe(false); });
  expect(command).toHaveBeenCalledTimes(1);
  expect(command).toHaveBeenCalledWith("session.resume", { threadId: "history-thread" });
});
