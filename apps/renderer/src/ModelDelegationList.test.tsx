import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientEvent, StudioClient } from "@omp-studio/client-contract";
import { ModelDelegationList } from "./ModelDelegationList";
import { invokeUpgrade } from "./runtimeUpgrade";
vi.mock("./runtimeUpgrade", () => ({ invokeUpgrade: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("retains delegation labels across unrelated state changes and refreshes after a user message", async () => {
  let listener!: (event: ClientEvent) => void;
  const unsubscribe = vi.fn();
  const client = { subscribe: (_scope: unknown, callback: typeof listener) => { listener = callback; return unsubscribe; } } as unknown as StudioClient;
  vi.mocked(invokeUpgrade).mockResolvedValue({ sessionId: "parent", mentions: [{ agent: "m1", selector: "p/model", name: "Model" }], available: [], activeModelImage: false });
  const { unmount } = render(<ModelDelegationList client={client} preview={false} sessionId="parent" />);
  await screen.findByText("m1 · Model");
  act(() => { for (let i = 0; i < 30; i++) listener({ kind: "state.changed" } as ClientEvent); });
  expect(invokeUpgrade).toHaveBeenCalledOnce();
  expect(screen.getByText("m1 · Model")).toBeTruthy();
  act(() => listener({ kind: "conversation.changed", sessionId: "parent", update: { kind: "conversation.message.completed", item: { role: "user" } } } as ClientEvent));
  await waitFor(() => expect(invokeUpgrade).toHaveBeenCalledTimes(2));
  expect(screen.getByText("m1 · Model")).toBeTruthy();
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("does not restore stale delegation labels after the Runtime disconnects", async () => {
  let listener!: (event: ClientEvent) => void;
  let complete!: (value: unknown) => void;
  vi.mocked(invokeUpgrade).mockReturnValue(new Promise(resolve => { complete = resolve; }) as never);
  const client = { subscribe: (_scope: unknown, callback: typeof listener) => { listener = callback; return () => {}; } } as unknown as StudioClient;
  render(<ModelDelegationList client={client} preview={false} sessionId="parent" />);
  act(() => listener({ kind: "runtime.changed", connection: { status: "unavailable" } } as ClientEvent));
  await act(async () => complete({ sessionId: "parent", mentions: [{ agent: "m1", selector: "p/old", name: "Stale" }], available: [], activeModelImage: false }));
  expect(screen.queryByText("m1 · Stale")).toBeNull();
});

it("refreshes the new Runtime even when the request from before reconnect fails", async () => {
  let listener!: (event: ClientEvent) => void;
  let reject!: (error: Error) => void;
  vi.mocked(invokeUpgrade)
    .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
    .mockResolvedValue({ sessionId: "parent", mentions: [{ agent: "m2", selector: "p/new", name: "Current" }], available: [], activeModelImage: false });
  const client = { subscribe: (_scope: unknown, callback: typeof listener) => { listener = callback; return () => {}; } } as unknown as StudioClient;
  render(<ModelDelegationList client={client} preview={false} sessionId="parent" />);
  act(() => {
    listener({ kind: "runtime.changed", connection: { status: "unavailable" } } as ClientEvent);
    listener({ kind: "runtime.changed", connection: { status: "connected" } } as ClientEvent);
  });
  await act(async () => reject(new Error("Old Runtime disconnected")));
  await screen.findByText("m2 · Current");
  expect(invokeUpgrade).toHaveBeenCalledTimes(2);
});
