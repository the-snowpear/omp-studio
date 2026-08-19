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
  readonly sessionCreating?: boolean | undefined;
  /** Welcome page with no live session: allow send, then surface Host errors. */
  readonly newConversation?: boolean | undefined;
}): boolean {
  if (!input.textReady || input.running || input.pendingInteraction) return false;
  return input.promptChannelReady || input.sessionCreating === true || input.newConversation === true;
}

export function composerQueueEnabled(input: {
  readonly textReady: boolean;
  readonly running: boolean;
  readonly promptChannelReady: boolean;
}): boolean {
  return input.textReady && input.running && input.promptChannelReady;
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
  if (selectedSessionId === undefined || liveSessionId === undefined || entrySessionId === undefined) {
    return false;
  }
  return entrySessionId === selectedSessionId && selectedSessionId === liveSessionId;
}

export function visibleQueuedMessages<T extends { readonly sessionId?: string }>(
  messages: readonly T[],
  selectedSessionId: string | undefined,
): T[] {
  if (selectedSessionId === undefined) return [];
  return messages.filter((entry) => entry.sessionId === selectedSessionId);
}
