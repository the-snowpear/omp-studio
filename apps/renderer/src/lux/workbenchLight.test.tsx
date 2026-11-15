import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StudioClientImpl } from "@omp-studio/client";
import { contractFixtures } from "@omp-studio/testkit";
import type { ClientTransport } from "@omp-studio/client-contract";
import { App } from "../App";
import { __resetAppSettingsForTests } from "../settings/appSettings";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "../settings/startupNotice";

const clients: StudioClientImpl[] = [];

afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) await client.close();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  __resetAppSettingsForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(preview: boolean) {
  window.history.replaceState(null, "", preview ? "?preview=1&marks=off" : "/");
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  __resetAppSettingsForTests(JSON.stringify({ language: "en", startupPage: "workbench", rememberLayout: false, restoreLastSession: false, light: "vivid" }));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const initial = structuredClone(contractFixtures.bootstrap);
  const snapshot = { ...initial.snapshot!, plan: { status: "review" as const, title: "Review the change", body: "Approve the implementation." } };
  const transport: ClientTransport = {
    bootstrap: async () => ({ ...initial, snapshot, residents: { ...initial.residents!, activeSessionId: snapshot.sessionId, residents: [] } }),
    query: async request => structuredClone((contractFixtures.queryResponses as Record<string, unknown>)[request.queryName]) as never,
    command: async request => ({ commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: new Date().toISOString() }),
    subscribe: () => () => {},
    close: async () => {},
  };
  const client = new StudioClientImpl(transport);
  clients.push(client);
  render(<App client={client} />);
  await waitFor(() => expect(document.querySelector("#workbench")).not.toBeNull());
}

function waitingLight() {
  expect(document.querySelector(".composer .lux-halo")?.getAttribute("data-state")).toBe("waiting");
  expect(document.querySelector(".lux-ambient")?.getAttribute("data-activity")).toBe("waiting");
}

it("lights a real Plan review as waiting without a pending interaction", async () => {
  await mount(false);
  await screen.findByRole("button", { name: /Approve and execute/i });
  await waitFor(waitingLight);
});

it("keeps preview Plan and Ask cards lit while they await a response", async () => {
  await mount(true);
  fireEvent.click(screen.getByRole("button", { name: /Mermaid/ }));
  const approve = await screen.findByRole("button", { name: /Approve and execute/i });
  await waitFor(waitingLight);
  fireEvent.click(approve);
  await screen.findByRole("radiogroup");
  await waitFor(waitingLight);
});
