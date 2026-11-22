import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StudioClient, WorkspaceFileInfo } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import type { FilePanelDescriptor } from "../dock/types";
import { PreviewSurface } from "../preview/PreviewContext";
import FilePane from "./FilePane";
import { FileDocument } from "./fileDocuments";

const viewer = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("./PdfPane", () => ({ default: ({ url }: { url: string }) => { useEffect(() => { viewer.start(); return () => viewer.stop(); }, []); return <div data-testid="pdf-view">{url}</div>; } }));
vi.mock("./FileTextEditor", () => ({ default: ({ gitMarks }: { gitMarks?: { additions: number } }) => <div data-testid="text-view" data-git-additions={gitMarks?.additions ?? 0} /> }));
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); viewer.start.mockClear(); viewer.stop.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup(path = "report.pdf", preview = false) {
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const file: WorkspaceFileInfo = { workspaceId: "workspace" as WorkspaceFileInfo["workspaceId"], id: "pdf", path, name: path, mime: path.endsWith("webm") ? "video/webm" : path.endsWith("pdf") ? "application/pdf" : "text/plain", size: 128, version: "v1", writable: true };
  const query = vi.fn(async (_name?: string, _input?: unknown): Promise<unknown> => file), client = { query } as unknown as StudioClient;
  const session = new FileDocument(file, async () => client, preview), setVisible = vi.spyOn(session, "setVisible");
  const open = vi.fn(async () => ({ id: "lease", url: "omp-file://viewer/lease", file })), release = vi.fn(async () => {});
  vi.stubGlobal("ompStudioChrome", { files: { open, release } });
  const descriptor: FilePanelDescriptor = { targetId: null, workspaceId: "workspace", path: file.path, fileId: file.id, title: file.name, scope: "conversation" };
  const onViewState = vi.fn();
  const pane = (visible: boolean, language: "zh" | "en" = "zh") => <I18nProvider forcedLanguage={language}><PreviewSurface preview={preview}><FilePane id="file-view:pdf" descriptor={descriptor} session={session} visible={visible} onSettings={() => {}} onViewState={onViewState} /></PreviewSurface></I18nProvider>;
  return { pane, descriptor, session, query, open, release, setVisible, onViewState, hideDocument: () => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); } };
}

it("updates a preview Markdown fixture with the mounted language while retaining the file", async () => {
  const source = setup("docs/README.md", true), view = render(source.pane(true));
  await screen.findByRole("heading", { name: "文件窗口" });
  const fileId = source.session.getSnapshot().file.id;
  view.rerender(source.pane(true, "en"));
  await screen.findByRole("heading", { name: "File windows" });
  view.rerender(source.pane(true));
  await screen.findByRole("heading", { name: "文件窗口" });
  expect(source.session.getSnapshot().file.id).toBe(fileId);
  expect(source.query).not.toHaveBeenCalled();
  view.unmount(); source.session.dispose();
});

it("opens a Markdown fragment in preview and keeps the reading position through language changes", async () => {
  const source = setup("README.md"), file = source.session.getSnapshot().file;
  source.descriptor.fragment = "installation-1";
  source.descriptor.mode = "source";
  source.query.mockImplementation(async name => name === "workspace.file.readText"
    ? { file, text: "# Guide\n\n## Installation\n\nFirst section.\n\n## Installation\n\nSecond section.\n", encoding: "utf8", bom: false, lineEnding: "lf" }
    : name === "git.repository.summary" ? { isRepository: false } : file);
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView"), scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const view = render(source.pane(true));
  try {
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    const sections = screen.getAllByRole("heading", { name: "Installation" });
    expect(scroll.mock.contexts[0]).toBe(sections[1]);
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    view.rerender(source.pane(true, "en"));
    expect(scroll).toHaveBeenCalledTimes(1);
    view.rerender(source.pane(true, "zh"));
    expect(scroll).toHaveBeenCalledTimes(1);
    source.descriptor.jump = 1;
    view.rerender(source.pane(true));
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
  } finally {
    view.unmount(); source.session.dispose();
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
});

it("releases hidden PDF views, stops their reads, and reopens them on reveal", async () => {
  const source = setup(), view = render(source.pane(true));
  await waitFor(() => expect(screen.getByTestId("pdf-view")).toBeTruthy());
  view.rerender(source.pane(false));
  expect(source.release).toHaveBeenCalledWith("lease"); expect(viewer.stop).toHaveBeenCalledTimes(1);
  expect(source.setVisible).toHaveBeenLastCalledWith("file-view:pdf", false);
  const reads = source.query.mock.calls.length;
  vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(8000); }); vi.useRealTimers();
  expect(source.query).toHaveBeenCalledTimes(reads); expect(source.open).toHaveBeenCalledTimes(1);
  view.rerender(source.pane(true));
  await waitFor(() => expect(source.open).toHaveBeenCalledTimes(2));
  view.unmount(); source.session.dispose();
});

it("retains the playback position when hiding a playing media preview", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const source = setup("clip.webm"), view = render(source.pane(true));
  await waitFor(() => expect(view.container.querySelector("video")).toBeTruthy());
  view.container.querySelector("video")!.currentTime = 12.5;
  view.rerender(source.pane(false));
  expect(source.onViewState).toHaveBeenCalledWith({ time: 12.5 }); expect(source.release).toHaveBeenCalledWith("lease");
  view.unmount(); source.session.dispose();
});

it("pauses background polling when the native document is minimized without destroying an open PDF lease", async () => {
  const source = setup(), view = render(source.pane(true));
  await waitFor(() => expect(screen.getByTestId("pdf-view")).toBeTruthy());
  act(source.hideDocument);
  expect(source.setVisible).toHaveBeenLastCalledWith("file-view:pdf", false);
  expect(source.release).not.toHaveBeenCalled();
  expect(viewer.stop).not.toHaveBeenCalled();
  view.rerender(source.pane(false));
  expect(source.release).toHaveBeenCalledWith("lease");
  expect(viewer.stop).toHaveBeenCalledTimes(1);
  view.unmount(); source.session.dispose();
});

it("reads a file gutter diff using the repository path for a subdirectory workspace", async () => {
  const source = setup("notes.txt"), file = source.session.getSnapshot().file;
  source.query.mockImplementation(async (name, input) => {
    if (name === "workspace.file.inspect") return file;
    if (name === "workspace.file.readText") return { file, text: "source\n", encoding: "utf8", bom: false, lineEnding: "lf" };
    if (name === "git.repository.summary") return { workspaceId: "workspace", isRepository: true, workspacePrefix: "src", changedFiles: 1 };
    if (name === "git.diff.get") {
      const path = (input as { path: string }).path;
      return { path, binary: false, patch: path === "src/notes.txt" ? "@@ -1 +1,2 @@\n source\n+added\n" : "" };
    }
    throw new Error(`Unexpected query ${name}`);
  });
  const view = render(source.pane(true));
  await waitFor(() => expect(source.query).toHaveBeenCalledWith("git.diff.get", { workspaceId: "workspace", path: "src/notes.txt", target: "working" }));
  await waitFor(() => expect(screen.getByTestId("text-view").getAttribute("data-git-additions")).toBe("1"));
  view.unmount(); source.session.dispose();
});
