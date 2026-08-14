export type StudioCommandState =
  | "received"
  | "validated"
  | "dispatched"
  | "acknowledged"
  | "running"
  | "cancel_requested"
  | "cancel_acknowledged"
  | "deadline_exceeded"
  | "outcome_unknown"
  | "succeeded"
  | "failed"
  | "rejected";

export type TerminalStudioCommandState = Extract<
  StudioCommandState,
  "deadline_exceeded" | "outcome_unknown" | "succeeded" | "failed" | "rejected"
>;

export interface StudioCommand<TPayload = unknown> {
  commandId: string;
  commandType: string;
  environmentId: string;
  workspaceId?: string;
  threadId?: string;
  expectedAuthorityEpoch: string;
  expectedRuntimeEpoch?: string;
  expectedRevision?: string;
  idempotencyKey?: string;
  submittedBy: string;
  submittedAt: number;
  deadlineAt?: number;
  payload: TPayload;
}

export interface CommandLedgerEntry<TResult = unknown> {
  commandId: string;
  state: StudioCommandState;
  authorityEpoch: string;
  runtimeEpoch?: string;
  routeId?: string;
  correlationId: string;
  createdAt: number;
  updatedAt: number;
  targetAcknowledged?: boolean;
  cancellationAcknowledged?: boolean;
  result?: TResult;
  errorCode?: string;
  errorMessage?: string;
}

export interface CommandLedger {
  receive(command: StudioCommand): Promise<CommandLedgerEntry>;
  transition(
    commandId: string,
    from: readonly StudioCommandState[],
    to: StudioCommandState,
    patch?: Partial<CommandLedgerEntry>,
  ): Promise<CommandLedgerEntry>;
  get(commandId: string): Promise<CommandLedgerEntry | null>;
}

/**
 * A deadline only bounds how long Studio waits. It does not prove the target
 * stopped. Re-dispatch after `outcome_unknown` is forbidden unless the selected
 * route has a verified idempotency contract.
 */

