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

export function createRemoteTransport(api: RemoteApi, id: string, state: RemoteTransportState, scope?: import("@omp-studio/client-contract").ClientContextScope): ClientTransport {
  let contextId: string | undefined;
  let closed = false;
  let revision = -1;
  let opening: Promise<string> | undefined;
  const context = (): Promise<string> => {
    if (revision !== state.revision) { revision = state.revision; contextId = undefined; opening = undefined; }
    if (contextId) return Promise.resolve(contextId);
    if (!api.openContext) return Promise.reject(new Error("Update this remote Host to open concurrent conversations."));
    if (!opening) {
      const openedRevision = revision;
      const pending = api.openContext(id, scope!).then(value => {
        if (closed || openedRevision !== state.revision) {
          if (openedRevision === state.revision) void api.closeContext?.(id, value);
          throw unavailable();
        }
        contextId = value;
        return value;
      }).finally(() => { if (opening === pending) opening = undefined; });
      opening = pending;
    }
    return opening;
  };
  const invoke = async <T>(action: (contextId: string | undefined) => Promise<T>, write = false): Promise<T> => {
    const startedRevision = state.revision;
    const assertReady = () => {
      if (closed || !state.available || startedRevision !== state.revision || (write && !state.synchronized)) throw unavailable();
    };
    assertReady();
    const target = scope ? await context() : undefined;
    assertReady();
    const result = await action(target);
    // Once sent, a command keeps its actual receipt or OUTCOME_UNKNOWN failure.
    if (!write) assertReady();
    return result;
  };
  return {
    openContext: async scope => createRemoteTransport(api, id, state, scope),
    bootstrap: () => invoke(target => api.bootstrap(id, target)),
    query: request => invoke(target => api.query(id, request, target)),
    command: request => invoke(target => api.command(id, request, target), true),
    subscribe: (subscription, listener) => api.onEvent(value => {
      if (!closed && (!scope || (contextId !== undefined && revision === state.revision)) && value.id === id && value.contextId === contextId && state.available && value.generation === state.generation && eventMatchesScope(value.event, subscription)) listener(value.event);
    }),
    close: async () => { closed = true; if (contextId && revision === state.revision) await api.closeContext?.(id, contextId); },
  };
}
