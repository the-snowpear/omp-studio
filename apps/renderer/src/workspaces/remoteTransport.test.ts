import { expect, it, vi } from "vitest";
import type { ClientBootstrap, ClientEvent } from "@omp-studio/client-contract";
import type { RemoteApi } from "../../../desktop/src/remote/shared";
import { createRemoteTransport, type RemoteTransportState } from "./remoteTransport";
import type { WorkspaceId } from "@omp-studio/client-contract";

it("ignores old-generation events and query results after reconnect", async () => {
  let event!: Parameters<RemoteApi["onEvent"]>[0];
  let resolve!: (value: ClientBootstrap) => void;
  const api = { bootstrap: () => new Promise<ClientBootstrap>(done => { resolve = done; }), onEvent: (listener: typeof event) => { event = listener; return () => {}; } } as unknown as RemoteApi;
  const state: RemoteTransportState = { available: true, synchronized: true, generation: 1, revision: 1, syncRevision: 1 };
  const transport = createRemoteTransport(api, "target", state);
  const listener = vi.fn();
  transport.subscribe({ scope: "all" }, listener);
  const pending = transport.bootstrap();
  const rejected = expect(pending).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
  state.generation = 2; state.revision = 2;
  event({ id: "target", generation: 1, event: { kind: "state.changed" } as ClientEvent });
  expect(listener).not.toHaveBeenCalled();
  event({ id: "target", generation: 2, event: { kind: "state.changed" } as ClientEvent });
  expect(listener).toHaveBeenCalledTimes(1);
  resolve({} as ClientBootstrap); await rejected;
});

it("rejects writes before synchronization and never retries an uncertain command", async () => {
  const api = { command: vi.fn(async () => { throw { code: "OUTCOME_UNKNOWN", message: "connection lost" }; }) } as unknown as RemoteApi;
  const state: RemoteTransportState = { available: true, synchronized: false, generation: 1, revision: 1, syncRevision: 0 };
  const transport = createRemoteTransport(api, "target", state);
  const command = { commandName: "git.execute", input: {}, requestId: "test", idempotencyKey: "test" } as never;
  await expect(transport.command(command)).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
  expect(api.command).not.toHaveBeenCalled();
  state.synchronized = true;
  await expect(transport.command(command)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  state.generation++; state.revision++;
  expect(api.command).toHaveBeenCalledTimes(1);
});

it("discards contexts opened before reconnect without overwriting the new context", async () => {
  const old = Promise.withResolvers<string>();
  const current = Promise.withResolvers<string>();
  const api = {
    openContext: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise),
    bootstrap: vi.fn(async () => ({} as ClientBootstrap)),
  } as unknown as RemoteApi;
  const state: RemoteTransportState = { available: true, synchronized: true, generation: 1, revision: 1, syncRevision: 1 };
  const transport = createRemoteTransport(api, "target", state, { workspaceId: "workspace" as WorkspaceId });
  const rejected = expect(transport.bootstrap()).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
  state.generation++; state.revision++;
  const next = transport.bootstrap();
  current.resolve("new-context");
  await next;
  old.resolve("old-context");
  await rejected;
  await transport.bootstrap();
  expect(api.bootstrap).toHaveBeenCalledTimes(2);
  expect(api.bootstrap).toHaveBeenLastCalledWith("target", "new-context");
});

it("does not send a queued command when synchronization is lost while its context opens", async () => {
  const opening = Promise.withResolvers<string>();
  const api = { openContext: vi.fn(() => opening.promise), command: vi.fn() } as unknown as RemoteApi;
  const state: RemoteTransportState = { available: true, synchronized: true, generation: 1, revision: 1, syncRevision: 1 };
  const transport = createRemoteTransport(api, "target", state, { workspaceId: "workspace" as WorkspaceId });
  const pending = expect(transport.command({ commandName: "git.execute" } as never)).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
  state.synchronized = false;
  opening.resolve("context");
  await pending;
  expect(api.command).not.toHaveBeenCalled();
});

it("keeps root events out of an opening conversation and retries a failed context open", async () => {
  let event!: Parameters<RemoteApi["onEvent"]>[0];
  const api = {
    openContext: vi.fn().mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce("context"),
    bootstrap: vi.fn(async () => ({} as ClientBootstrap)),
    onEvent: (listener: typeof event) => { event = listener; return () => {}; },
  } as unknown as RemoteApi;
  const state: RemoteTransportState = { available: true, synchronized: true, generation: 1, revision: 1, syncRevision: 1 };
  const transport = createRemoteTransport(api, "target", state, { workspaceId: "workspace" as WorkspaceId });
  const listener = vi.fn();
  transport.subscribe({ scope: "all" }, listener);
  event({ id: "target", generation: 1, event: { kind: "state.changed" } as ClientEvent });
  expect(listener).not.toHaveBeenCalled();
  await expect(transport.bootstrap()).rejects.toThrow("temporary failure");
  await transport.bootstrap();
  expect(api.bootstrap).toHaveBeenCalledWith("target", "context");
  await transport.close();
  event({ id: "target", contextId: "context", generation: 1, event: { kind: "state.changed" } as ClientEvent });
  expect(listener).not.toHaveBeenCalled();
});
