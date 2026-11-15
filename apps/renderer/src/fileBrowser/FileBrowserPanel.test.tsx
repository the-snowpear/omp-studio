import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, PreviewSurface } from "../preview/PreviewContext";
import { createPreviewFileBrowserSource } from "../preview/fileBrowserPreview";
import { DockProvider } from "../dock/DockContext";
import { DockFloatingLayer } from "../dock/DockRegions";
import { DockStore } from "../dock/store";
import { WORKBENCH_PANELS } from "../panels/registry";
import { ExecutionTargets } from "../workspaces/ExecutionTargets";
import { FileBrowserPanel, type FileBrowserPanelProps } from "./FileBrowserPanel";
import { FileBrowserDock } from "./FileBrowserDock";
import { createHostFileBrowserSource, systemFileReference } from "./fileBrowserSource";

let width = 720;
const observers = new Set<() => void>();
beforeEach(() => {
  localStorage.clear(); width = 720;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("fb") ? width : 720; });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) { observers.add(callback); }
    observe() {} unobserve() {} disconnect() { observers.delete(this.callback); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); observers.clear(); window.history.replaceState(null, "", "/"); });
const resize = (next: number) => act(() => { width = next; for (const observer of observers) observer(); });
function mount(extra: Partial<FileBrowserPanelProps> = {}, preview = true) {
  const source = extra.source ?? createPreviewFileBrowserSource("win32");
  return render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider><PreviewSurface preview={preview}><FileBrowserPanel panelId="panel" scope="test" source={source} {...extra} /></PreviewSurface></PreviewModeProvider></I18nProvider>);
}
const row = (name: string) => screen.getByText(name, { selector: ".fb-name .ellipsis" }).closest<HTMLElement>("[data-path]")!;

describe("file browser", () => {
  it.each([[380, "tree"], [720, "list"], [1120, "columns"]] as const)("chooses the default view at %i px", async (size, expected) => {
    width = size; mount();
    await waitFor(() => expect(screen.getByRole("region", { name: "文件浏览器" }).querySelector(".fb-skeleton-page")).toBeNull());
    expect(screen.getByRole("region", { name: "文件浏览器" }).dataset.view).toBe(expected);
  });
  it("restores the explicit view after a temporary narrow-window downgrade", async () => {
    width = 1120; mount();
    const panel = screen.getByRole("region", { name: "文件浏览器" });
    await waitFor(() => expect((screen.getByRole("radio", { name: "分栏视图" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("radio", { name: "列表视图" }));
    fireEvent.click(screen.getByRole("radio", { name: "分栏视图" }));
    resize(720); expect(panel.dataset.view).toBe("list");
    resize(380); expect(panel.dataset.view).toBe("tree");
    resize(1120); expect(panel.dataset.view).toBe("columns");
    expect(JSON.parse(localStorage.getItem("omp.fileBrowser.v1")!)["test:panel"].view).toBe("columns");
  });
  it("enters a folder and navigates up, back and forward", async () => {
    mount(); await screen.findByText("Desktop", { selector: ".fb-name .ellipsis" });
    fireEvent.doubleClick(row("Desktop"));
    await screen.findByText("待办.txt", { selector: ".fb-name .ellipsis" });
    fireEvent.click(screen.getByRole("button", { name: /^上一级/ }));
    await screen.findByText("Desktop", { selector: ".fb-name .ellipsis" });
    fireEvent.click(screen.getByRole("button", { name: /^后退/ }));
    await screen.findByText("待办.txt", { selector: ".fb-name .ellipsis" });
    fireEvent.click(screen.getByRole("button", { name: /^前进/ }));
    await screen.findByText("Desktop", { selector: ".fb-name .ellipsis" });
  });
  it("keeps a column folder selected for F2 and allows keyboard navigation into its children", async () => {
    width = 1120; mount();
    await screen.findByText("Desktop", { selector: ".fb-name .ellipsis" });
    fireEvent.click(row("Desktop"));
    await screen.findByText("待办.txt", { selector: ".fb-name .ellipsis" });
    expect(row("Desktop").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(row("Desktop"), { key: "F2" });
    const name = screen.getByRole("textbox", { name: "新名称" });
    expect((name as HTMLInputElement).value).toBe("Desktop");
    fireEvent.keyDown(name, { key: "Escape" });
    fireEvent.keyDown(row("Desktop"), { key: "ArrowDown" });
    expect(row("待办.txt").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(row("待办.txt"), { key: "ArrowLeft" });
    await waitFor(() => expect(document.querySelector(".fb-crumb.is-current")?.textContent).toBe("demo"));
    fireEvent.keyDown(row("Desktop"), { key: "ArrowRight" });
    await screen.findByText("待办.txt", { selector: ".fb-name .ellipsis" });
  });
  it.each([{ preview: true, marks: true, size: 720 }, { preview: true, marks: false, size: 720 }, { preview: false, marks: false, size: 720 }, { preview: true, marks: false, size: 1120 }])("creates, renames and confirms recycling at $size px with preview=$preview and marks=$marks", async ({ preview, marks, size }) => {
    width = size;
    window.history.replaceState(null, "", marks ? "/" : "/?marks=off");
    const source = createPreviewFileBrowserSource("win32"), trash = vi.spyOn(source, "trashItems");
    mount({ source }, preview); await screen.findByText("Desktop", { selector: ".fb-name .ellipsis" });
    const panel = screen.getByRole("region", { name: "文件浏览器" });
    fireEvent.keyDown(panel, { key: "N", ctrlKey: true, shiftKey: true });
    const name = await screen.findByRole("textbox", { name: "新文件夹名称" });
    fireEvent.change(name, { target: { value: "Created folder" } }); fireEvent.keyDown(name, { key: "Enter" });
    await screen.findByText("Created folder", { selector: ".fb-name .ellipsis" });
    expect(!!panel.querySelector(".fb-notice")).toBe(!preview || marks);
    fireEvent.click(row("Created folder")); fireEvent.keyDown(panel, { key: "F2" });
    const rename = screen.getByRole("textbox", { name: "新名称" });
    fireEvent.change(rename, { target: { value: "Renamed folder" } }); fireEvent.keyDown(rename, { key: "Enter" });
    await screen.findByText("Renamed folder", { selector: ".fb-name .ellipsis" });
    expect(!!panel.querySelector(".fb-notice")).toBe(!preview || marks);
    fireEvent.click(row("Renamed folder")); fireEvent.keyDown(panel, { key: "Delete" });
    let dialog = screen.getByRole("alertdialog"); expect(trash).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); expect(trash).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: "Delete" }); dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "移到回收站" }));
    await waitFor(() => expect(trash).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("Renamed folder", { selector: ".fb-name .ellipsis" })).toBeNull());
    expect(!!panel.querySelector(".fb-notice")).toBe(!preview || marks);
  });
  it("opens external files with system identity and project files with workspace identity", async () => {
    const query = vi.fn(async (name: string, input: { path?: string }) => {
      if (name === "fs.places") return { platform: "linux", separator: "/", home: "/home/demo", quick: [], volumes: [{ path: "/", label: "/", ready: true }], trash: false };
      if (name === "projects.list") return { workspaces: [{ workspaceId: "project", name: "Project", root: "/work" }] };
      const path = input.path ?? "/home/demo";
      return { path, parent: "/", segments: [], truncated: false, entries: [{ name: "notes.txt", path: `${path}/notes.txt`, type: "file", size: 5, hidden: false }], ...(path === "/work" ? { workspace: { workspaceId: "project", relativePath: "" } } : {}) };
    });
    const source = createHostFileBrowserSource({ client: async () => ({ query }) as unknown as StudioClient, targetId: null, label: "Local", language: "en" });
    const open = vi.fn();
    mount({ source, onOpenFile: entry => open(systemFileReference(entry)) }, false);
    await screen.findByText("notes.txt", { selector: ".fb-name .ellipsis" }); fireEvent.doubleClick(row("notes.txt"));
    expect(open).toHaveBeenLastCalledWith({ source: "system", path: "/home/demo/notes.txt" });
    fireEvent.click(screen.getByText("Project", { selector: ".fb-place-label .ellipsis" }));
    await waitFor(() => expect(row("notes.txt").dataset.path).toBe("/work/notes.txt")); fireEvent.doubleClick(row("notes.txt"));
    expect(open).toHaveBeenLastCalledWith({ workspaceId: "project", path: "notes.txt" });
  });
  it("disables local shell and recycling for remote files", async () => {
    const source = { ...createPreviewFileBrowserSource("win32"), local: false, trash: false, label: "SSH · dev" };
    const run = vi.fn(); mount({ source, onSystemAction: run }, false);
    await screen.findByText("Desktop", { selector: ".fb-name .ellipsis" }); fireEvent.doubleClick(row("Desktop"));
    await screen.findByText("待办.txt", { selector: ".fb-name .ellipsis" }); fireEvent.contextMenu(row("待办.txt"));
    expect((screen.getByRole("menuitem", { name: "用系统程序打开" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: /移到回收站/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it("keeps the real Host unused when the dock browser is in preview mode", async () => {
    const query = vi.fn(), command = vi.fn(), client = { query, command } as unknown as StudioClient;
    const store = new DockStore(null); store.switchScope({ target: "local", project: "test", session: "browser" }, true);
    // Dock needs a measured workbench; jsdom has no layout engine.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 800));
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
    render(<I18nProvider forcedLanguage="zh"><PreviewSurface preview><ExecutionTargets client={client}>{() => <DockProvider definitions={WORKBENCH_PANELS} store={store}><div data-dock-workbench><FileBrowserDock targetId={null} /><DockFloatingLayer /></div></DockProvider>}</ExecutionTargets></PreviewSurface></I18nProvider>);
    act(() => store.dispatch({ type: "open", panel: "file-browser" }));
    await screen.findByText("Desktop", { selector: ".fb-name .ellipsis" });
    expect(query).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
  });
  it("navigates directory aliases to their canonical location without expanding a cycle", async () => {
    width = 380;
    const source = createPreviewFileBrowserSource("win32"), original = source.list;
    const home = "C:\\Users\\demo", alias = `${home}\\loop`;
    const entries = [{ name: "loop", path: alias, type: "dir" as const, link: true }];
    source.list = async (path, hidden) => path === home || path === alias ? { path: home, entries } : original(path, hidden);
    mount({ source });
    const node = await screen.findByText("loop", { selector: ".fname" });
    fireEvent.click(node);
    await waitFor(() => expect(document.querySelector(".fb-crumb.is-current")?.textContent).toBe("demo"));
    fireEvent.click(screen.getByText("loop", { selector: ".fname" }));
    await waitFor(() => expect(screen.getAllByText("loop", { selector: ".fname" })).toHaveLength(1));
  });
});
