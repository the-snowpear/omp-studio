import { createContext, useContext, type ContextType, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient, WorkspaceFileInfo } from "@omp-studio/client-contract";
import { ConversationViewContext } from "../conversationWorkspace/Context";
import type { ConversationWorkspaceStore } from "../conversationWorkspace/store";
import { DockStore } from "../dock/store";
import type { FilePanelDescriptor, FilePanelId } from "../dock/types";
import { FileDockInstances } from "./FileDockInstances";
import type { FileViewerActions } from "./fileActions";

const engine = createContext<DockStore | null>(null);
const targets = vi.hoisted(() => ({ readyClient: vi.fn(), definitions: vi.fn() }));
vi.mock("../workspaces/ExecutionTargets", () => ({ useExecutionTargets: () => ({ readyClient: targets.readyClient }) }));
vi.mock("../dock/DockContext", () => ({
  useDockEngine: () => ({ store: useContext(engine)!, setFileViewDefinitions: targets.definitions }),
  DockPanel: ({ children }: { children: (visibility: { visible: boolean }) => ReactNode }) => <>{children({ visible: true })}</>,
}));
vi.mock("./FilePane", () => ({ default: ({ descriptor, actions, onOpen }: { descriptor: FilePanelDescriptor; actions?: FileViewerActions; onOpen: (reference: { path: string }) => void }) => <section data-testid={descriptor.fileId}><button onClick={() => actions?.addContext({ path: descriptor.path, label: descriptor.title })}>添加到对话</button><button onClick={() => onOpen({ path: "linked.md" })}>打开相对链接</button></section> }));
const stores: DockStore[] = [];
afterEach(() => { cleanup(); for (const store of stores.splice(0)) store.flush(); localStorage.removeItem("omp.file-viewer.scope"); vi.clearAllMocks(); });

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
  const query = vi.fn(async (_name: string, input: { path: string }) => ({ workspaceId: "workspace", path: input.path, id: input.path, name: input.path, mime: "text/plain", size: 1, version: "v1", writable: true } as WorkspaceFileInfo));
  targets.readyClient.mockResolvedValue({ query } as unknown as StudioClient);
  const ui = (sourceTarget: string | null = null) => <>
    <engine.Provider value={source}><ConversationViewContext.Provider value={view("source")}><FileDockInstances workspaceId="workspace" targetId={sourceTarget} onSettings={() => {}} actions={sourceActions} /></ConversationViewContext.Provider></engine.Provider>
    <engine.Provider value={active}><ConversationViewContext.Provider value={view("active")}><FileDockInstances workspaceId="workspace" targetId={null} onSettings={() => {}} actions={activeActions} /></ConversationViewContext.Provider></engine.Provider>
  </>;
  return { source, panel, metadata, sourceActions, activeActions, query, ui };
}

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

it("opens links through the file's original Host target after the conversation switches targets", async () => {
  const source = setup(); render(source.ui("current-ssh"));
  const pane = await screen.findByTestId("source-file");
  fireEvent.click(within(pane).getByRole("button", { name: "打开相对链接" }));
  await waitFor(() => expect(source.query).toHaveBeenCalledWith("workspace.file.inspect", { workspaceId: "workspace", path: "linked.md" }));
  expect(targets.readyClient).toHaveBeenCalledWith(null); expect(targets.readyClient).not.toHaveBeenCalledWith("current-ssh");
});
