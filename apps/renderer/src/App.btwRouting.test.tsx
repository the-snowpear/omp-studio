import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StudioClientImpl } from "@omp-studio/client";
import { contractFixtures } from "@omp-studio/testkit";
import type { ClientTransport } from "@omp-studio/client-contract";
import { App } from "./App";
import { __resetAppSettingsForTests } from "./settings/appSettings";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "./settings/startupNotice";

const probe = vi.hoisted(() => ({ ask: vi.fn(async () => true) }));
vi.mock("./btw/useBtwSession", async original => {
  const module = await original<typeof import("./btw/useBtwSession")>();
  return { ...module, useBtwSession: (input: Parameters<typeof module.useBtwSession>[0]) => ({ ...module.useBtwSession(input), ask: probe.ask }) };
});
const clients: StudioClientImpl[] = [];
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) await client.close();
  localStorage.clear();
  __resetAppSettingsForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("sends a clipboard image with /btw from the main composer while the main turn is running", async () => {
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  localStorage.setItem("omp.previewMode", "0");
  __resetAppSettingsForTests(JSON.stringify({ language: "en", startupPage: "workbench", restoreLastSession: false, rememberLayout: false }));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const bootstrap = structuredClone(contractFixtures.bootstrap);
  const initial = { ...bootstrap, snapshot: { ...bootstrap.snapshot!, isStreaming: true } };
  const command = vi.fn(async (request: { commandName: string; requestId: string }) => ({ commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: new Date().toISOString() }));
  const client = new StudioClientImpl({
    bootstrap: async () => ({ ...initial, cursor: "0", residents: { ...initial.residents, residents: [] } }),
    query: async (request: { queryName: string }) => {
      if (request.queryName === "commands.getManifest") {
        const response = structuredClone(contractFixtures.queryResponses["commands.getManifest"]);
        if (!response.ok) return response;
        return { ...response, result: { ...response.result, commands: [{ ...response.result.commands[0], id: "builtin.btw", name: "btw", description: "Ask a side question" }] } };
      }
      return structuredClone((contractFixtures.queryResponses as Record<string, unknown>)[request.queryName]);
    },
    command, subscribe: () => () => {}, close: async () => {},
  } as unknown as ClientTransport);
  clients.push(client);
  render(<App client={client} />);
  await waitFor(() => expect(document.querySelector("#composerInput")).not.toBeNull());
  const editor = document.querySelector<HTMLElement>("#composerInput")!;
  editor.focus();
  editor.textContent = "/btw explain this image ";
  fireEvent.input(editor);
  const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN0cAAAAASUVORK5CYII=";
  const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
  const file = new File([bytes], "image.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  fireEvent.paste(editor, { clipboardData: { files: [file], getData: () => "" } });
  await waitFor(() => expect(editor.querySelector(".cm-chip")).not.toBeNull());
  await act(async () => { fireEvent.keyDown(editor, { key: "Enter" }); });
  await waitFor(() => expect(probe.ask).toHaveBeenCalledWith(expect.stringContaining("explain this image"), true, [expect.objectContaining({ type: "image", mimeType: "image/png", data })]));
  expect(command.mock.calls.some(([request]) => request.commandName === "core.prompt")).toBe(false);
});
