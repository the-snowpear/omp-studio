import { createContext, useContext, useSyncExternalStore, type ContextType, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientEvent, StudioClient, WorkspaceFileInfo } from "@omp-studio/client-contract";
import { ConversationViewContext } from "../conversationWorkspace/Context";
import type { ConversationWorkspaceStore } from "../conversationWorkspace/store";
import { DockStore } from "../dock/store";
import type { FilePanelDescriptor, FilePanelId } from "../dock/types";
import { FileDockInstances } from "./FileDockInstances";
import type { FileViewerActions } from "./fileActions";
import { PreviewSurface } from "../preview/PreviewContext";
import type { FileDocument } from "./fileDocuments";

const engine = createContext<DockStore | null>(null);
const targets = vi.hoisted(() => ({ readyClient: vi.fn(), definitions: vi.fn() }));
vi.mock("../workspaces/ExecutionTargets", () => ({ useExecutionTargets: () => ({ readyClient: targets.readyClient }) }));
vi.mock("../dock/DockContext", () => ({
  useDockEngine: () => ({ store: useContext(engine)!, setFileViewDefinitions: targets.definitions }),
  DockPanel: ({ children }: { children: (visibility: { visible: boolean }) => ReactNode }) => <>{children({ visible: true })}</>,
}));
vi.mock("./FilePane", async () => {
  const { FileDocumentContext, FileLink, useOpenFile } = await import("./fileLinks");
  const { usePreviewMode } = await import("../preview/PreviewContext");
  return { default: ({ descriptor, session, actions }: { descriptor: FilePanelDescriptor; session: FileDocument; actions?: FileViewerActions }) => {
    const open = useOpenFile(), { preview } = usePreviewMode();
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return <section data-testid={descriptor.fileId}>
      <textarea aria-label="File text" value={snapshot.text} onChange={event => session.edit(event.target.value)} />
      <button onClick={() => actions?.addContext({ path: descriptor.path, label: descriptor.title })}>添加到对话</button>
      <button onClick={() => open({ path: "gone.txt", workspaceId: descriptor.workspaceId, targetId: descriptor.targetId })}>打开已删除文件</button>
      <FileDocumentContext.Provider value={{ basePath: descriptor.path, workspaceId: descriptor.workspaceId, targetId: descriptor.targetId, preview }}>
        <FileLink href="docs/UPSTREAM-SYNC.md">打开相对链接</FileLink>
      </FileDocumentContext.Provider>
    </section>;
  },
  };
});
const stores: DockStore[] = [];
afterEach(() => { cleanup(); for (const store of stores.splice(0)) store.flush(); localStorage.removeItem("omp.file-viewer.scope"); vi.clearAllMocks(); vi.useRealTimers(); });

function setup() {
  const source = new DockStore(null), active = new DockStore(null); stores.push(source, active);
  const panel: FilePanelId = "file-view:source";
  const descriptor: FilePanelDescriptor = { targetId: null, workspaceId: "workspace", path: "README.md", fileId: "source-file", title: "README.md", scope: "workspace" };
  source.dispatch({ type: "file-open", panel, descriptor });
  const metadata = { activeDocumentId: "active", documents: ["source", "active"].map(id => ({ id, ref: { workspaceId: "workspace", targetId: null } })) };
  const workspace = { getSnapshot: () => metadata, nextWindowRect: () => ({ x: 0, y: 0, width: 800, height: 640 }) } as unknown as ConversationWorkspaceStore;
  const view = (id: string) => ({ store: workspace, document: metadata.documents.find(item => item.id === id)! }) as NonNullable<ContextType<typeof ConversationViewContext>>;
  const actions = (): FileViewerActions => ({ openers: [], addContext: vi.fn(), runShell: vi.fn() });
  const sourceActions = actions(), activeActions = actions();
  const query = vi.fn(async (name: string, input: { path: string; paths: string[] }) => name === "workspace.paths.resolve"
    ? { resolutions: input.paths.map(path => ({ path, kind: "file" })) }
    : { workspaceId: "workspace", path: input.path, id: input.path, name: input.path, mime: "text/plain", size: 1, version: "v1", writable: true } as WorkspaceFileInfo);
  const listeners = new Set<(event: ClientEvent) => void>();
  const subscribe = vi.fn((_scope: unknown, listener: (event: ClientEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  const client = { query, subscribe } as unknown as StudioClient;
  targets.readyClient.mockResolvedValue(client);
  const ui = (sourceTarget: string | null = null, preview = false) => <PreviewSurface preview={preview}>
    <engine.Provider value={source}><ConversationViewContext.Provider value={view("source")}><FileDockInstances client={client} workspaceId="workspace" targetId={sourceTarget} onSettings={() => {}} actions={sourceActions} /></ConversationViewContext.Provider></engine.Provider>
    <engine.Provider value={active}><ConversationViewContext.Provider value={view("active")}><FileDockInstances client={client} workspaceId="workspace" targetId={null} onSettings={() => {}} actions={activeActions} /></ConversationViewContext.Provider></engine.Provider>
  </PreviewSurface>;
  const emit = (event: ClientEvent) => { for (const listener of listeners) listener(event); };
  return { source, panel, metadata, sourceActions, activeActions, query, subscribe, emit, ui, listeners };
}

it("keeps unsaved file text when a new conversation replaces the old file host", async () => {
  const source = setup(), mounted = render(source.ui());
  const editor = await screen.findByRole("textbox", { name: "File text" });
  fireEvent.change(editor, { target: { value: "unsaved changes stay here" } });
  const next = new DockStore(null); stores.push(next);
  next.dispatch({ type: "apply", layout: source.source.newDraftLayout() });
  const context = { document: { id: "next", ref: { workspaceId: "workspace", targetId: null } },
    store: { getSnapshot: () => ({ activeDocumentId: "next", documents: [{ id: "next", ref: { workspaceId: "workspace", targetId: null } }] }) } } as NonNullable<ContextType<typeof ConversationViewContext>>;
  mounted.rerender(<PreviewSurface preview={false}><engine.Provider key="next" value={next}>
    <ConversationViewContext.Provider value={context}><FileDockInstances workspaceId="workspace" targetId={null} onSettings={() => {}} actions={source.activeActions} /></ConversationViewContext.Provider>
  </engine.Provider></PreviewSurface>);
  const replacement = await screen.findByRole("textbox", { name: "File text" });
  expect((replacement as HTMLTextAreaElement).value).toBe("unsaved changes stay here");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(Object.keys(next.getSnapshot().layout.fileViews)).not.toContain(source.panel);
  fireEvent.change(replacement, { target: { value: "" } });
});

it("adds workspace-owned file context to the current conversation, then follows a changed owner", async () => {
  const source = setup(); render(source.ui());
  const pane = await screen.findByTestId("source-file"), add = within(pane).getByRole("button", { name: "添加到对话" });
  fireEvent.click(add);
  expect(source.activeActions.addContext).toHaveBeenCalledWith({ path: "README.md", label: "README.md" }); expect(source.sourceActions.addContext).not.toHaveBeenCalled();
  source.metadata.activeDocumentId = "source"; fireEvent.click(add);
  expect(source.sourceActions.addContext).toHaveBeenCalledTimes(1);
  source.metadata.activeDocumentId = "active";
  act(() => source.source.dispatch({ type: "file-state", panel: source.panel, patch: { scope: "conversation" } }));
  fireEvent.click(add);
  expect(source.sourceActions.addContext).toHaveBeenCalledTimes(2); expect(source.activeActions.addContext).toHaveBeenCalledTimes(1);
});

it("does not create an unresolved file panel when inspection reports a deleted file", async () => {
  const source = setup();
  source.query.mockImplementation(async (name, input) => {
    if (name === "workspace.file.inspect" && input.path === "gone.txt") throw new Error("Path does not exist: gone.txt");
    return { resolutions: input.paths?.map(path => ({ path, kind: "file" })) };
  });
  render(source.ui());
  const pane = await screen.findByTestId("source-file");
  fireEvent.click(within(pane).getByRole("button", { name: "打开已删除文件" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Path does not exist: gone.txt"));
  expect(Object.keys(source.source.getSnapshot().layout.fileViews)).toEqual([source.panel]);
  expect(screen.getAllByRole("button", { name: "添加到对话" })).toHaveLength(1);
});

it("refreshes a mounted missing link after an AI write, a file mutation and reconnection", async () => {
  vi.useFakeTimers();
  const source = setup();
  let kind = "missing";
  source.query.mockImplementation(async (_name, input) => ({ resolutions: input.paths.map(path => ({ path, kind })) }));
  const view = render(source.ui());
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  expect(screen.queryByRole("link", { name: "打开相对链接" })).toBeNull();
  kind = "file";
  act(() => source.emit({ kind: "conversation.changed", update: { kind: "conversation.tool.completed", result: { type: "toolResult", toolName: "write", toolCallId: "write", isError: false } } } as ClientEvent));
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(screen.getByRole("link", { name: "打开相对链接" })).toBeTruthy();
  kind = "directory";
  act(() => source.emit({ kind: "command.receipt", receipt: { commandName: "fs.rename" } } as ClientEvent));
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(screen.getByRole("link", { name: "打开相对链接" }).classList.contains("is-directory")).toBe(true);
  kind = "missing";
  act(() => source.emit({ kind: "runtime.changed" } as ClientEvent));
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(screen.queryByRole("link", { name: "打开相对链接" })).toBeNull();
  view.unmount();
  expect(source.listeners.size).toBe(0);
});

it("opens preview file links from fixtures without reading or subscribing to the Host", async () => {
  const source = setup();
  render(source.ui(null, true));
  const pane = await screen.findByTestId("source-file");
  fireEvent.click(within(pane).getByRole("link", { name: "打开相对链接" }));
  await screen.findByTestId("preview:docs/UPSTREAM-SYNC.md");
  expect(source.query).not.toHaveBeenCalled();
  expect(source.subscribe).not.toHaveBeenCalled();
  expect(targets.readyClient).not.toHaveBeenCalled();
});

it("observes file receipts from the Host root client separately from the conversation client", async () => {
  vi.useFakeTimers();
  const source = setup(), rootListeners = new Set<(event: ClientEvent) => void>();
  let kind = "missing";
  source.query.mockImplementation(async (_name, input) => ({ resolutions: input.paths.map(path => ({ path, kind })) }));
  targets.readyClient.mockResolvedValue({ query: source.query, subscribe: (_scope: unknown, listener: (event: ClientEvent) => void) => {
    rootListeners.add(listener); return () => { rootListeners.delete(listener); };
  } } as unknown as StudioClient);
  const view = render(source.ui());
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  expect(screen.queryByRole("link", { name: "打开相对链接" })).toBeNull();
  kind = "file";
  act(() => { for (const listener of rootListeners) listener({ kind: "command.receipt", receipt: { commandName: "fs.file.writeText" } } as ClientEvent); });
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(screen.getByRole("link", { name: "打开相对链接" })).toBeTruthy();
  view.unmount();
  expect(rootListeners.size).toBe(0);
  expect(source.listeners.size).toBe(0);
});

it("opens links through the file's original Host target after the conversation switches targets", async () => {
  const source = setup(); render(source.ui("current-ssh"));
  const pane = await screen.findByTestId("source-file");
  fireEvent.click(await within(pane).findByRole("link", { name: "打开相对链接" }));
  await waitFor(() => expect(source.query).toHaveBeenCalledWith("workspace.file.inspect", { workspaceId: "workspace", path: "docs/UPSTREAM-SYNC.md" }));
  expect(targets.readyClient).toHaveBeenCalledWith(null); expect(targets.readyClient).not.toHaveBeenCalledWith("current-ssh");
});
