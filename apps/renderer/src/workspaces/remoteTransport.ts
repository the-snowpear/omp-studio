import type { ClientTransport } from "@omp-studio/client-contract";
import { eventMatchesScope } from "@omp-studio/client";
import type { RemoteApi } from "../../../desktop/src/remote/shared";

export interface RemoteTransportState {
  available: boolean;
  generation: number;
  revision: number;
  synchronized: boolean;
  syncRevision: number;
  error?: string;
}

const unavailable = () => ({ code: "RESYNC_REQUIRED" as const, message: "SSH 已断开或正在同步；操作未发送，也不会回落到本机" });

export function createRemoteTransport(api: RemoteApi, id: string, state: RemoteTransportState): ClientTransport {
  const read = async <T>(action: () => Promise<T>): Promise<T> => {
    if (!state.available) throw unavailable();
    const revision = state.revision;
    const result = await action();
    if (!state.available || revision !== state.revision) throw unavailable();
    return result;
  };
  return {
    bootstrap: () => read(() => api.bootstrap(id)),
    query: request => read(() => api.query(id, request)),
    command: request => {
      if (!state.available || !state.synchronized) return Promise.reject(unavailable());
      return api.command(id, request);
    },
    subscribe: (scope, listener) => api.onEvent(value => {
      if (value.id === id && state.available && value.generation === state.generation && eventMatchesScope(value.event, scope)) listener(value.event);
    }),
    close: async () => {},
  };
}
