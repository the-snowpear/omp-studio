export type CommandState =
  | "received"
  | "dispatched"
  | "acknowledged"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted"
  | "ambiguous";

export type TerminalCommandState = Extract<
  CommandState,
  "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted" | "ambiguous"
>;

export interface StudioCommand<T = unknown> {
  commandId: string;
  idempotencyKey: string;
  capabilityId: string;
  clientId: string;
  projectId?: string;
  threadId?: string;
  runtimeEpoch?: string;
  expectedControlLeaseRevision?: number;
  expectedWorkspaceLeaseRevision?: number;
  input: T;
  createdAt: number;
}

export interface CommandOutcome<T = unknown> {
  commandId: string;
  state: CommandState;
  runtimeEpoch?: string;
  route?: string;
  ompRequestId?: string;
  runId?: string;
  result?: T;
  errorCode?: string;
  errorMessage?: string;
  updatedAt: number;
}

/**
 * Rules:
 * - POST mutations return 202 + commandId after durable receipt by the Host ledger.
 * - Duplicate idempotencyKey + identical input returns the existing outcome.
 * - Duplicate idempotencyKey + different input returns 409.
 * - A prompt acknowledgement is not turn completion.
 * - Events may precede the acknowledgement; reducers correlate by request/run identity.
 * - Local-only slash commands may finish through prompt_result(agentInvoked=false).
 * - runtimeEpoch change never causes automatic replay of a dispatched command.
 * - If dispatch may have reached OMP but acceptance cannot be proved, state is ambiguous.
 * - Exactly-once execution across Host or OMP crashes is not promised.
 */
export interface CommandLedger {
  accept<T>(command: StudioCommand<T>): Promise<CommandOutcome>;
  get(commandId: string): Promise<CommandOutcome | null>;
  transition(commandId: string, next: CommandState): Promise<CommandOutcome>;
}
