import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StudioClientImpl } from "@omp-studio/client";
import type { ClientEvent, ClientTransport, StudioClient, WorkspaceListReadModel, WorkspaceRecord } from "@omp-studio/client-contract";
import { contractFixtures } from "@omp-studio/testkit";
import { DiagnosticsPage } from "../DiagnosticsPage";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { __resetUpdatesForTests } from "../settings/updates";
import { WorkspaceRecoveryPane } from "./WorkspaceRecoveryPane";

afterEach(() => { cleanup(); vi.restoreAllMocks(); __resetUpdatesForTests(); localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY); window.history.replaceState({}, "", "/"); });

it("recovers through the root client when the saved conversation is unusable, with live language switching", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const project: WorkspaceRecord = { workspaceId: "project" as never, name: "Test project", root: "C:/project", active: true, lastOpenedAt: "2026-11-17T08:00:00Z" };
  const stale: WorkspaceRecord = { ...project, workspaceId: "stale" as never, name: "Old installation", root: "D:/old-install", active: false, unavailable: true };
  let model: WorkspaceListReadModel = { activeWorkspaceId: project.workspaceId, workspaces: [project, stale] };
  let listener: ((event: ClientEvent) => void) | undefined, cursor = 41;
  const bootstrap = vi.fn(async () => ({ ...contractFixtures.bootstrap, cursor: "41" }));
  const command = vi.fn(async request => {
    if (request.commandName === "workspace.forgetUnavailable") model = { ...model, workspaces: [project] };
    const accepted = { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: "2026-11-17T08:00:00Z" };
    listener?.({ authorityEpoch: 7 as never, stateVersion: 1 as never, cursor: String(++cursor) as never, occurredAt: "2026-11-17T08:00:00Z", kind: "command.receipt", receipt: { ...accepted, status: "completed", result: model, observedAt: "2026-11-17T08:00:00Z" } } as ClientEvent);
    return accepted;
  });
  const root = new StudioClientImpl({ bootstrap, command, query: async () => ({ ok: true, queryName: "projects.list", result: model }), subscribe: (_scope: unknown, next: typeof listener) => { listener = next; return () => { listener = undefined; }; }, close: async () => {} } as unknown as ClientTransport);
  const blockedCommand = vi.fn(async () => { throw new Error("Saved session cannot be restored"); });
  const blocked = { command: blockedCommand, query: async () => { throw new Error("Saved session cannot be restored"); }, bootstrap: async () => { throw new Error("Saved session cannot be restored"); }, subscribe: () => () => {}, close: async () => {} } as unknown as StudioClient;
  const open = vi.fn();
  const view = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><PreviewModeProvider switchEnabled><DiagnosticsPage client={blocked} recoveryClient={root} onOpenRecoveryWorkspace={open} runtime={{ status: "unavailable", classification: "managed" }} /></PreviewModeProvider></I18nProvider>;
  const mounted = render(view("zh"));
  try {
    await screen.findByText("D:/old-install");
    for (const language of ["en", "zh"] as const) {
      mounted.rerender(view(language));
      expect(screen.getByRole("region", { name: language === "zh" ? "工作区恢复" : "Workspace recovery" })).toBeTruthy();
      expect(screen.getByText("D:/old-install")).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "选择项目并新建对话" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(project));
    expect(command.mock.calls[0]![0].commandName).toBe("workspace.pick");
    expect(blockedCommand).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledOnce();

    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "清除失效记录" }));
    expect(command).toHaveBeenCalledTimes(1);
    confirmation.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "清除失效记录" }));
    await screen.findByText("失效记录已清除");
    expect(screen.queryByText("D:/old-install")).toBeNull();
    mounted.rerender(view("en"));
    expect(screen.getByText("Unavailable records forgotten")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start conversation in Test project" })).toBeTruthy();
  } finally { mounted.unmount(); await root.close(); }
});

it("keeps preview recovery local and preserves cleared state across language changes with marks off", () => {
  window.history.replaceState({}, "", "/?preview=1&marks=off");
  const query = vi.fn(), command = vi.fn(), open = vi.fn();
  const client = { query, command } as unknown as StudioClient;
  const view = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><PreviewModeProvider switchEnabled><WorkspaceRecoveryPane client={client} onOpenWorkspace={open} /></PreviewModeProvider></I18nProvider>;
  const mounted = render(view("zh"));
  fireEvent.click(screen.getByRole("button", { name: "清除失效记录" }));
  mounted.rerender(view("en"));
  const pane = within(screen.getByRole("region", { name: "Workspace recovery" }));
  expect(pane.queryByText("Directory unavailable")).toBeNull();
  fireEvent.click(pane.getByRole("button", { name: "Choose project and start conversation" }));
  expect(pane.queryByText("Demo")).toBeNull();
  expect(pane.queryByRole("status")).toBeNull();
  expect(query).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});

it("keeps the picker actionable when real workspace inventory cannot be read", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const client = { query: async () => { throw new Error("Inventory unavailable"); } } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><WorkspaceRecoveryPane client={client} /></PreviewModeProvider></I18nProvider>);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Choose project and start conversation" }).getAttribute("disabled")).toBeNull();
  expect(screen.queryByText("omp-web")).toBeNull();
});
