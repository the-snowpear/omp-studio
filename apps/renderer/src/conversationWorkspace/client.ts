import { createInitialClientState, eventMatchesScope, type ClientState } from "@omp-studio/client";
import type { ClientBootstrap, ClientEvent, StudioClient, SubscriptionScope, Unsubscribe } from "@omp-studio/client-contract";
import { CONVERSATION_LIMITS } from "@omp-studio/client-contract";

import { measureSessionOperation } from "../sessionSwitchPerformance";
import { acquireProjectReads, bindBodyReady, bindProjectReads, isAuxiliaryRead, isProjectRead, type ProjectReads } from "./projectReads";

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

export function createConversationClient(open: () => Promise<{ client: StudioClient; owned: boolean; project?: ProjectReads; releaseProject?: () => void }>, waitForBody = false, cachedProject?: ProjectReads, allowRootProject = false): StatefulClient {
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
  // The bootstrap manifest describes the Runtime as it was when this context
  // opened: a fresh draft gets the empty neutral manifest until its own
  // session.create attaches a Runtime. After runtime.changed that copy is
  // stale until the next resync, so reads must go back to the Host.
  let bootstrapManifestStale = false, capabilitiesGeneration = 0;
  const invalidateCapabilities = () => { capabilities = undefined; capabilitiesRead = undefined; bootstrapManifestStale = true; capabilitiesGeneration++; };
  const adoptBootstrapManifest = (manifest: ClientBootstrap["capabilityManifest"]) => { capabilities = manifest; bootstrapManifestStale = false; capabilitiesGeneration++; };
  const selectRootProject = (workspaceId: import("@omp-studio/client-contract").WorkspaceId | undefined) => {
    if (!allowRootProject || owned || closed || !workspaceId || !value?.openContext || project?.workspaceId === workspaceId) return false;
    releaseProject?.();
    const shared = acquireProjectReads(value, workspaceId);
    project = shared.reads; releaseProject = shared.release; bindProjectReads(client, project);
    requestAnimationFrame(() => { if (!closed) project?.warm(selectedSession); });
    return true;
  };
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
      if (event.kind === "runtime.changed" || event.kind === "resync.required") invalidateCapabilities();
      project?.observe(event);
      for (const subscription of subscriptions) if (eventMatchesScope(event, subscription.scope)) subscription.listener(event);
    });
    offState = value.onState?.(state => { for (const listener of stateListeners) listener(state); });
    return value;
  }).catch(error => { opening = undefined; throw error; });
  const client: StatefulClient = {
    bootstrap: () => measureSessionOperation("client.bootstrap", async () => {
      const result = await initializeConversationClient(await ready());
      // A cached initialization predates any runtime.changed seen since.
      if (!bootstrapManifestStale) capabilities = result.capabilityManifest;
      selectedSession = result.selected?.sessionId;
      const projectChanged = selectRootProject(result.selected?.workspaceId);
      if (!result.selected?.sessionId) releaseBody();
      if (!projectChanged && !waitForBody && project) requestAnimationFrame(() => { if (!closed) project?.warm(selectedSession); });
      return result;
    }),
    query: (name, input) => measureSessionOperation(`query.${name}`, async () => {
      const target = await measureSessionOperation(`query.${name}.contextWait`, ready);
      if (isAuxiliaryRead(name)) await measureSessionOperation(`query.${name}.queueWait`, () => body);
      if (closed) throw new Error("Conversation client is closed");
      if (name === "capabilities.get") {
        const published = bootstrapManifestStale ? undefined : (target as StatefulClient).getState?.().connection.capabilityManifest;
        const known = capabilities ?? published;
        if (known) return known as never;
        const generation = capabilitiesGeneration;
        capabilitiesRead ??= target.query("capabilities.get", {}).then(manifest => {
          if (generation === capabilitiesGeneration) capabilities = manifest;
          return manifest;
        }).finally(() => { capabilitiesRead = undefined; });
        return await capabilitiesRead as never;
      }
      const epoch = project?.owner.epoch;
      const result = await measureSessionOperation(`query.${name}.request`, async () => {
        if (project && isProjectRead(name) && !(allowRootProject && !owned && name === "projects.list")) return project.read(name, input);
        const foreground = project && (name === "session.transcript.readPage" || name === "conversation.open") ? project.owner : undefined;
        if (foreground) foreground.foreground++;
        try { return await target.query(name, input); }
        finally { if (foreground) foreground.foreground--; }
      });
      const pageInput = input as { cursor?: string; agentId?: string; limit?: number };
      if (name === "projects.list") selectRootProject((result as import("@omp-studio/client-contract").WorkspaceListReadModel).activeWorkspaceId);
      if (!closed && epoch === project?.owner.epoch && name === "session.transcript.readPage" && !pageInput.cursor && !pageInput.agentId && (pageInput.limit ?? CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT) === CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT) {
        return (project?.savePage(result as import("@omp-studio/client-contract").ConversationTranscriptReadPage) ?? result) as never;
      }
      return result;
    }),
    command: async (name, input, options) => (await ready()).command(name, input, options),
    subscribe: (scope, listener) => { const subscription = { scope, listener }; subscriptions.add(subscription); return () => { subscriptions.delete(subscription); }; },
    getState: () => value?.getState?.() ?? initial,
    onState: listener => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; },
    resync: async () => { const target = await ready(); const result = await target.bootstrap(); adoptBootstrapManifest(result.capabilityManifest); initializations.set(target, Promise.resolve(result)); return result; },
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
      if (!closed) void ready().then(target => initializeConversationClient(target)).then(bootstrap => {
        if (!closed) project?.warm(bootstrap.selected?.sessionId);
      }).catch(() => {});
    }, 0));
  });
  // A warm view may paint pure cached text before its new IPC context opens.
  // The actual project consumer is acquired by open(), outside React render.
  if (cachedProject) bindProjectReads(client, cachedProject);
  return client;
}
