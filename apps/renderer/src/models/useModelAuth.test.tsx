import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import { useModelAuth } from "./useModelAuth";

const capabilities = { capabilities: ["models.auth.providers.read", "models.auth.login", "models.auth.cancel", "models.auth.key.set", "models.auth.key.remove"].map(id => ({ id, grade: "stable" })) } as ClientBootstrap["capabilityManifest"];
const status = { sessionId: "owner", providers: [{ id: "otari", name: "Otari", kind: "api-key", available: true, authenticated: true, credentials: [] }] };

it("native credential reads are visibility-scoped and never replace an unavailable read with preview data", async () => {
  const query = vi.fn(async () => status);
  const client = { query } as unknown as StudioClient;
  const context = { client, sessionId: "owner", available: true, capabilities };
  const { result, rerender } = renderHook(({ visible }) => useModelAuth(context, false, visible), { initialProps: { visible: false } });
  expect(query).not.toHaveBeenCalled(); expect(result.current.providers).toBeUndefined();
  rerender({ visible: true });
  await waitFor(() => expect(result.current.providers?.[0]?.id).toBe("otari"));
  expect(query).toHaveBeenCalledWith("models.auth.providers.read", { sessionId: "owner" });
});

it("hiding a pending login sends native cancel for its session and never falls back to RPC or terminal login", async () => {
  let accept!: (value: { requestId: string }) => void;
  const commands: Record<string, unknown> = {};
  const command = vi.fn((kind: string) => {
    if (kind === "models.auth.login") return new Promise<{ requestId: string }>(resolve => { accept = resolve; });
    return Promise.resolve({ requestId: "cancel" });
  });
  const client = { query: vi.fn(async () => status), command, getState: () => ({ commands }) } as unknown as StudioClient;
  const context = { client, sessionId: "owner", available: true, capabilities };
  const { result, rerender } = renderHook(({ visible }) => useModelAuth(context, false, visible), { initialProps: { visible: true } });
  await waitFor(() => expect(result.current.providers).toBeDefined());
  let running!: Promise<boolean>;
  act(() => { running = result.current.login("otari"); });
  rerender({ visible: false });
  expect(command).toHaveBeenCalledWith("models.auth.cancel", { sessionId: "owner", providerId: "otari" });
  commands.login = { status: "completed", result: { providerId: "otari", authenticated: true, cancelled: false } };
  await act(async () => { accept({ requestId: "login" }); await running; });
  expect(result.current.providers).toBeUndefined();
  expect(command.mock.calls.map(([kind]) => kind)).toEqual(["models.auth.login", "models.auth.cancel"]);
});

it("preview credentials and login never send secrets or requests to Host", async () => {
  const client = { query: vi.fn(), command: vi.fn() } as unknown as StudioClient;
  const { result } = renderHook(() => useModelAuth({ client }, true, true));
  await waitFor(() => expect(result.current.providers?.some(row => row.id === "liquid")).toBe(true));
  await act(async () => { await result.current.key("liquid", "preview-entered-secret"); });
  expect(JSON.stringify(result.current.providers)).not.toContain("preview-entered-secret");
  expect(client.query).not.toHaveBeenCalled(); expect(client.command).not.toHaveBeenCalled();
});
