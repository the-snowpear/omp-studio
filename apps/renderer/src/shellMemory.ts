import type { ClientEvent } from "@omp-studio/client-contract";
import type { ClientState } from "@omp-studio/client";

/** Bottom-bar event log row: identity only, never the live payload. */
export type ShellEventLogEntry = {
  readonly cursor: ClientEvent["cursor"];
  readonly kind: ClientEvent["kind"];
  readonly occurredAt: string;
};

/**
 * High-frequency live frames. Recording them in App state re-renders the
 * whole workbench and retains up to 200 full tool/text payloads.
 */
export function shouldRecordShellEvent(event: ClientEvent): boolean {
  if (event.kind === "conversation.changed") {
    const kind = event.update.kind;
    return kind !== "conversation.message.delta" && kind !== "conversation.tool.updated";
  }
  return event.kind !== "btw.changed" && event.kind !== "telemetry.changed" && event.kind !== "state.changed";
}

export function toShellEventLogEntry(event: ClientEvent): ShellEventLogEntry {
  return { cursor: event.cursor, kind: event.kind, occurredAt: event.occurredAt };
}

/** Restore saved chrome when leaving preview even if the layout scope is unchanged. */
export function layoutRestoreNeeded(input: {
  readonly preview: boolean;
  readonly rememberLayout: boolean;
  readonly leavingPreview: boolean;
  readonly appliedScope: string | null;
  readonly layoutScope: string;
}): boolean {
  if (input.preview || !input.rememberLayout) return false;
  return input.leavingPreview || input.appliedScope !== input.layoutScope;
}

/**
 * Explorer dots only need which tools are running, not their stdout.
 * Output growth must not look like a shell change.
 */
export function liveToolActivitySignature(liveTools: ClientState["conversation"]["liveTools"]): string {
  let signature = "";
  for (const toolCallId of Object.keys(liveTools)) {
    const tool = liveTools[toolCallId];
    if (tool === undefined) continue;
    signature += `${toolCallId}\0${tool.toolName ?? ""}\0${tool.status}\0`;
  }
  return signature;
}

/**
 * Conversation deltas always mint a new `connection` (cursor tick) and a new
 * `conversation` object. The workbench shell does not display those, so they
 * must not re-render App / sidebar / topbar.
 */
export function clientShellChanged(previous: ClientState, next: ClientState): boolean {
  if (previous.entities !== next.entities) return true;
  if (previous.interaction !== next.interaction) return true;
  if (previous.commands !== next.commands) return true;
  if (liveToolActivitySignature(previous.conversation.liveTools) !== liveToolActivitySignature(next.conversation.liveTools)) {
    return true;
  }
  const before = previous.connection;
  const after = next.connection;
  return (
    before.phase !== after.phase ||
    before.authorityId !== after.authorityId ||
    before.authorityEpoch !== after.authorityEpoch ||
    before.runtime !== after.runtime ||
    before.runtimeEpoch !== after.runtimeEpoch ||
    before.resyncRequired !== after.resyncRequired ||
    before.resyncReason !== after.resyncReason ||
    before.surface !== after.surface ||
    before.capabilityManifest !== after.capabilityManifest ||
    before.commandManifestHash !== after.commandManifestHash ||
    before.selected !== after.selected ||
    before.contractVersion !== after.contractVersion
  );
}
