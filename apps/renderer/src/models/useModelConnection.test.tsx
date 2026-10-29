import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { contractFixtures } from "@omp-studio/testkit";
import { StudioClientImpl } from "@omp-studio/client";
import type { ClientState } from "@omp-studio/client";
import type { StudioClient } from "@omp-studio/client-contract";
import { useModelConnection } from "./useModelConnection";

afterEach(cleanup);
it("ignores transport cursor updates but follows the selected model session", () => {
  const initial = { ...new StudioClientImpl({} as never).getState(), connection: { ...new StudioClientImpl({} as never).getState().connection, runtime: contractFixtures.bootstrap.runtime, selected: contractFixtures.bootstrap.selected } } as ClientState;
  let state = { ...initial, entities: { ...initial.entities, snapshot: contractFixtures.bootstrap.snapshot! } };
  let listener: ((value: ClientState) => void) | undefined;
  const off = vi.fn();
  const client = { getState: () => state, onState: (next: typeof listener) => { listener = next; return off; } } as unknown as StudioClient;
  let renders = 0;
  const { result, unmount } = renderHook(() => { renders++; return useModelConnection(client); });
  const before = result.current;
  const rendersBefore = renders;
  act(() => { for (let n = 0; n < 1000; n++) listener!({ ...state, connection: { ...state.connection, cursor: String(n) as never } }); });
  expect(result.current).toBe(before);
  expect(renders).toBe(rendersBefore);
  act(() => { state = { ...state, entities: { ...state.entities, snapshot: { ...state.entities.snapshot, sessionId: "next" as never } } }; listener!(state); });
  expect(result.current.sessionId).toBe("next");
  expect(state.connection.selected?.sessionId).toBe(contractFixtures.bootstrap.selected?.sessionId);
  act(() => { listener!({ ...state, entities: { ...state.entities, snapshot: null } }); });
  expect(result.current.sessionId).toBeUndefined();
  unmount(); expect(off).toHaveBeenCalledOnce();
});
