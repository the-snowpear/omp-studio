import type { CapabilityManifest } from "@omp-studio/studio-protocol";

/**
 * Composer `gated` (busy / snapshotReady / executionMatches / can()) is
 * the wrong lock for a card that is already on screen. Those flags flicker
 * while session.create, capabilities.get, or a Worker bind catch up — the
 * ask appears, options and 取消/提交 go dead, then the same card unlocks
 * with no click. A visible pending interaction is answerable unless the
 * Host truly cannot take `interaction.respond`.
 */
export function interactionDeckDisabled(input: {
  readonly resyncRequired: boolean;
  readonly runtimeConnected: boolean;
}): boolean {
  return input.resyncRequired || !input.runtimeConnected;
}

/** Prefer a manifest that actually lists capabilities over an empty limited fallback. */
export function usableCapabilityManifest(
  ...candidates: Array<CapabilityManifest | null | undefined>
): CapabilityManifest | undefined {
  let empty: CapabilityManifest | undefined;
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (candidate.capabilities.length > 0) return candidate;
    empty ??= candidate;
  }
  return empty;
}
