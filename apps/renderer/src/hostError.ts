import type {
  CommandReceipt,
  CommandRequestId,
  CommandState,
  StudioClient,
  Unsubscribe,
} from "@omp-studio/client-contract";

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

type StateWatchClient = StudioClient & {
  getState?: () => { readonly commands?: Readonly<Record<string, CommandState>> };
  onState?: (listener: () => void) => Unsubscribe;
};

const stateWatchClient = (client: StudioClient): StateWatchClient => client as StateWatchClient;

export async function waitReceipt<T>(client: ReceiptClient, requestId: string, timeoutMs?: number): Promise<T> {
  const watched = stateWatchClient(client);
  const command = commandStateOf(watched, requestId);
  const existing = isTerminalReceipt(command) ? command : undefined;
  if (existing !== undefined) {
    return await new Promise<T>((resolve, reject) => settleReceipt(existing, resolve, reject));
  }
  const effectiveTimeoutMs = timeoutMs ?? (command?.commandName === "core.prompt" ? undefined : RECEIPT_TIMEOUT_MS);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let unsub: Unsubscribe = () => undefined;
    let offState: Unsubscribe = () => undefined;
    const succeed = (result: T) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsub();
      offState();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsub();
      offState();
      reject(error);
    };
    const timer =
      effectiveTimeoutMs === undefined
        ? undefined
        : setTimeout(() => fail({ code: "UNAVAILABLE", message: "等待 Host 回执超时" }), effectiveTimeoutMs);
    unsub = client.subscribe({ scope: "command", requestId: requestId as CommandRequestId }, (event) => {
      if (event.kind !== "command.receipt" || event.receipt.requestId !== requestId) return;
      settleReceipt(event.receipt, succeed, fail);
    });
    if (settled) unsub();
    // The reducer can mark an in-flight command outcome_unknown without any
    // matching command.receipt event: re-bootstrap / resync, runtime epoch
    // change, runtime loss. Re-check the command state on every reducer
    // update so the wait settles with the real terminal reason instead of
    // hanging until the timeout ("等待 Host 回执超时") for a command that
    // actually succeeded.
    if (!settled && typeof watched.onState === "function") {
      offState = watched.onState(() => {
        const raced = receiptFromState(watched, requestId);
        if (raced !== undefined) settleReceipt(raced, succeed, fail);
      });
      if (settled) offState();
    }
    const raced = receiptFromState(watched, requestId);
    if (raced !== undefined) {
      settleReceipt(raced, succeed, fail);
    }
  });
}
