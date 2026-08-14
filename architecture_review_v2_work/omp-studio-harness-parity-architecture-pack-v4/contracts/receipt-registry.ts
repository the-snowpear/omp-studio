export type ReceiptType =
  | "runtime.started"
  | "runtime.stopped"
  | "runtime.settled"
  | "preview.ready"
  | "preview.stopped"
  | "projection.committed"
  | "workspace.snapshot.created";

export interface ReceiptScope {
  environmentId: string;
  workspaceId?: string;
  threadId?: string;
  runtimeEpoch?: string;
  correlationId: string;
}

export interface RuntimeReceipt<T = unknown> extends ReceiptScope {
  type: ReceiptType;
  emittedAt: number;
  value: T;
}

export interface ReceiptWait<T = unknown> extends ReceiptScope {
  type: ReceiptType;
  deadlineAt: number;
  signal?: AbortSignal;
}

export interface ReceiptRegistry {
  wait<T>(request: ReceiptWait<T>): Promise<RuntimeReceipt<T>>;
  resolve<T>(receipt: RuntimeReceipt<T>): boolean;
  rejectScope(scope: Partial<ReceiptScope>, reason: Error): number;
}

/**
 * ReceiptRegistry is an awaited coordination primitive. It is not a durable
 * event store, a client notification bus, or an unscoped global Pub/Sub system.
 */

