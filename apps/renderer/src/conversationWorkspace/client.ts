import { createInitialClientState, eventMatchesScope, type ClientState } from "@omp-studio/client";
import type { ClientBootstrap, ClientEvent, StudioClient, SubscriptionScope, Unsubscribe } from "@omp-studio/client-contract";

import { measureSessionOperation } from "../sessionSwitchPerformance";

type StatefulClient = StudioClient & { getState?(): ClientState; onState?(listener: (state: ClientState) => void): Unsubscribe; transportLost?(reason: string): void; resync?(): Promise<ClientBootstrap> };
const initializations = new WeakMap<StudioClient, Promise<ClientBootstrap>>();
export function initializeConversationClient(client: StudioClient) {
  let pending = initializations.get(client);
  if (!pending) {
    pending = client.bootstrap();
    initializations.set(client, pending);
    void pending.catch(() => { if (initializations.get(client) === pending) initializations.delete(client); });
  }
  return pending;
}

export async function resyncConversationClient(client: StudioClient) {
  const result = await ((client as StatefulClient).resync?.() ?? client.bootstrap());
  initializations.set(client, Promise.resolve(result));
  return result;
}

export function createConversationClient(open: () => Promise<{ client: StudioClient; owned: boolean }>): StatefulClient {
  let value: StatefulClient | undefined;
  let opening: Promise<StatefulClient> | undefined;
  let owned = false, closed = false;
  const initial = createInitialClientState();
  const subscriptions = new Set<{ scope: SubscriptionScope; listener: (event: ClientEvent) => void }>();
  const stateListeners = new Set<(state: ClientState) => void>();
  let offEvents: Unsubscribe | undefined, offState: Unsubscribe | undefined;
  const ready = () => opening ??= measureSessionOperation("context.open", open).then(async result => {
    value = result.client as StatefulClient; owned = result.owned;
    if (closed) { if (owned) await value.close(); throw new Error("Conversation client is closed"); }
    offEvents = value.subscribe({ scope: "all" }, event => { for (const subscription of subscriptions) if (eventMatchesScope(event, subscription.scope)) subscription.listener(event); });
    offState = value.onState?.(state => { for (const listener of stateListeners) listener(state); });
    return value;
  }).catch(error => { opening = undefined; throw error; });
  const client: StatefulClient = {
    bootstrap: () => measureSessionOperation("client.bootstrap", async () => initializeConversationClient(await ready())),
    query: (name, input) => measureSessionOperation(`query.${name}`, async () => (await ready()).query(name, input)),
    command: async (name, input, options) => (await ready()).command(name, input, options),
    subscribe: (scope, listener) => { const subscription = { scope, listener }; subscriptions.add(subscription); return () => { subscriptions.delete(subscription); }; },
    getState: () => value?.getState?.() ?? initial,
    onState: listener => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; },
    resync: async () => { const target = await ready(); const result = await target.bootstrap(); initializations.set(target, Promise.resolve(result)); return result; },
    transportLost: reason => { if (value) { initializations.delete(value); value.transportLost?.(reason); } },
    close: async () => { closed = true; offEvents?.(); offState?.(); subscriptions.clear(); stateListeners.clear(); if (owned) await value?.close(); },
  };
  return client;
}
