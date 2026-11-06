import type { SessionTelemetrySnapshot, SessionCompactionState, SessionCompactionThreshold } from "@omp-studio/studio-protocol";

/** Same composition as ver1's PREVIEW_CTX_PARTS, measured against the full window. */
export const PREVIEW_CONTEXT_CARD: NonNullable<SessionTelemetrySnapshot["context"]> = {
  contextWindow: 1_000_000,
  usedTokens: 220_400,
  percent: 22.04,
  anchored: false,
  systemPromptTokens: 13_000,
  systemContextTokens: 42_000,
  systemToolsTokens: 18_000,
  skillsTokens: 24_000,
  messagesTokens: 123_400,
};

const compactionOverrides = new Map<string, SessionCompactionThreshold | null>();
export function previewSessionCompaction(sessionId: string, contextWindow: number, update?: SessionCompactionThreshold | null): SessionCompactionState {
  if (update !== undefined) compactionOverrides.set(sessionId, update);
  const threshold = compactionOverrides.get(sessionId) ?? null;
  const triggerTokens = threshold?.kind === "tokens" ? threshold.value >= contextWindow ? Math.max(1, contextWindow - 16_384) : threshold.value
    : Math.max(1, Math.floor(contextWindow * (threshold?.value ?? 85) / 100));
  return { sessionId, threshold, contextWindow, triggerTokens, automatic: true };
}
