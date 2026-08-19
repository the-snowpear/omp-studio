import type { CommandReceipt, CommandRequestId, RuntimeConnection } from "@omp-studio/client-contract";
import { waitForCommandReceipt, type CommandWaitClient } from "./sessionLifecycle";
import { runtimeCanReconnect } from "./diagnosticsModel";
import type { ActionProgress } from "./ActionProgressBar";

type EnsureEvent = {
  readonly kind: string;
  readonly receipt?: CommandReceipt;
  readonly connection?: RuntimeConnection;
};

export type EnsureRuntimeClient = {
  command(
    name: "runtime.ensure",
    input: { readonly force?: boolean },
  ): Promise<{ requestId: CommandRequestId }>;
  subscribe(
    scope: { readonly scope: "command"; readonly requestId: CommandRequestId } | { readonly scope: "runtime" },
    listener: (event: EnsureEvent) => void,
  ): () => void;
};

export type EnsureRuntimeResult =
  | { readonly ok: true; readonly connection: RuntimeConnection }
  | { readonly ok: false; readonly message: string };

export type RuntimeEnsureProgress = ActionProgress & {
  readonly phase: "stopping" | "starting" | "connecting" | "waiting";
};

export const RUNTIME_ENSURE_WAIT_MS = 45_000;

type EnsureAttempt =
  | { readonly ok: true; readonly connection: RuntimeConnection }
  | { readonly ok: false; readonly message: string; readonly connection?: RuntimeConnection };

type RuntimeEvent = {
  readonly kind: string;
  readonly connection?: RuntimeConnection;
};

/**
 * Start or restart the managed Runtime and wait until it is connected.
 * `force` stops a live process first; if the receipt is not yet connected,
 * a follow-up ensure + runtime.changed wait completes the reconnect.
 */
export async function ensureRuntimeConnection(
  client: EnsureRuntimeClient,
  input: { readonly force?: boolean } = {},
  onProgress?: (progress: RuntimeEnsureProgress) => void,
): Promise<EnsureRuntimeResult> {
  const force = input.force === true;
  const steps = force ? 3 : 2;
  if (force) {
    onProgress?.(progress("stopping", "正在停止当前托管进程", 1, steps));
  } else {
    onProgress?.(progress("connecting", "正在请求连接", 1, steps));
  }
  try {
    if (force) {
      onProgress?.(progress("starting", "正在启动 Runtime", 2, steps));
    }
    const first = await runEnsure(client, force);
    if (first.ok) return first;
    if (first.connection?.status === "connecting") {
      onProgress?.(progress("waiting", "正在等待 Runtime 就绪", steps, steps));
      return waitUntilConnected(client, first.connection);
    }
    if (force && canFollowUpReconnect(first.connection)) {
      onProgress?.(progress("connecting", "正在重新连接 Runtime", 3, steps));
      const second = await runEnsure(client, false);
      if (second.ok) return second;
      if (second.connection?.status === "connecting") {
        onProgress?.(progress("waiting", "正在等待 Runtime 就绪", 3, steps));
        return waitUntilConnected(client, second.connection);
      }
      return toResult(second);
    }
    return toResult(first);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "重新连接 Runtime 失败" };
  }
}

function progress(
  phase: RuntimeEnsureProgress["phase"],
  label: string,
  step: number,
  steps: number,
): RuntimeEnsureProgress {
  return { phase, label, step, steps };
}

function toResult(attempt: EnsureAttempt): EnsureRuntimeResult {
  return attempt.ok ? attempt : { ok: false, message: attempt.message };
}

function canFollowUpReconnect(connection: RuntimeConnection | undefined): boolean {
  if (connection === undefined) return true;
  return runtimeCanReconnect(connection);
}

async function runEnsure(client: EnsureRuntimeClient, force: boolean): Promise<EnsureAttempt> {
  const handle = await client.command("runtime.ensure", force ? { force: true } : {});
  const receipt = await waitForCommandReceipt(client as CommandWaitClient, handle.requestId);
  return resultFromReceipt(receipt);
}

function resultFromReceipt(receipt: CommandReceipt): EnsureAttempt {
  if (receipt.status === "completed") {
    const connection = receipt.result as RuntimeConnection | undefined;
    if (connection?.status === "connected") {
      return { ok: true, connection };
    }
    return {
      ok: false,
      message: connectionMessage(connection),
      ...(connection === undefined ? {} : { connection }),
    };
  }
  if (receipt.status === "failed") {
    return { ok: false, message: receipt.error.message };
  }
  return { ok: false, message: "重新连接未完成" };
}

function connectionMessage(connection: RuntimeConnection | undefined): string {
  if (connection?.status === "connecting") return "Runtime 正在连接";
  return connection?.disconnectReason ?? connection?.unavailableReason ?? "Runtime 未能连接";
}

function currentRuntime(client: EnsureRuntimeClient): RuntimeConnection | undefined {
  try {
    const getState = (client as { getState?: () => { readonly connection?: { readonly runtime?: RuntimeConnection | null } } }).getState;
    return getState?.()?.connection?.runtime ?? undefined;
  } catch {
    return undefined;
  }
}

function waitUntilConnected(
  client: EnsureRuntimeClient,
  seed: RuntimeConnection | undefined,
): Promise<EnsureRuntimeResult> {
  const already = connectedOf(currentRuntime(client) ?? seed);
  if (already !== undefined) return Promise.resolve({ ok: true, connection: already });
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => undefined;
    const finish = (result: EnsureRuntimeResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    unsubscribe = client.subscribe({ scope: "runtime" }, (event: RuntimeEvent) => {
      if (event.kind !== "runtime.changed") return;
      const connection = event.connection;
      if (connection?.status === "connected") {
        finish({ ok: true, connection });
        return;
      }
      if (connection !== undefined && connection.status === "unavailable" && !runtimeCanReconnect(connection)) {
        finish({ ok: false, message: connectionMessage(connection) });
      }
    });
    const raced = connectedOf(currentRuntime(client));
    if (raced !== undefined) {
      finish({ ok: true, connection: raced });
      return;
    }
    timer = setTimeout(() => {
      finish({ ok: false, message: "等待 Runtime 连接超时" });
    }, RUNTIME_ENSURE_WAIT_MS);
  });
}

function connectedOf(connection: RuntimeConnection | undefined): RuntimeConnection | undefined {
  return connection?.status === "connected" ? connection : undefined;
}
