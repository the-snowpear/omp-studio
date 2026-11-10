import { createInitialClientState, eventMatchesScope, type ClientState } from "@omp-studio/client";
import type { ClientBootstrap, ClientEvent, StudioClient, SubscriptionScope, Unsubscribe } from "@omp-studio/client-contract";

import { measureSessionOperation } from "../sessionSwitchPerformance";
import { bindBodyReady, bindProjectReads, isAuxiliaryRead, isProjectRead, type ProjectReads } from "./projectReads";

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

export function createConversationClient(open: () => Promise<{ client: StudioClient; owned: boolean; project?: ProjectReads; releaseProject?: () => void }>, waitForBody = false): StatefulClient {
  let value: StatefulClient | undefined;
  let opening: Promise<StatefulClient> | undefined;
  let owned = false, closed = false;
  let project: ProjectReads | undefined, releaseProject: (() => void) | undefined;
  let releaseBody: () => void = () => {}, presented = !waitForBody;
  const body = new Promise<void>(resolve => { releaseBody = resolve; });
  if (presented) releaseBody();
  let capabilities: ClientBootstrap["capabilityManifest"] | undefined;
  let selectedSession: import("@omp-studio/client-contract").SessionId | undefined;
  let capabilitiesRead: Promise<ClientBootstrap["capabilityManifest"]> | undefined;
  const initial = createInitialClientState();
  const subscriptions = new Set<{ scope: SubscriptionScope; listener: (event: ClientEvent) => void }>();
  const stateListeners = new Set<(state: ClientState) => void>();
  let offEvents: Unsubscribe | undefined, offState: Unsubscribe | undefined;
  const ready = () => opening ??= measureSessionOperation("context.open", open).then(async result => {
    value = result.client as StatefulClient; owned = result.owned;
    project = result.project; releaseProject = result.releaseProject;
    if (project) bindProjectReads(client, project);
    if (closed) { releaseProject?.(); if (owned) await value.close(); throw new Error("Conversation client is closed"); }
    offEvents = value.subscribe({ scope: "all" }, event => {
      if (event.kind === "runtime.changed" || event.kind === "resync.required") capabilities = undefined;
      project?.observe(event);
      for (const subscription of subscriptions) if (eventMatchesScope(event, subscription.scope)) subscription.listener(event);
    });
    offState = value.onState?.(state => { for (const listener of stateListeners) listener(state); });
    return value;
  }).catch(error => { opening = undefined; throw error; });
  const client: StatefulClient = {
    bootstrap: () => measureSessionOperation("client.bootstrap", async () => {
      const result = await initializeConversationClient(await ready()); capabilities = result.capabilityManifest;
      selectedSession = result.selected?.sessionId;
      if (!result.selected?.sessionId) releaseBody();
      if (!waitForBody && project) requestAnimationFrame(() => { if (!closed) project?.warm(selectedSession); });
      return result;
    }),
    query: (name, input) => measureSessionOperation(`query.${name}`, async () => {
      const target = await measureSessionOperation(`query.${name}.contextWait`, ready);
      if (isAuxiliaryRead(name)) await measureSessionOperation(`query.${name}.queueWait`, () => body);
      if (closed) throw new Error("Conversation client is closed");
      if (name === "capabilities.get") {
        if (capabilities) return capabilities as never;
        capabilitiesRead ??= target.query("capabilities.get", {}).finally(() => { capabilitiesRead = undefined; });
        return await capabilitiesRead as never;
      }
      const epoch = project?.owner.epoch;
      const result = await measureSessionOperation(`query.${name}.request`, () => project && isProjectRead(name) ? project.read(name, input) : target.query(name, input));
      if (!closed && epoch === project?.owner.epoch && name === "session.transcript.readPage" && !(input as { cursor?: string; agentId?: string }).cursor && !(input as { agentId?: string }).agentId) {
        return (project?.savePage(result as import("@omp-studio/client-contract").ConversationTranscriptReadPage) ?? result) as never;
      }
      return result;
    }),
    command: async (name, input, options) => (await ready()).command(name, input, options),
    subscribe: (scope, listener) => { const subscription = { scope, listener }; subscriptions.add(subscription); return () => { subscriptions.delete(subscription); }; },
    getState: () => value?.getState?.() ?? initial,
    onState: listener => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; },
    resync: async () => { const target = await ready(); const result = await target.bootstrap(); capabilities = result.capabilityManifest; initializations.set(target, Promise.resolve(result)); return result; },
    transportLost: reason => { capabilities = undefined; project?.owner.invalidate(); if (value) { initializations.delete(value); value.transportLost?.(reason); } },
    close: async () => { if (closed) return; closed = true; releaseBody(); releaseProject?.(); offEvents?.(); offState?.(); subscriptions.clear(); stateListeners.clear(); if (owned) await value?.close(); },
  };
  bindBodyReady(client, () => {
    if (presented || closed) return;
    presented = true;
    // Allow the body commit and a frame before starting secondary work. This is
    // a scheduling marker; paint latency is measured by the browser trace.
    requestAnimationFrame(() => setTimeout(() => {
      releaseBody();
      if (!closed) project?.warm(selectedSession);
    }, 0));
  });
  return client;
}
