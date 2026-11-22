import type {
  CommandReceipt,
  CommandRequestId,
  CommandState,
  StudioClient,
  Unsubscribe,
} from "@omp-studio/client-contract";
import { pickLocale } from "./i18n";

const RECEIPT_TIMEOUT_MS = 120_000;

export class HostReceiptTimeout extends Error {
  readonly code = "UNAVAILABLE";

  constructor() {
    super(pickLocale("等待 Host 回执超时", "Timed out waiting for Host receipt"));
  }
}

type ReceiptClient = Pick<StudioClient, "subscribe">;

function commandStateOf(client: ReceiptClient, requestId: string): CommandState | undefined {
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

const INVOKE_PREFIX = /^Error invoking remote method '[^']+': ([\s\S]+)$/;

/**
 * Electron wraps a rejected `ipcRenderer.invoke` with
 * `Error invoking remote method '<channel>': <inner>`. The inner message is
 * the Host `ClientError.message`. Strip the wrapper so surfaces show the Host
 * message, not the transport plumbing.
 */
function stripInvokePrefix(message: string): string | undefined {
  const inner = message.match(INVOKE_PREFIX)?.[1]?.trim();
  return inner !== undefined && inner !== "" && inner !== "[object Object]" ? inner : undefined;
}

/**
 * Prefer Host `ClientError.message`; never collapse to a generic toast. The
 * invoke prefix is stripped for both `Error` instances and plain objects —
 * transport rejections cross the Studio client as plain `{ code, message }`
 * objects (`toClientError`), not `Error` instances.
 */
export function hostErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    const inner = stripInvokePrefix(error.message);
    if (inner !== undefined) return inner;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0 && message !== "[object Object]") {
      const inner = stripInvokePrefix(message);
      if (inner !== undefined) return inner;
      return message;
    }
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

/**
 * True when a command was rejected because the Host has no live Runtime
 * snapshot (`<command> requires a Runtime snapshot`). The Runtime is (re)
 * starting, so this is transient and self-resolving. The original `UNAVAILABLE`
 * code is flattened to `TRANSPORT_ERROR` across the desktop IPC boundary, so
 * match the message.
 */
export function isRuntimeSnapshotUnavailable(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? (error as { message?: unknown }).message
        : undefined;
  return typeof message === "string" && message.includes("requires a Runtime snapshot");
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

type StateWatchClient = ReceiptClient & {
  getState?: () => { readonly commands?: Readonly<Record<string, CommandState>> };
  onState?: (listener: () => void) => Unsubscribe;
};

const stateWatchClient = (client: ReceiptClient): StateWatchClient => client as StateWatchClient;

export async function waitReceipt<T>(client: ReceiptClient, requestId: string, timeoutMs: number | null = RECEIPT_TIMEOUT_MS): Promise<T> {
  const watched = stateWatchClient(client);
  const existing = receiptFromState(watched, requestId);
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
      offState?.();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      offState?.();
      reject(error);
    };
    // A native human picker has no protocol deadline; closing or resync still settles through command state.
    const timer = timeoutMs === null ? undefined : setTimeout(() => fail(new HostReceiptTimeout()), timeoutMs);
    const unsub = client.subscribe({ scope: "command", requestId: requestId as CommandRequestId }, (event) => {
      if (event.kind !== "command.receipt" || event.receipt.requestId !== requestId) return;
      settleReceipt(event.receipt, succeed, fail);
    });
    // The reducer can mark an in-flight command outcome_unknown without any
    // matching command.receipt event: re-bootstrap / resync, runtime epoch
    // change, runtime loss. Re-check the command state on every reducer
    // update so the wait settles with the real terminal reason instead of
    // hanging until the timeout ("等待 Host 回执超时") for a command that
    // actually succeeded.
    const offState =
      typeof watched.onState === "function"
        ? watched.onState(() => {
            const raced = receiptFromState(watched, requestId);
            if (raced !== undefined) settleReceipt(raced, succeed, fail);
          })
        : undefined;
    const raced = receiptFromState(watched, requestId);
    if (raced !== undefined) {
      settleReceipt(raced, succeed, fail);
    }
  });
}
