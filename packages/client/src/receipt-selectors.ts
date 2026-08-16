import type { ClientError, CommandReceipt, CommandRequestId, CommandState } from "@omp-studio/client-contract";

export type ComposerReceiptView =
  | { readonly phase: "unknown" }
  | { readonly phase: "pending" }
  | { readonly phase: "accepted"; readonly acceptedAt: string }
  | { readonly phase: "interaction_required" }
  | {
      readonly phase: "completed";
      readonly observedAt: string;
    }
  | {
      readonly phase: "failed";
      readonly error: ClientError;
      readonly observedAt: string;
    }
  | {
      readonly phase: "rejected";
      readonly reason: string;
      readonly observedAt: string;
    }
  | {
      readonly phase: "outcome_unknown";
      readonly reason: string;
      readonly observedAt: string;
    };

const TERMINAL = {
  completed: true,
  failed: true,
  rejected: true,
  outcome_unknown: true,
} as const;

export function isComposerTerminal(status: CommandState["status"]): boolean {
  return status in TERMINAL;
}

/**
 * Composer-facing view of one requestId. `accepted` is never treated as
 * completed. Terminal failed/rejected/outcome_unknown keep the Host reason.
 * The reducer already refuses a second terminal; this selector reads that
 * single terminal fact.
 */
export function selectComposerReceipt(
  commands: Readonly<Record<CommandRequestId, CommandState>>,
  requestId: CommandRequestId,
): ComposerReceiptView {
  const entry = commands[requestId];
  if (entry === undefined) return { phase: "unknown" };
  switch (entry.status) {
    case "local_pending":
      return { phase: "pending" };
    case "accepted":
      return { phase: "accepted", acceptedAt: entry.acceptedAt };
    case "interaction_required":
      return { phase: "interaction_required" };
    case "completed":
      return { phase: "completed", observedAt: entry.observedAt };
    case "failed":
      return { phase: "failed", error: entry.error, observedAt: entry.observedAt };
    case "rejected":
      return { phase: "rejected", reason: entry.reason, observedAt: entry.observedAt };
    case "outcome_unknown":
      return { phase: "outcome_unknown", reason: entry.reason, observedAt: entry.observedAt };
    default: {
      const _exhaustive: never = entry;
      return { phase: "unknown" };
    }
  }
}

export function selectComposerTerminal(
  commands: Readonly<Record<CommandRequestId, CommandState>>,
  requestId: CommandRequestId,
): CommandReceipt | undefined {
  const entry = commands[requestId];
  if (entry === undefined || !isComposerTerminal(entry.status)) return undefined;
  return entry as CommandReceipt;
}
