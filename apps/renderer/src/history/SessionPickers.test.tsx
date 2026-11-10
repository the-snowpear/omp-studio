import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { SessionResumeRow } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { SessionImportPanel } from "../SessionImportPanel";
import { selectOption } from "../test/selectOption";
import { ResumeScopePane } from "./ResumeScopePane";
import type { NativeHistoryContext } from "./NativeArchivePane";

const originalUrl = window.location.href;
afterEach(() => {
  cleanup();
  localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
  window.history.replaceState(null, "", originalUrl);
});

const manifest = {
  profile: "limited" as const, generatedAt: "2026-11-10T00:00:00Z", hash: "session-picker-test",
  capabilities: ["worktrees.session.resume.list", "worktrees.session.resume.prepare", "session.import.execute"].map(id => ({ id, grade: "stable" as const, version: 1, evidence: "test" })),
};
const context: NativeHistoryContext = { available: true, sessionId: "live", capabilities: manifest };
const workspace = { workspaceId: "destination", name: "Destination", active: false, lastOpenedAt: "2026-11-10T00:00:00Z" };
const current: SessionResumeRow = { sessionId: "current", title: "Attachment recovery", modifiedAt: "2026-10-28T02:20:00Z", currentDirectory: true, directoryName: "studio", firstMessage: "Check the saved attachments.", conversationExcerpt: "The original attachments are ready.", messageCount: 18, status: "complete" };
const moved: SessionResumeRow = { sessionId: "moved", title: "Migration copy", modifiedAt: "2026-10-28T02:15:00Z", currentDirectory: false, directoryName: "studio-worktree", continuationOf: "earlier", firstMessage: "Continue in the new worktree." };

function receiptClient(respond: (kind: string, input: Record<string, unknown>) => unknown) {
  let next = 0;
  const receipts: Record<string, unknown> = {};
  const command = vi.fn(async (kind: string, input: Record<string, unknown>) => {
    const requestId = `picker-${++next}`;
    const result = await respond(kind, input);
    receipts[requestId] = { status: "completed", result: { result } };
    return { requestId };
  });
  const query = vi.fn(async (kind: string) => kind === "capabilities.get" ? manifest : { workspaces: [workspace] });
  const client = { command, query, getState: () => ({ commands: receipts }), subscribe: () => () => {} } as unknown as StudioClient;
  return { client, command, query };
}

function mount(children: ReactNode, preview = false) {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, preview ? "1" : "0");
  return render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled>{children}</PreviewModeProvider></I18nProvider>);
}

it("uses the native default once, previews the selection and resumes the resolved continuing copy", async () => {
  const { client, command } = receiptClient((kind, input) => kind === "worktrees.session.resume.list"
    ? { scope: input.scope ?? "directory", sessions: input.scope === "repo" ? [current, moved] : [current], truncated: false }
    : { requestedSessionId: "moved", targetSessionId: "latest-copy", workspaceId: "worktree-destination" });
  const onOpen = vi.fn();
  mount(<ResumeScopePane client={client} context={context} onOpen={onOpen} />);
  expect(command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Resume OMP session" }));
  const dialog = await screen.findByRole("dialog", { name: "Resume OMP session" });
  const preview = within(dialog).getByRole("complementary", { name: "Session preview" });
  await within(preview).findByText("The original attachments are ready.");
  expect(command).toHaveBeenCalledTimes(1);
  expect(command).toHaveBeenCalledWith("worktrees.session.resume.list", { sessionId: "live" });
  expect(screen.getByRole("combobox", { name: "Resume scope" }).textContent).toBe("This directory");

  selectOption(screen.getByRole("combobox", { name: "Resume scope" }), "Repository worktrees");
  await within(dialog).findByRole("button", { name: /Migration copy/ });
  const search = within(dialog).getByRole("searchbox");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  await within(preview).findByRole("heading", { name: "Migration copy" });
  expect(within(preview).getByText("Continuing copy")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith("latest-copy", "worktree-destination"));
  expect(command).toHaveBeenCalledWith("worktrees.session.resume.prepare", { sessionId: "live", targetSessionId: "moved", scope: "repo" });
  expect(command.mock.calls.filter(([kind]) => kind === "worktrees.session.resume.list")).toHaveLength(2);
});

it("requires a destination for a missing import directory, then waits for an explicit open", async () => {
  const foreign = { source: "claude", sourceId: "foreign", title: "Saved conversation", directoryName: "old-project", modifiedAt: "2026-11-01T00:00:00Z", cwdExists: false, messageCount: 3 };
  const { client, command } = receiptClient(kind => kind === "session.import.list" ? { sessions: [foreign] }
    : kind === "session.import.preview" ? { session: foreign, preview: "user: Preserve this conversation." }
      : { imported: true, sessionId: "imported", workspaceId: "destination" });
  const onOpen = vi.fn(), onImported = vi.fn();
  mount(<SessionImportPanel client={client} onOpen={onOpen} onImported={onImported} />);
  const trigger = await screen.findByRole("button", { name: "Import Claude / Codex sessions" });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger);
  await screen.findByText("user: Preserve this conversation.");
  expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
  selectOption(screen.getByRole("combobox", { name: "Import workspace" }), "Destination");
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByText("Imported. The source file is unchanged.");
  expect(command).toHaveBeenCalledWith("session.import.execute", { source: "claude", sourceId: "foreign", fallbackWorkspaceId: "destination" });
  expect(onImported).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(onOpen).toHaveBeenCalledWith("imported", "destination");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("lets the user switch source during a preview read without showing the late previous preview", async () => {
  const claude = { source: "claude", sourceId: "claude", title: "Claude conversation", directoryName: "studio", modifiedAt: "2026-11-01T00:00:00Z", cwdExists: true };
  const codex = { ...claude, source: "codex", sourceId: "codex", title: "Codex conversation" };
  let finishClaude!: (value: unknown) => void;
  const pendingClaude = new Promise(resolve => { finishClaude = resolve; });
  const { client, command } = receiptClient((kind, input) => kind === "session.import.list" ? { sessions: [input.source === "claude" ? claude : codex] }
    : input.source === "claude" ? pendingClaude : { session: codex, preview: "assistant: Codex preview." });
  mount(<SessionImportPanel client={client} onOpen={() => {}} />);
  const trigger = screen.getByRole("button", { name: "Import Claude / Codex sessions" });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger);
  await waitFor(() => expect(command).toHaveBeenCalledWith("session.import.preview", { source: "claude", sourceId: "claude" }));
  fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
  await screen.findByText("assistant: Codex preview.");
  await act(async () => { finishClaude({ session: claude, preview: "assistant: Late Claude preview." }); });
  expect(screen.getByText("assistant: Codex preview.")).toBeTruthy();
  expect(screen.queryByText("assistant: Late Claude preview.")).toBeNull();
  expect(screen.getByRole("tab", { name: "Codex" }).getAttribute("aria-selected")).toBe("true");
});

it("keeps both preview flows local and hides demo markings when marks are off", async () => {
  window.history.replaceState(null, "", "?marks=off");
  const { client, command, query } = receiptClient(() => { throw Error("Preview must not invoke the Host"); });
  const onOpen = vi.fn(), onImported = vi.fn(), onPreviewOpen = vi.fn();
  mount(<><ResumeScopePane client={client} context={context} onOpen={onOpen} onPreviewOpen={onPreviewOpen} /><SessionImportPanel client={client} onOpen={onOpen} onImported={onImported} onPreviewOpen={onPreviewOpen} /></>, true);
  fireEvent.click(screen.getByRole("button", { name: "Resume OMP session" }));
  await screen.findByRole("heading", { name: "会话恢复与附件检查" });
  expect(screen.queryByText("Demo")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Resume session" }));
  fireEvent.click(screen.getByRole("button", { name: "Import Claude / Codex sessions" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByText("Imported. The source file is unchanged.");
  expect(screen.queryByText("Demo")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(command).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
  expect(onImported).not.toHaveBeenCalled();
  expect(onPreviewOpen).toHaveBeenCalledTimes(2);
});
