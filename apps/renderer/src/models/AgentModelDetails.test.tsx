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
import { PreviewModeProvider, PreviewSurface } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { AgentModelDetails } from "./AgentModelDetails";
import { selectOption } from "../test/selectOption";
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
it("keeps a preview hot-switched model and effort through zh → en → zh", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn() } as unknown as StudioClient;
  const content = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><PreviewModeProvider switchEnabled><AgentModelDetails client={client} sessionId="main" agentId="child" available running={false} /></PreviewModeProvider></I18nProvider>;
  const mounted = render(content("zh"));
  fireEvent.click(mounted.container.querySelector("summary")!);
  selectOption(await screen.findByRole("combobox", { name: "切换模型" }), /GPT-5/);
  selectOption(screen.getByRole("combobox", { name: "思考档位" }), "low");
  mounted.rerender(content("en"));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Change model" }).textContent).toContain("GPT-5"));
  expect(screen.getByRole("combobox", { name: "Thinking effort" }).textContent).toBe("low");
  mounted.rerender(content("zh"));
  expect(screen.getByRole("combobox", { name: "切换模型" }).textContent).toContain("GPT-5");
  expect(screen.getByRole("combobox", { name: "思考档位" }).textContent).toBe("low");
  expect(client.command).not.toHaveBeenCalled();
});
it("clears preview model controls when returning to an unavailable real Runtime", async () => {
  const command = vi.fn(), client = { command } as unknown as StudioClient;
  const content = (preview: boolean) => <I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><PreviewSurface preview={preview}><AgentModelDetails client={client} sessionId="main" agentId="child" available={false} running={false} /></PreviewSurface></PreviewModeProvider></I18nProvider>;
  const mounted = render(content(true));
  fireEvent.click(mounted.container.querySelector("summary")!);
  await screen.findByRole("combobox", { name: "Change model" });
  mounted.rerender(content(false));
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "Change model" })).toBeNull());
  expect(screen.queryByText("Native live state")).toBeNull();
  expect(screen.getByText("This Runtime does not provide agent model details.")).toBeTruthy();
  expect(command).not.toHaveBeenCalled();
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
