/**
 * Fast / Prewalk status lines belong in the bottom toast pill, not the
 * conversation body. Runtime still emits them as `conversation.notice`
 * (and some command receipts repeat the same meaning as COMMAND_BLOCKED).
 */

export type TransientStatusFamily = "fast-tier" | "prewalk-noop";

const FAST_TIER = /no service-tier control/i;
const PREWALK_NOOP = /already matches the active model/i;

export function transientStatusFamily(message: string, source?: string): TransientStatusFamily | undefined {
  if (source === "priority" && FAST_TIER.test(message)) return "fast-tier";
  if (source === "prewalk" && PREWALK_NOOP.test(message)) return "prewalk-noop";
  if (FAST_TIER.test(message)) return "fast-tier";
  if (PREWALK_NOOP.test(message)) return "prewalk-noop";
  return undefined;
}

export function isTransientStatusNotice(message: string, source?: string): boolean {
  return transientStatusFamily(message, source) !== undefined;
}

/** Skip a second toast of the same family that arrives with the notice+error pair. */
export function claimTransientToast(
  family: TransientStatusFamily | undefined,
  last: { family: TransientStatusFamily; at: number } | undefined,
  now = Date.now(),
  windowMs = 2500,
): { show: boolean; next: { family: TransientStatusFamily; at: number } | undefined } {
  if (family === undefined) return { show: true, next: last };
  if (last !== undefined && last.family === family && now - last.at < windowMs) {
    return { show: false, next: last };
  }
  return { show: true, next: { family, at: now } };
}
