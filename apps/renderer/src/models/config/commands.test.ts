import { afterEach, expect, it, vi } from "vitest";
import { StudioClientImpl } from "@omp-studio/client";
import type { ClientEvent, ClientTransport } from "@omp-studio/client-contract";
import { contractFixtures } from "@omp-studio/testkit";
import { runWrite } from "./commands";

afterEach(() => vi.useRealTimers());

for (const commandName of ["models.roles.set", "agents.definition.configure", "models.provider.test", "models.provider.probe", "models.catalog.refresh"] as const) {
  it(`${commandName} receives completion before refreshing an initially unbootstrapped local client`, async () => {
    vi.useFakeTimers();
    let listener: ((event: ClientEvent) => void) | undefined;
    let saved = false, sequence = 41;
    const bootstrap = vi.fn(async () => ({ ...contractFixtures.bootstrap, cursor: "41" as typeof contractFixtures.bootstrap.cursor }));
    const transport = {
      bootstrap,
      subscribe: (_scope: unknown, next: (event: ClientEvent) => void) => { listener = next; return () => { listener = undefined; }; },
      command: vi.fn(async request => {
        saved = true;
        const emit = (event: object) => listener?.({ ...event, authorityEpoch: 7, cursor: String(++sequence) } as ClientEvent);
        const accepted = { requestId: request.requestId, commandName: request.commandName, status: "accepted", acceptedAt: "2026-01-01T00:00:00Z" };
        emit({ kind: "command.accepted", accepted });
        emit({ kind: "command.receipt", receipt: { requestId: request.requestId, commandName: request.commandName, status: "completed", result: { applied: true, runtimeEffect: "new-session" }, observedAt: "2026-01-01T00:00:00Z" } });
        return accepted;
      }),
      query: vi.fn(async request => ({ ok: true, queryName: request.queryName, result: { saved } })),
      close: async () => {},
    } as unknown as ClientTransport;
    const client = new StudioClientImpl(transport);
    try {
      const result = runWrite(client, commandName as never, {});
      const completed = result.then(value => ({ value }), error => ({ error }));
      await vi.runAllTimersAsync();
      expect(saved).toBe(true);
      expect(await completed).toEqual({ value: { applied: true, runtimeEffect: "new-session" } });
      expect(await client.query("models.get", {})).toEqual({ saved: true });
      await runWrite(client, commandName as never, {});
      expect(bootstrap).toHaveBeenCalledOnce();
    } finally { await client.close(); }
  });
}

it("does not submit configuration when client initialization fails", async () => {
  const command = vi.fn();
  const client = new StudioClientImpl({ bootstrap: async () => { throw new Error("Test connection unavailable"); }, subscribe: () => () => {}, command, close: async () => {} } as unknown as ClientTransport);
  try {
    await expect(runWrite(client, "models.roles.set", {})).rejects.toThrow("Test connection unavailable");
    expect(command).not.toHaveBeenCalled();
  } finally { await client.close(); }
});
