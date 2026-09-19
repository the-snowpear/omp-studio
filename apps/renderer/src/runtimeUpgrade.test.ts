import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientEvent, StudioClient } from "@omp-studio/client-contract";
import { useUpgradeAvailable } from "./runtimeUpgrade";

afterEach(cleanup);

it("refreshes capabilities on Runtime transitions without replacing the client", async () => {
  let listener!: (event: ClientEvent) => void;
  let supported = false;
  const query = vi.fn(async () => ({ capabilities: supported ? [{ id: "btw.history.list", grade: "full" }] : [] }));
  const unsubscribe = vi.fn();
  const client = { query, subscribe: (_scope: unknown, callback: typeof listener) => { listener = callback; return unsubscribe; } } as unknown as StudioClient;
  const { result, unmount } = renderHook(() => useUpgradeAvailable(client, false, "btw.history.list"));
  await waitFor(() => expect(query).toHaveBeenCalledOnce());
  expect(result.current).toBe(false);
  supported = true;
  act(() => listener({ kind: "runtime.changed", connection: { status: "connected" } } as ClientEvent));
  await waitFor(() => expect(result.current).toBe(true));
  act(() => listener({ kind: "runtime.changed", connection: { status: "unavailable" } } as ClientEvent));
  expect(result.current).toBe(false);
  supported = false;
  act(() => listener({ kind: "runtime.changed", connection: { status: "connected" } } as ClientEvent));
  await waitFor(() => expect(query).toHaveBeenCalledTimes(3));
  expect(result.current).toBe(false);
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("ignores a capability response from before a disconnect", async () => {
  let listener!: (event: ClientEvent) => void;
  let resolve!: (value: unknown) => void;
  const client = {
    query: vi.fn(() => new Promise(done => { resolve = done; })),
    subscribe: (_scope: unknown, callback: typeof listener) => { listener = callback; return () => {}; },
  } as unknown as StudioClient;
  const { result } = renderHook(() => useUpgradeAvailable(client, false, "btw.history.list"));
  act(() => listener({ kind: "runtime.changed", connection: { status: "unavailable" } } as ClientEvent));
  await act(async () => resolve({ capabilities: [{ id: "btw.history.list", grade: "full" }] }));
  expect(result.current).toBe(false);
});

it("refreshes once after resync rather than on every subsequent snapshot", async () => {
  let listener!: (event: ClientEvent) => void;
  const query = vi.fn(async () => ({ capabilities: [{ id: "btw.history.list", grade: "full" }] }));
  const client = { query, subscribe: (_scope: unknown, callback: typeof listener) => { listener = callback; return () => {}; } } as unknown as StudioClient;
  const { result } = renderHook(() => useUpgradeAvailable(client, false, "btw.history.list"));
  await waitFor(() => expect(result.current).toBe(true));
  act(() => listener({ kind: "resync.required" } as ClientEvent));
  expect(result.current).toBe(false);
  act(() => listener({ kind: "snapshot" } as ClientEvent));
  await waitFor(() => expect(result.current).toBe(true));
  act(() => { for (let i = 0; i < 20; i++) listener({ kind: "snapshot" } as ClientEvent); });
  expect(query).toHaveBeenCalledTimes(2);
});
