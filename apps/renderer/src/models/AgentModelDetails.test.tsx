import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ClientBootstrap,
  StudioClient,
} from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { AgentModelDetails } from "./AgentModelDetails";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const capabilities: ClientBootstrap["capabilityManifest"] = {
 profile: "limited", generatedAt: "2026-10-08T00:00:00.000Z", hash: "test",
  capabilities: [{ id: "agent.model.inspect", grade: "stable", version: 1, evidence: "test" }],
};
function view(
  client: StudioClient,
  agentId = "child",
  caps?: ClientBootstrap["capabilityManifest"],
) {
  return (
    <I18nProvider forcedLanguage="en">
      <PreviewModeProvider switchEnabled>
        <AgentModelDetails
          client={client}
          available
          sessionId="main"
          agentId={agentId}
          capabilities={caps}
          running={false}
        />
      </PreviewModeProvider>
    </I18nProvider>
  );
}
it("never sends an unknown command to an old runtime, including on expand and refresh", async () => {
  const client = { command: vi.fn() } as unknown as StudioClient;
  const mounted = render(view(client));
  fireEvent.click(mounted.container.querySelector("summary")!);
  expect(
    (
      screen.getByRole("button", {
        name: "Refresh model details",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(client.command).not.toHaveBeenCalled();
});
it("uses the shared preview display without reading native agent state", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn() } as unknown as StudioClient;
  const mounted = render(view(client));
  fireEvent.click(mounted.container.querySelector("summary")!);
  await screen.findByText("Native live state");
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh model details" }),
  );
  expect(client.command).not.toHaveBeenCalled();
});
it("ignores a late model inspection after changing the selected agent", async () => {
  let resolveOld!: (value: { requestId: string }) => void;
  const old = new Promise<{ requestId: string }>((resolve) => {
    resolveOld = resolve;
  });
  const command = vi
    .fn()
    .mockImplementation((_name, args) =>
      args.agentId === "old" ? old : Promise.resolve({ requestId: "new" }),
    );
  const client = {
    command,
    getState: () => ({
      commands: {
        old: {
          status: "completed",
          result: {
            result: {
              agentId: "old",
              source: "live",
              selectedModel: "stale/model",
            },
          },
        },
        new: {
          status: "completed",
          result: {
            result: {
              agentId: "new",
              source: "saved",
              selectedModel: "current/model",
            },
          },
        },
      },
    }),
  } as unknown as StudioClient;
  const mounted = render(view(client, "old", capabilities));
  fireEvent.click(mounted.container.querySelector("summary")!);
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith("agent.model.inspect", {
      sessionId: "main",
      agentId: "old",
    }),
  );
  mounted.rerender(view(client, "new", capabilities));
  await screen.findByText("current/model");
  await act(async () => resolveOld({ requestId: "old" }));
  expect(screen.queryByText("stale/model")).toBeNull();
  expect(screen.getByText("current/model")).toBeTruthy();
});
