/**
 * Composer send/queue policy. App.tsx is the live wiring; this module is the
 * contract the UI must keep aligned with OMP:
 *
 * - Idle Enter → `core.prompt` (AgentSession.prompt: @mentions, skills, images).
 * - Streaming Enter → local queue, then `core.prompt` once THAT session is idle
 *   (OMP Enter steers immediately; Studio keeps an editable bar instead).
 * - Ctrl+Enter → `core.followUp` with images (OMP Ctrl+Enter / Ctrl+Q).
 * - Queue-bar “插入纠偏” → `core.steer`.
 * - `/queue` → Runtime `queue.enqueue` / `core.followUp`.
 * - Ask/approval cards block a fresh prompt, same as the TUI interaction surface.
 */

export function composerPromptEnabled(input: {
  readonly textReady: boolean;
  readonly running: boolean;
  readonly pendingInteraction: boolean;
  readonly promptChannelReady: boolean;
  readonly sending?: boolean;
  readonly sessionCreating?: boolean | undefined;
  /** Welcome page with no live session: allow send, then surface Host errors. */
  readonly newConversation?: boolean | undefined;
}): boolean {
  if (!input.textReady || input.running || input.pendingInteraction || input.sending) return false;
  return input.promptChannelReady || input.sessionCreating === true || input.newConversation === true;
}

export function composerQueueEnabled(input: {
  readonly textReady: boolean;
  readonly running: boolean;
  readonly promptChannelReady?: boolean;
}): boolean {
  return input.textReady && input.running;
}

/**
 * Ctrl+Enter follow-up. Allowed while streaming (OMP). Blocked when idle
 * with an ask/approval card so a new turn cannot race the interaction.
 */
export function composerFollowUpEnabled(input: {
  readonly textReady: boolean;
  readonly running: boolean;
  readonly pendingInteraction: boolean;
  readonly followUpChannelReady: boolean;
}): boolean {
  if (!input.textReady || !input.followUpChannelReady) return false;
  if (!input.running && input.pendingInteraction) return false;
  return true;
}

/**
 * Flush only the live session's own queue. A queue built while session A was
 * streaming must not ride `core.prompt` into session B after a sidebar switch.
 */
export function canFlushQueuedMessage(input: {
  readonly running: boolean;
  readonly pendingInteraction: boolean;
  readonly promptChannelReady: boolean;
  readonly selectedSessionId?: string;
  readonly liveSessionId?: string;
  readonly entrySessionId?: string;
  /** Head row id. Paired with `pausedEntryId` so editing the head holds flush. */
  readonly entryId?: number;
  readonly pausedEntryId?: number;
}): boolean {
  if (input.running || input.pendingInteraction || !input.promptChannelReady) return false;
  if (input.pausedEntryId !== undefined && input.entryId === input.pausedEntryId) return false;
  const { selectedSessionId, liveSessionId, entrySessionId } = input;
  if (selectedSessionId === undefined || liveSessionId === undefined) {
    return false;
  }
  const effectiveEntrySessionId = entrySessionId ?? selectedSessionId;
  return effectiveEntrySessionId === selectedSessionId && selectedSessionId === liveSessionId;
}

export function visibleQueuedMessages<T extends { readonly sessionId?: string }>(
  messages: readonly T[],
  selectedSessionId: string | undefined,
): T[] {
  if (selectedSessionId === undefined) return [];
  return messages.filter((entry) => entry.sessionId === selectedSessionId || entry.sessionId === undefined);
}

/**
 * Who the composer and its local queue belong to.
 *
 * `selectedSessionId` undefined is the fresh-draft surface (new conversation).
 * It owns the live Runtime snapshot ONLY once its own `session.create` has
 * landed: while that create is in flight the snapshot still describes the
 * session the operator just left, so falling back to `liveSessionId` here
 * stamps the new conversation's first prompt onto that old session.
 */
export type ComposerTarget = {
  readonly selectedSessionId?: string | undefined;
  readonly sessionCreating?: boolean | undefined;
  readonly liveSessionId?: string | undefined;
};

/**
 * Session the on-screen composer belongs to. `undefined` means this surface has
 * no session of its own yet — callers must NOT fall back to `liveSessionId`.
 */
export function composerOwnerSessionId(target: ComposerTarget): string | undefined {
  if (target.selectedSessionId !== undefined) return target.selectedSessionId;
  return target.sessionCreating === true ? undefined : target.liveSessionId;
}

/** The live Runtime snapshot on screen is the composer's own conversation. */
export function composerOwnsLiveSnapshot(target: ComposerTarget): boolean {
  const owner = composerOwnerSessionId(target);
  return owner !== undefined && owner === target.liveSessionId;
}

/**
 * Whether the composer must treat Enter as "queue locally" instead of sending.
 * Only the conversation on screen may own a local queue: a fresh-draft surface
 * whose `session.create` is still in flight keeps `running` from the snapshot's
 * session, and queueing that draft would file it against the wrong session.
 * `false` sends through `dispatchPrompt`, which waits for the new session.
 */
export function composerRunningForTarget(target: ComposerTarget & { readonly running: boolean }): boolean {
  return target.running && composerOwnsLiveSnapshot(target);
}

/** Synchronous ownership of dispatch, including the gap before React rerenders. */
export function createComposerDispatchGate() {
  let busy = false;
  return {
    get busy() { return busy; },
    tryEnter(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    leave(): void { busy = false; },
  };
}
