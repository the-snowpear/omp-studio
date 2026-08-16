import type { CommandReceipt, CommandRequestId, CommandState, StudioClient } from "@omp-studio/client-contract";

const RECEIPT_TIMEOUT_MS = 120_000;

type ReceiptClient = StudioClient;

function commandStateOf(client: StudioClient, requestId: string): CommandState | undefined {
  const getState = (client as { getState?: () => { readonly commands?: Readonly<Record<string, CommandState>> } }).getState;
  if (typeof getState !== "function") return undefined;
  try {
    // StudioClientImpl.getState reads `this.state`. An unbound extract throws
    // "Cannot read properties of undefined (reading 'state')".
    return getState.call(client)?.commands?.[requestId];
  } catch {
    return undefined;
  }
}

const TERMINAL = {
  completed: true,
  failed: true,
  rejected: true,
  outcome_unknown: true,
} as const;

/** Prefer Host `ClientError.message`; never collapse to a generic toast. */
export function hostErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    const invoke = error.message.match(/^Error invoking remote method '[^']+': ([\s\S]+)$/);
    const inner = invoke?.[1]?.trim();
    if (inner && inner !== "[object Object]") return inner;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0 && message !== "[object Object]") return message;
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

function isTerminalReceipt(value: CommandState | undefined): value is CommandReceipt {
  return value !== undefined && value.status in TERMINAL;
}

function receiptFromState(client: ReceiptClient, requestId: string): CommandReceipt | undefined {
  const entry = commandStateOf(client, requestId);
  return isTerminalReceipt(entry) ? entry : undefined;
}

function settleReceipt<T>(receipt: CommandReceipt, resolve: (value: T) => void, reject: (error: unknown) => void): void {
  if (receipt.status === "completed") {
    resolve(receipt.result as T);
    return;
  }
  if (receipt.status === "failed") {
    reject(receipt.error);
    return;
  }
  reject({ code: "INTERNAL_ERROR", message: receipt.reason });
}

export async function waitReceipt<T>(client: ReceiptClient, requestId: string, timeoutMs = RECEIPT_TIMEOUT_MS): Promise<T> {
  const existing = receiptFromState(client, requestId);
  if (existing !== undefined) {
    return await new Promise<T>((resolve, reject) => settleReceipt(existing, resolve, reject));
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (result: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      reject(error);
    };
    const timer = setTimeout(() => fail({ code: "UNAVAILABLE", message: "等待 Host 回执超时" }), timeoutMs);
    const unsub = client.subscribe({ scope: "command", requestId: requestId as CommandRequestId }, (event) => {
      if (event.kind !== "command.receipt" || event.receipt.requestId !== requestId) return;
      settleReceipt(event.receipt, succeed, fail);
    });
    const raced = receiptFromState(client, requestId);
    if (raced !== undefined) {
      settleReceipt(raced, succeed, fail);
    }
  });
}
