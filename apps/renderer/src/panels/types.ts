import type { CommandStatus } from "@omp-studio/client-contract";

/**
 * One row of the Output panel's command ledger.
 *
 * The ledger is a scan surface, not a transcript of results: it keeps command
 * identity, client-side lifecycle status, and the one terminal detail that
 * explains a non-completed command. Results stay in the conversation.
 */
export type LedgerCommandRow = {
  readonly requestId: string;
  readonly commandName: string;
  /** Client lifecycle status; drives the row's status rune and tone. */
  readonly status: CommandStatus;
  /** Wall-clock time of the row's current status (issued / accepted / received). */
  readonly at?: string;
  /** Rejection reason or error message; absent for accepted/completed rows. */
  readonly detail?: string;
};
