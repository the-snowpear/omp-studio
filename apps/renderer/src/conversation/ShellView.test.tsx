import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { ShellVizPreferences, ShellVizPresentation } from "@omp-studio/studio-protocol";
import { previewShellPresentation } from "../preview/runtimeViewsPreview";
import { RuntimeToolProvider, ShellView } from "./ShellView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("waits for the current replay frame and releases the recorded command when closed", async () => {
  let frame!: (value: { available: true; presentation: ShellVizPresentation }) => void;
  let currentPreferences!: ShellVizPreferences;
  const query = vi.fn(async (kind: string, input: { preferences?: ShellVizPreferences }) => {
    if (kind === "extensions.links.list") return { schemes: [] };
    if (kind === "shell.view.release") return { released: true };
    currentPreferences = input.preferences!;
    if (input.preferences!.cursor === undefined) return { available: true, presentation: previewShellPresentation(input.preferences!) };
    return new Promise(resolve => { frame = resolve; });
  });
  render(<RuntimeToolProvider client={{ query } as unknown as Pick<StudioClient, "query">} sessionId="live" sourceSessionId="recorded" enabled>
    <ShellView toolCallId="shell" running={false} maxRows={100} />
  </RuntimeToolProvider>);
  fireEvent.click(screen.getByRole("button", { name: /执行过程|Execution trace/ }));
  const replay = await screen.findByRole("button", { name: /回放|Replay/ });
  vi.useFakeTimers();
  fireEvent.click(replay);
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(query.mock.calls.filter(([kind]) => kind === "shell.view.read")).toHaveLength(2);
  await act(async () => frame({ available: true, presentation: previewShellPresentation(currentPreferences) }));
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(query.mock.calls.filter(([kind]) => kind === "shell.view.read")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: /执行过程|Execution trace/ }));
  expect(query).toHaveBeenCalledWith("shell.view.release", { sessionId: "live", sourceSessionId: "recorded", toolCallId: "shell" });
});

it("stops hidden-window reads and refreshes the presentation when the window becomes visible", async () => {
  vi.useFakeTimers();
  const query = vi.fn(async (kind: string, input: { preferences?: ShellVizPreferences }) => kind === "shell.view.read"
    ? { available: true, presentation: previewShellPresentation(input.preferences!) }
    : kind === "extensions.links.list" ? { schemes: [] } : { released: true });
  render(<RuntimeToolProvider client={{ query } as unknown as Pick<StudioClient, "query">} sessionId="live" sourceSessionId="recorded" enabled>
    <ShellView toolCallId="shell" running maxRows={100} />
  </RuntimeToolProvider>);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /执行过程|Execution trace/ })); });
  expect(screen.getByRole("button", { name: /回放|Replay/ })).toBeTruthy();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(query.mock.calls.filter(([kind]) => kind === "shell.view.read")).toHaveLength(1);
  expect(query).toHaveBeenCalledWith("shell.view.release", { sessionId: "live", sourceSessionId: "recorded", toolCallId: "shell" });
  hidden.mockReturnValue(false);
  await act(async () => { fireEvent(document, new Event("visibilitychange")); });
  expect(query.mock.calls.filter(([kind]) => kind === "shell.view.read")).toHaveLength(2);
});
