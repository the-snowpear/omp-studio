import { useEffect, useState } from "react";
import type { ClientState } from "@omp-studio/client";
import type { StudioClient } from "@omp-studio/client-contract";

type StateSource = StudioClient & {
  getState?: () => ClientState;
  onState?: (listener: (state: ClientState) => void) => () => void;
};

export function modelConnection(state: ClientState | undefined) {
  const sessionId = state?.entities.snapshot?.sessionId;
  return {
    sessionId,
    workspaceId: sessionId === undefined ? undefined : state?.entities.residents?.residents.find(row => row.sessionId === sessionId)?.workspaceId ?? state?.connection.selected?.workspaceId,
    runtimeStatus: state?.connection.runtime?.status,
  };
}

export function useModelConnection(client: StateSource) {
  const [selection, setSelection] = useState(() => modelConnection(client.getState?.()));
  useEffect(() => {
    let previous = modelConnection(client.getState?.());
    setSelection(previous);
    const update = (state: ClientState | undefined) => {
      const next = modelConnection(state);
      if (previous.sessionId === next.sessionId && previous.workspaceId === next.workspaceId && previous.runtimeStatus === next.runtimeStatus) return;
      previous = next;
      setSelection(next);
    };
    const unsubscribe = client.onState?.(update);
    update(client.getState?.());
    return unsubscribe;
  }, [client]);
  return selection;
}
