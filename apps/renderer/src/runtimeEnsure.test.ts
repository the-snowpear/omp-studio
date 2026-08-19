import { describe, expect, it, vi } from "vitest";
import type { CommandReceipt, CommandRequestId, RuntimeConnection } from "@omp-studio/client-contract";
import { ensureRuntimeConnection, type EnsureRuntimeClient } from "./runtimeEnsure";

function receipt(
  requestId: string,
  result: RuntimeConnection | undefined,
  status: "completed" | "failed" = "completed",
): CommandReceipt {
  if (status === "failed") {
    return {
      requestId: requestId as CommandRequestId,
      commandName: "runtime.ensure",
      status: "failed",
      error: { code: "UNAVAILABLE", message: "Runtime is not available" },
      observedAt: "2026-08-19T08:00:00.000Z",
    };
  }
  return {
    requestId: requestId as CommandRequestId,
    commandName: "runtime.ensure",
    status: "completed",
    result: result ?? { status: "disconnected", classification: "managed" },
    observedAt: "2026-08-19T08:00:00.000Z",
  };
}

function clientOf(options: {
  readonly receipts: ReadonlyArray<{ requestId: string; connection?: RuntimeConnection; failed?: boolean }>;
  readonly runtimeEvents?: ReadonlyArray<RuntimeConnection>;
}): EnsureRuntimeClient & { readonly command: ReturnType<typeof vi.fn> } {
  const receipts = [...options.receipts];
  const command = vi.fn(async () => {
    const next = receipts.shift();
    if (next === undefined) throw new Error("unexpected runtime.ensure");
    return { requestId: next.requestId as CommandRequestId };
  });
  const byId = new Map(options.receipts.map((entry) => [entry.requestId, entry]));
  const subscribe = vi.fn((scope: { scope: string; requestId?: string }, listener: (event: { kind: string; receipt?: CommandReceipt; connection?: RuntimeConnection }) => void) => {
    queueMicrotask(() => {
      if (scope.scope === "command" && scope.requestId !== undefined) {
        const entry = byId.get(scope.requestId);
        if (entry === undefined) return;
        listener({
          kind: "command.receipt",
          receipt: receipt(entry.requestId, entry.connection, entry.failed === true ? "failed" : "completed"),
        });
        return;
      }
      if (scope.scope === "runtime") {
        for (const connection of options.runtimeEvents ?? []) {
          listener({ kind: "runtime.changed", connection });
        }
      }
    });
    return () => undefined;
  });
  return { command, subscribe } as unknown as EnsureRuntimeClient & { readonly command: ReturnType<typeof vi.fn> };
}

describe("ensureRuntimeConnection", () => {
  it("treats a connected receipt as success", async () => {
    const connection: RuntimeConnection = { status: "connected", classification: "managed" };
    const client = clientOf({ receipts: [{ requestId: "req-1", connection }] });
    const labels: string[] = [];
    await expect(ensureRuntimeConnection(client, { force: true }, (progress) => labels.push(progress.label))).resolves.toEqual({
      ok: true,
      connection,
    });
    expect(client.command).toHaveBeenCalledTimes(1);
    expect(client.command).toHaveBeenCalledWith("runtime.ensure", { force: true });
    expect(labels[0]).toBe("正在停止当前托管进程");
    expect(labels).toContain("正在启动 Runtime");
  });

  it("surfaces a failed receipt", async () => {
    const client = clientOf({ receipts: [{ requestId: "req-2", failed: true }] });
    await expect(ensureRuntimeConnection(client)).resolves.toEqual({
      ok: false,
      message: "Runtime is not available",
    });
    expect(client.command).toHaveBeenCalledWith("runtime.ensure", {});
  });

  it("force restart follows up with ensure when the process is still down", async () => {
    const connected: RuntimeConnection = { status: "connected", classification: "managed" };
    const client = clientOf({
      receipts: [
        { requestId: "req-force", connection: { status: "disconnected", classification: "managed", disconnectCode: "process-exit" } },
        { requestId: "req-ensure", connection: connected },
      ],
    });
    const labels: string[] = [];
    await expect(ensureRuntimeConnection(client, { force: true }, (progress) => labels.push(progress.label))).resolves.toEqual({
      ok: true,
      connection: connected,
    });
    expect(client.command.mock.calls).toEqual([
      ["runtime.ensure", { force: true }],
      ["runtime.ensure", {}],
    ]);
    expect(labels).toContain("正在重新连接 Runtime");
  });

  it("waits for runtime.changed when ensure returns connecting", async () => {
    const connected: RuntimeConnection = { status: "connected", classification: "managed" };
    const client = clientOf({
      receipts: [{ requestId: "req-3", connection: { status: "connecting", classification: "managed" } }],
      runtimeEvents: [connected],
    });
    await expect(ensureRuntimeConnection(client)).resolves.toEqual({ ok: true, connection: connected });
    expect(client.command).toHaveBeenCalledTimes(1);
  });
});
