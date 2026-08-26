import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClientEvent,
  CommandReceipt,
  CommandRequestId,
  CommandState,
  StudioClient,
  SubscriptionScope,
  Unsubscribe,
} from "@omp-studio/client-contract";

import { waitReceipt } from "./hostError";

const REQ = "req-1" as CommandRequestId;

interface FakeClientHooks {
  setCommand(id: string, command: unknown): void;
  emitEvent(event: ClientEvent): void;
}

/** StudioClientImpl-shaped fake: getState + onState + subscribe fan-out. */
function fakeClient(initial: Record<string, CommandState> = {}): StudioClient & FakeClientHooks {
  const commands: Record<string, CommandState> = { ...initial };
  const stateListeners = new Set<() => void>();
  const eventListeners = new Set<(event: ClientEvent) => void>();
  const client = {
    getState: () => ({ commands }),
    onState(listener: () => void): Unsubscribe {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
      void scope;
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    async bootstrap() {
      throw new Error("unused");
    },
    async query() {
      throw new Error("unused");
    },
    async command() {
      throw new Error("unused");
    },
    async close() {
      throw new Error("unused");
    },
    setCommand(id: string, command: unknown) {
      if (command === undefined) delete commands[id];
      else commands[id] = command as CommandState;
      for (const listener of [...stateListeners]) listener();
    },
    emitEvent(event: ClientEvent) {
      for (const listener of [...eventListeners]) listener(event);
    },
  };
  return client as StudioClient & FakeClientHooks;
}

const accepted = (commandName = "core.steer"): CommandState =>
  ({
    requestId: REQ,
    commandName,
    status: "accepted",
    acceptedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as CommandState;

function receipt(status: CommandReceipt["status"], extra: Record<string, unknown> = {}): CommandReceipt {
  return {
    requestId: REQ,
    commandName: "core.steer",
    status,
    observedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  } as CommandReceipt;
}

const outcomeUnknown = (reason: string): CommandState =>
  receipt("outcome_unknown", { reason }) as unknown as CommandState;

const cursorlessEvent = (kind: ClientEvent["kind"], payload: Record<string, unknown>): ClientEvent =>
  ({ kind, ...payload }) as ClientEvent;

describe("waitReceipt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the result when a terminal command.receipt event arrives", async () => {
    const client = fakeClient({ [REQ]: accepted() });
    const pendingPromise = waitReceipt(client, REQ, 2_000);
    client.emitEvent(
      cursorlessEvent("command.receipt", {
        receipt: receipt("completed", { result: { ok: true } }),
      }),
    );
    await expect(pendingPromise).resolves.toEqual({ ok: true });
  });

  it("cleans up when subscribe synchronously replays a terminal receipt", async () => {
    let unsubscribed = false;
    const client = {
      getState: () => ({ commands: { [REQ]: accepted() } }),
      subscribe(_scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
        listener(cursorlessEvent("command.receipt", {
          receipt: receipt("completed", { result: { ok: true } }),
        }));
        return () => {
          unsubscribed = true;
        };
      },
    } as unknown as StudioClient;

    await expect(waitReceipt(client, REQ, 2_000)).resolves.toEqual({ ok: true });
    expect(unsubscribed).toBe(true);
  });

  it("cleans up when onState synchronously replays a terminal state", async () => {
    let command = accepted();
    let eventUnsubscribed = false;
    let stateUnsubscribed = false;
    const client = {
      getState: () => ({ commands: { [REQ]: command } }),
      subscribe(): Unsubscribe {
        return () => {
          eventUnsubscribed = true;
        };
      },
      onState(listener: () => void): Unsubscribe {
        command = receipt("completed", { result: { ok: true } }) as unknown as CommandState;
        listener();
        return () => {
          stateUnsubscribed = true;
        };
      },
    } as unknown as StudioClient;

    await expect(waitReceipt(client, REQ, 2_000)).resolves.toEqual({ ok: true });
    expect(eventUnsubscribed).toBe(true);
    expect(stateUnsubscribed).toBe(true);
  });

  it("settles with the real reason when a re-bootstrap marks the command outcome_unknown — not the timeout", async () => {
    const client = fakeClient({ [REQ]: accepted() });
    const pendingPromise = waitReceipt(client, REQ, 1_000);
    // The reducer transitions the in-flight command on bootstrap.set, with no
    // command.receipt event emitted for this requestId.
    client.setCommand(REQ, outcomeUnknown("client re-bootstrapped; outcome unknown"));
    await expect(pendingPromise).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "client re-bootstrapped; outcome unknown",
    });
  });

  it("settles with the real reason when a runtime epoch change marks the command outcome_unknown", async () => {
    const client = fakeClient({ [REQ]: accepted() });
    const pendingPromise = waitReceipt(client, REQ, 1_000);
    client.setCommand(REQ, outcomeUnknown("runtime epoch changed; outcome unknown"));
    await expect(pendingPromise).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "runtime epoch changed; outcome unknown",
    });
  });

  it("rejects with the receipt error when the receipt is failed", async () => {
    const client = fakeClient({ [REQ]: accepted() });
    const pendingPromise = waitReceipt(client, REQ, 2_000);
    client.emitEvent(
      cursorlessEvent("command.receipt", {
        receipt: receipt("failed", { error: { code: "CAPABILITY_UNAVAILABLE", message: "nope" } }),
      }),
    );
    await expect(pendingPromise).rejects.toEqual({
      code: "CAPABILITY_UNAVAILABLE",
      message: "nope",
    });
  });

  it("times out with 等待 Host 回执超时 only when nothing settles", async () => {
    const client = fakeClient({ [REQ]: accepted() });
    await expect(waitReceipt(client, REQ, 30)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "等待 Host 回执超时",
    });
  });

  it("does not apply the generic 120-second timeout to core.prompt", async () => {
    vi.useFakeTimers();
    const client = fakeClient({ [REQ]: accepted("core.prompt") });
    let settled = false;
    const pendingPromise = waitReceipt<{ ok: boolean }>(client, REQ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(120_001);
    expect(settled).toBe(false);
    client.emitEvent(
      cursorlessEvent("command.receipt", {
        receipt: receipt("completed", { result: { ok: true } }),
      }),
    );
    await expect(pendingPromise).resolves.toEqual({ ok: true });
  });

  it("honors an explicit timeout for core.prompt", async () => {
    vi.useFakeTimers();
    const client = fakeClient({ [REQ]: accepted("core.prompt") });
    const pendingPromise = waitReceipt(client, REQ, 30);
    const expectation = expect(pendingPromise).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "等待 Host 回执超时",
    });
    await vi.advanceTimersByTimeAsync(30);
    await expectation;
  });

  it("returns the terminal state immediately when it already exists", async () => {
    const client = fakeClient({ [REQ]: outcomeUnknown("client re-bootstrapped; outcome unknown") });
    await expect(waitReceipt(client, REQ, 200)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "client re-bootstrapped; outcome unknown",
    });
  });
});
