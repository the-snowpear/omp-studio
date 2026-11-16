import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { SelectiveCommitDraft, SelectiveCommitPreview, SelectiveCommitRead } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { SelectiveCommitPane, selectiveCommitHandoff } from "./SelectiveCommitPane";

const patchA = "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+SAFE_A\n";
const patchB = `${patchA}@@ -20 +20 @@\n-old-b\n+INCLUDED_B\n`;
function draft(revision = 1, id = "draft-1"): SelectiveCommitDraft {
  return { sessionId: "live", runtimeEpoch: 1, expiresAt: Date.now() + 300_000, view: {
    id, revision, head: "1111111", branch: "test", caller: "main", scope: ["main"], agents: [], state: "open", staged: [], skipped: [],
    paths: [{ path: "example.ts", kind: "text", change: "modified", beforeMode: "100644", afterMode: "100644", workBytes: 100, staged: false, selected: revision === 1 ? "partial" : "all", ownership: ["own", "other"],
      hunks: [{ id: "1", headStart: 1, headCount: 20, workStart: 1, workCount: 20, units: [
        { id: "1a", actor: "main", opIds: [1], ownership: ["own"], selected: "all", added: 1, removed: 1, likely: false, reasons: [] },
        { id: "2a", actor: null, opIds: [2], ownership: ["other"], selected: revision === 1 ? "none" : "all", added: 1, removed: 1, likely: false, reasons: [] },
      ] }],
    }],
  } };
}
function frozen(value: SelectiveCommitDraft): SelectiveCommitPreview {
  return { draftId: value.view.id, revision: value.view.revision, previewId: `preview-${value.view.revision}`, head: value.view.head, tree: `tree-${value.view.revision}`, bytes: patchB.length, paths: ["example.ts"], expiresAt: value.expiresAt };
}
function read(value: SelectiveCommitDraft, text: string): SelectiveCommitRead {
  return { draft: value, body: { kind: "preview", text, offset: 0, totalChars: text.length } };
}
function setup(options: { prepare?: () => Promise<SelectiveCommitDraft>; readA?: Promise<SelectiveCommitRead> } = {}) {
  let current = draft();
  let serial = 0;
  const receipts: Record<string, unknown> = {};
  const query = vi.fn(async (kind: string, input: Record<string, unknown>) => {
    if (kind === "commit.draft.prepare") return options.prepare ? options.prepare() : current;
    if (kind === "commit.draft.preview") return frozen(current);
    if (kind === "commit.draft.release") return { released: true };
    if (kind === "commit.draft.read") {
      const body = input.body as { kind: string; previewId?: string } | undefined;
      if (body?.previewId === "preview-1" && options.readA) return options.readA;
      return read(current, body?.previewId === "preview-1" ? patchA : patchB);
    }
    throw Error(`Unexpected query ${kind}`);
  });
  const command = vi.fn(async (kind: string, input: Record<string, unknown>) => {
    const requestId = `commit-${++serial}`;
    const result = kind === "commit.draft.select" ? (current = draft(2)) : { sha: "2222222", subject: (input.message as { subject: string }).subject, paths: ["example.ts"], parent: "1111111", indexNotes: [] };
    receipts[requestId] = { status: "completed", result: { result } };
    return { requestId };
  });
  const client = { query, command, getState: () => ({ commands: receipts }), subscribe: () => () => {} } as unknown as StudioClient;
  return { client, query, command };
}
function view(client: StudioClient, key?: number) {
  return <I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><SelectiveCommitPane client={client} sessionId="live" runtimeEpoch={1} available supported visible {...(key === undefined ? {} : { intent: { key } })} /></PreviewModeProvider></I18nProvider>;
}
function mount(client: StudioClient, key?: number) {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  return render(view(client, key));
}
afterEach(() => { cleanup(); localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY); });
async function click(name: string) {
  const button = screen.getByRole("button", { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await act(async () => { fireEvent.click(button); });
}

it("opens the handed-off native draft without preparing another one and keeps its opaque notes", async () => {
  const { client, query, command } = setup();
  const handoff = selectiveCommitHandoff({ requiresConfirmation: true, selectiveCommit: { draftId: "draft-1", revision: 1, runtimeEpoch: 1 }, instructions: "Keep the selected change, not unrelated edits." });
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><SelectiveCommitPane client={client} sessionId="live" runtimeEpoch={1} available supported visible intent={{ key: 1, ...handoff }} /></PreviewModeProvider></I18nProvider>);
  await waitFor(() => expect(query).toHaveBeenCalledWith("commit.draft.read", { sessionId: "live", draftId: "draft-1", revision: 1 }));
  expect(query.mock.calls.some(([kind]) => kind === "commit.draft.prepare")).toBe(false);
  await click("Freeze preview");
  expect(screen.getByText("Keep the selected change, not unrelated edits.")).toBeTruthy();
  expect(command).not.toHaveBeenCalled();
});

it("cannot show an earlier frozen patch under a new preview, even when its response arrives late", async () => {
  let finishRead!: (value: SelectiveCommitRead) => void;
  const readA = new Promise<SelectiveCommitRead>(resolve => { finishRead = resolve; });
  const { client, query, command } = setup({ readA });
  mount(client);
  await click("Prepare draft");
  await click("Freeze preview");
  await click("Read diff");
  await click("Back");
  fireEvent.click(document.querySelector(".scm-path-row")!);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select unit 2a" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("commit.draft.select", expect.objectContaining({ revision: 1 })));
  await click("Freeze preview");
  const region = screen.getByRole("region", { name: "Frozen patch" });
  await act(async () => { finishRead(read(draft(), patchA)); });
  expect(region.textContent).not.toContain("SAFE_A");
  expect(within(region).getByRole("button", { name: "Read diff" })).toBeTruthy();
  await click("Read diff");
  await waitFor(() => expect(region.textContent).toContain("INCLUDED_B"));
  expect(query).toHaveBeenCalledWith("commit.draft.read", expect.objectContaining({ revision: 2, body: { kind: "preview", previewId: "preview-2" } }));
  const subject = "A valid native subject ".repeat(12);
  const input = screen.getByRole("textbox", { name: /Subject/ }) as HTMLInputElement;
  expect(input.maxLength).toBe(-1);
  fireEvent.change(input, { target: { value: subject } });
  await click("Commit 1 files");
  expect(command).toHaveBeenCalledWith("commit.draft.execute", expect.objectContaining({ previewId: "preview-2", revision: 2, message: { subject: subject.trim() } }));
});

it.each(["unmount", "supersede"] as const)("releases a preparation that finishes after %s", async mode => {
  let finish!: (value: SelectiveCommitDraft) => void;
  const pending = new Promise<SelectiveCommitDraft>(resolve => { finish = resolve; });
  const prepare = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(draft(1, "current-draft"));
  const { client, query } = setup({ prepare });
  const ui = mount(client, 1);
  await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  if (mode === "unmount") ui.unmount();
  else { ui.rerender(view(client, 2)); await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2)); }
  await act(async () => { finish(draft(1, "late-draft")); });
  expect(query).toHaveBeenCalledWith("commit.draft.release", { sessionId: "live", draftId: "late-draft" });
  expect(query).not.toHaveBeenCalledWith("commit.draft.release", { sessionId: "live", draftId: "current-draft" });
});

it.each([
  ["self", "self"], ["*", "*"], ["worker-a worker-b", ["worker-a", "worker-b"]],
] as const)("prepares native agent scope %s without changing scalar aliases into arrays", async (text, scope) => {
  const { client, query } = setup();
  mount(client);
  fireEvent.change(screen.getByRole("textbox", { name: "Draft agent scope" }), { target: { value: text } });
  await click("Prepare draft");
  expect(query).toHaveBeenCalledWith("commit.draft.prepare", { sessionId: "live", scope });
});
