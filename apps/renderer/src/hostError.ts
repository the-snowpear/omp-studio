import type { StudioClient } from "@omp-studio/client-contract";

const RECEIPT_TIMEOUT_MS = 120_000;

/** Prefer Host `ClientError.message`; never collapse to a generic toast. */
export function hostErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

export async function waitReceipt<T>(client: StudioClient, requestId: string, timeoutMs = RECEIPT_TIMEOUT_MS): Promise<T> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      if (error) reject(error);
      else resolve(result as T);
    };
    const timer = setTimeout(() => finish({ code: "UNAVAILABLE", message: "等待 Host 回执超时" }), timeoutMs);
    const unsub = client.subscribe({ scope: "command", requestId: requestId as never }, (event) => {
      if (event.kind !== "command.receipt" || event.receipt.requestId !== requestId) return;
      if (event.receipt.status === "completed") finish(undefined, event.receipt.result as T);
      else if (event.receipt.status === "failed") finish(event.receipt.error);
      else finish({ code: "INTERNAL_ERROR", message: event.receipt.status });
    });
  });
}
