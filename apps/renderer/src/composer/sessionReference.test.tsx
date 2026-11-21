import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRef, type ReactNode } from "react";
import type { ClientQueryRequest, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { StudioClientImpl } from "@omp-studio/client";
import { createContractFixtureApi, contractFixtures } from "@omp-studio/testkit";
import type { RemoteApi, RemoteInventory } from "../../../desktop/src/remote/shared";
import { ExecutionTargets } from "../workspaces/ExecutionTargets";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { previewSessionId } from "../preview/fixtures";
import { I18nProvider } from "../i18n";
import { UserMessageBody } from "../conversation/UserMessageBody";
import { selectOption } from "../test/selectOption";
import { ChipComposer, type ChipComposerHandle } from "./ChipComposer";
import { CopySessionMenuItem, SessionReferencesProvider } from "./SessionReferences";
import { nextSessionReference, serializeSessionReference } from "./sessionReference";
import { snapshotFromText } from "./serialize";
import { snapshotOfQueued } from "./queueEdit";
import { planComposerSend } from "./commands";

const sourceId = "019344b4-5c01-7450-a3c4-fc7a91c3d6fb";
const sourceWorkspace = "source-workspace" as WorkspaceId;
const localWorkspace = contractFixtures.bootstrap.selected!.workspaceId;
const localClient = () => new StudioClientImpl(createContractFixtureApi());

function wrap(client: StudioClient, children: ReactNode, language: "zh" | "en" = "en") {
  return <I18nProvider forcedLanguage={language}><PreviewModeProvider>
    <ExecutionTargets client={client}>{() => <SessionReferencesProvider workspaceId={localWorkspace} onOpenLegacy={() => {}}>
      {children}
    </SessionReferencesProvider>}</ExecutionTargets>
  </PreviewModeProvider></I18nProvider>;
}

function paste(editor: HTMLElement, text: string) {
  fireEvent.paste(editor, { clipboardData: { files: [], getData: (type: string) => type === "text/plain" ? text : "" } });
}

function setClipboard() {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

function mockDialog() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  globalThis.ompStudioRemote = undefined;
  window.history.replaceState(null, "", "/");
});

it("copies the row ID with feedback and pastes an inline reference without sending", async () => {
  const writeText = setClipboard();
  const client = localClient();
  const ref = createRef<ChipComposerHandle>();
  const submit = vi.fn();
  render(wrap(client, <>
    <CopySessionMenuItem identity={{ sessionId: sourceId, source: { targetId: null, workspaceId: sourceWorkspace, title: "Other chat" } }} onClose={() => {}} />
    <ChipComposer ref={ref} sessionReferences onSubmit={submit} />
  </>));
  const copy = screen.getByRole("menuitem", { name: "Copy session ID" });
  fireEvent.click(copy);
  await screen.findByText("Session ID copied");
  expect(writeText).toHaveBeenCalledWith(sourceId);
  writeText.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
  fireEvent.click(copy);
  await screen.findByText("Clipboard access was denied");

  const editor = screen.getByRole("textbox");
  act(() => ref.current!.setSnapshot(snapshotFromText("before after")));
  const range = document.createRange();
  range.setStart(editor.firstChild!, 7);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  paste(editor, sourceId);
  expect(ref.current!.getSnapshot().doc.nodes).toMatchObject([
    { type: "text", value: "before " },
    { type: "chip", chip: { kind: "session", label: "Other chat" } },
    { type: "text", value: " after" },
  ]);
  expect(nextSessionReference(ref.current!.getSnapshot().text, 0)?.reference).toEqual({ sessionId: sourceId, messages: [] });
  paste(editor, sourceId);
  expect(editor.querySelectorAll(".cm-chip-session")).toHaveLength(1);
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true, shiftKey: true });
  paste(editor, sourceId);
  expect(editor.textContent).toContain(sourceId);
  expect(submit).not.toHaveBeenCalled();
});

it("preserves unknown UUIDs and ignores lookup results after switching drafts", async () => {
  const client = localClient();
  const ref = createRef<ChipComposerHandle>();
  let respond!: (result: unknown[]) => void;
  const locate = vi.spyOn(client, "query")
    .mockResolvedValueOnce([] as never)
    .mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }) as never);
  render(wrap(client, <ChipComposer ref={ref} sessionReferences />));
  const editor = screen.getByRole("textbox");
  const unknown = "a1c086bd-6c5f-477f-a5ac-dfab346b7c52";
  paste(editor, unknown);
  await waitFor(() => expect(locate).toHaveBeenCalledWith("history.locate", { sessionId: unknown }));
  expect(ref.current!.getSnapshot().text).toBe(unknown);
  expect(editor.querySelector(".cm-chip-session")).toBeNull();
  paste(editor, unknown);
  await waitFor(() => expect(respond).toBeTypeOf("function"));
  act(() => ref.current!.setSnapshot(snapshotFromText("another draft")));
  await act(async () => respond([{
    workspaceId: sourceWorkspace, workspaceName: "Source project",
    entry: { title: "Late lookup", sessionId: unknown },
  }]));
  expect(ref.current!.getSnapshot().text).toBe("another draft");
  expect(editor.querySelector(".cm-chip-session")).toBeNull();
});

it("reads excerpts in the remote project's context and preserves the selection after disconnect and restore", async () => {
  mockDialog();
  const client = localClient();
  const localQuery = vi.spyOn(client, "query");
  const remoteId = "019344b4-5c01-7450-a3c4-fc7a91c3d6fc";
  localQuery.mockResolvedValueOnce([
    { workspaceId: localWorkspace, workspaceName: "Local project", entry: { sessionId: remoteId, title: "Local copy" } },
  ] as never);
  const ref = createRef<ChipComposerHandle>();
  const fixture = createContractFixtureApi();
  const reply = "Keep @example.ts, /skill:review, ^provider/model, and +2k as literal text.\n\n**Important** review result.";
  let changed = () => {};
  let inventory: RemoteInventory = {
    profiles: [{ id: "ssh", name: "Dev SSH", host: "localhost", platform: "linux" }],
    statuses: [{ id: "ssh", state: "connected", generation: 1 }],
  };
  const remote = {
    list: async () => inventory,
    onChanged: (listener: () => void) => { changed = listener; return () => {}; },
    onEvent: () => () => {},
    bootstrap: () => fixture.bootstrap(),
    openContext: vi.fn(async () => "source-context"),
    closeContext: async () => {},
    query: vi.fn(async (_id: string, request: ClientQueryRequest) => {
      if (request.queryName === "history.locate") return { ok: true, queryName: "history.locate", result: [
        { workspaceId: sourceWorkspace, workspaceName: "Remote project", entry: { sessionId: remoteId, title: "Review changes" } },
      ] };
      if (request.queryName === "session.transcript.readPage") return { ok: true, queryName: request.queryName, result: { items: [
        { kind: "message", role: "user", content: [{ type: "text", text: "Analyze the diff." }] },
        { kind: "message", role: "assistant", content: [{ type: "thinking", text: "private thinking" }, { type: "text", text: reply }] },
      ] } };
      return fixture.query(request);
    }),
  } as unknown as RemoteApi;
  globalThis.ompStudioRemote = remote;
  render(wrap(client, <ChipComposer ref={ref} sessionReferences />));
  paste(await screen.findByRole("textbox"), remoteId);
  fireEvent.click(await screen.findByRole("button", { name: "Session 019344b4" }));
  const dialog = await screen.findByRole("dialog");
  expect(remote.openContext).not.toHaveBeenCalled();
  selectOption(within(dialog).getByRole("combobox", { name: "Choose a session source" }), "Dev SSH · Remote project · Review changes");
  const unchecked = await within(dialog).findAllByRole("checkbox");
  expect(unchecked).toHaveLength(2);
  expect(unchecked.every(checkbox => !(checkbox as HTMLInputElement).checked)).toBe(true);
  expect(within(dialog).queryByText("private thinking")).toBeNull();
  expect(remote.openContext).toHaveBeenCalledWith("ssh", { workspaceId: sourceWorkspace });
  expect(localQuery.mock.calls.some(([name]) => name === "session.transcript.readPage")).toBe(false);

  fireEvent.click(unchecked[1]!);
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
  const snapshot = ref.current!.getSnapshot();
  expect(snapshot.text).not.toMatch(/Dev SSH|Remote project|Analyze the diff|@example|\/skill:|\^provider|\+2k/u);
  expect(nextSessionReference(snapshot.text, 0)?.reference).toEqual({
    sessionId: remoteId, messages: [{ role: "assistant", text: reply }],
  });
  const queued = snapshotOfQueued({ id: 1, text: snapshot.text });
  expect(planComposerSend(queued)).toMatchObject({ kind: "prompt", snapshot: { text: snapshot.text } });
  await act(async () => { inventory = { ...inventory, statuses: [{ id: "ssh", state: "disconnected" }] }; changed(); });
  fireEvent.click(screen.getByRole("button", { name: /Review changes.*1 attached/u }));
  const excerpt = within(await screen.findByRole("dialog"));
  await excerpt.findByText("Important");
  expect(excerpt.getByText(/Keep @example\.ts/u).textContent).toContain("literal text.");
  expect(screen.getByText("Source environment is unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  act(() => ref.current!.setSnapshot(queued));
  expect(ref.current!.getSnapshot().text).toBe(snapshot.text);
});

it("keeps selected preview messages through language switching and shows saved message excerpts", async () => {
  mockDialog();
  setClipboard();
  window.history.replaceState(null, "", "/?preview=1&marks=off");
  const client = localClient();
  const ref = createRef<ChipComposerHandle>();
  const sessionId = previewSessionId("t1");
  const renderView = (language: "zh" | "en") => wrap(client, <>
    <CopySessionMenuItem identity={{ sessionId, source: { targetId: null, workspaceId: "p1" as WorkspaceId, previewThreadId: "t1" } }} onClose={() => {}} />
    <ChipComposer ref={ref} sessionReferences />
  </>, language);
  const { rerender } = render(renderView("zh"));
  fireEvent.click(screen.getByRole("menuitem", { name: "复制会话 ID" }));
  await screen.findByText("已复制会话 ID");
  paste(screen.getByRole("textbox"), sessionId);
  fireEvent.click(screen.getByRole("button", { name: "跟踪上游 pi-web 更新到 omp-web" }));
  const check = await screen.findByRole("checkbox", { name: "附带第 1 条消息" });
  fireEvent.click(check);
  rerender(renderView("en"));
  expect((screen.getByRole("checkbox", { name: "Attach message 1" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByText("Demo")).toBeNull();
  rerender(renderView("zh"));
  expect((screen.getByRole("checkbox", { name: "附带第 1 条消息" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  const reference = nextSessionReference(ref.current!.getSnapshot().text, 0)!.reference;
  expect(reference.messages).toHaveLength(1);
  cleanup();
  render(<I18nProvider forcedLanguage="en"><UserMessageBody text={serializeSessionReference(reference)} /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: /1 attached/u }));
  expect(within(screen.getByRole("dialog")).getByText(reference.messages[0]!.text)).toBeTruthy();
});
