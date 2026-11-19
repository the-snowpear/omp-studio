import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspacePathResolution } from "@omp-studio/client-contract";
import { PreviewSurface } from "../preview/PreviewContext";
import { registerFileBrowser } from "../fileBrowser/fileBrowserLinks";
import { FileDocumentContext, FileLink, LocalFileImage, registerFileOpener } from "./fileLinks";
import { registerPathResolver } from "./pathResolution";

vi.mock("../conversationWorkspace/Context", () => ({ useConversationView: () => ({ document: { ref: { targetId: "current-ssh", workspaceId: "current-workspace" } } }) }));
const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const files = (paths: readonly string[]) => paths.map(path => ({ path, kind: "file" as const }));

it("decodes local Markdown image paths and retains an explicit local source in a remote chat", async () => {
  const open = vi.fn(async () => ({ id: "image", url: "omp-file://viewer/image" })), release = vi.fn(async () => {});
  vi.stubGlobal("ompStudioChrome", { files: { open, release } });
  const view = render(<FileDocumentContext.Provider value={{ targetId: null, workspaceId: "local-workspace", basePath: "docs/guide.md", preview: false }}><LocalFileImage src="images/chart%20one.svg" alt="chart" /></FileDocumentContext.Provider>);
  await waitFor(() => expect(screen.getByAltText("chart")).toBeTruthy());
  expect(open).toHaveBeenCalledWith({ targetId: null, workspaceId: "local-workspace", path: "docs/images/chart one.svg" });
  view.unmount(); expect(release).toHaveBeenCalledWith("image");
});

it("switches conversation images to fixtures in preview mode and releases the real file", async () => {
  const open = vi.fn(async () => ({ id: "real-image", url: "omp-file://viewer/real-image" })), release = vi.fn(async () => {}), revoke = vi.fn();
  vi.stubGlobal("ompStudioChrome", { files: { open, release } });
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:demo-image"); static revokeObjectURL = revoke; });
  const image = (preview: boolean) => <PreviewSurface preview={preview}><LocalFileImage src="image.svg" alt="chart" /></PreviewSurface>;
  const view = render(image(false));
  await waitFor(() => expect(screen.getByAltText("chart").getAttribute("src")).toBe("omp-file://viewer/real-image"));
  view.rerender(image(true));
  await waitFor(() => expect(screen.getByAltText("chart").getAttribute("src")).toBe("blob:demo-image"));
  expect(release).toHaveBeenCalledWith("real-image"); expect(open).toHaveBeenCalledTimes(1);
  view.unmount(); expect(revoke).toHaveBeenCalledWith("blob:demo-image");
});

it("drops the link once the workspace reports the path is gone", async () => {
  const stop = registerPathResolver("standalone", async paths => paths.map(path => ({ path, kind: "missing" as const })));
  const view = render(<FileLink href="src/Gone.tsx" inline>src/Gone.tsx</FileLink>);
  expect(view.container.querySelector("a.file-reference")).not.toBeNull();
  await waitFor(() => expect(view.container.querySelector("a.file-reference")).toBeNull());
  expect(view.container.textContent).toBe("src/Gone.tsx");
  stop();
});

it("waits for the workspace before linking text that only looks like a path", async () => {
  const stop = registerPathResolver("standalone", async paths => paths.map(path => ({ path, kind: path === "app/src/main/java" ? "file" as const : "missing" as const })));
  const cipher = render(<FileLink href="RSA/ECB/PKCS1Padding" inline>RSA/ECB/PKCS1Padding</FileLink>);
  const directory = render(<FileLink href="app/src/main/java" inline>app/src/main/java</FileLink>);
  expect(cipher.container.querySelector("a.file-reference")).toBeNull();
  expect(directory.container.querySelector("a.file-reference")).toBeNull();
  await waitFor(() => expect(directory.container.querySelector("a.file-reference")).not.toBeNull());
  expect(cipher.container.querySelector("a.file-reference")).toBeNull();
  stop();
});

it("reveals a workspace directory in Explorer and opens a classified file", async () => {
  const reveal = vi.fn(), open = vi.fn();
  const stopBrowser = registerFileBrowser("standalone", reveal);
  const stopOpener = registerFileOpener("standalone", open);
  const stop = registerPathResolver("standalone", async paths => paths.map(path => ({ path, kind: path === "docs/sql" ? "directory" as const : "file" as const })));
  const folder = render(<FileLink href="docs/sql" inline>docs/sql</FileLink>);
  const file = render(<FileLink href="src/Main.kt" inline>src/Main.kt</FileLink>);
  await waitFor(() => expect(folder.container.querySelector("a.file-reference")).not.toBeNull());
  fireEvent.click(folder.container.querySelector("a.file-reference")!);
  expect(reveal).toHaveBeenCalledWith({ path: "docs/sql", workspaceId: "current-workspace", targetId: "current-ssh" });
  expect(open).not.toHaveBeenCalled();
  await waitFor(() => expect(file.container.querySelector("a.file-reference")).not.toBeNull());
  fireEvent.click(file.container.querySelector("a.file-reference")!);
  expect(open).toHaveBeenCalledWith({ path: "src/Main.kt", workspaceId: "current-workspace", targetId: "current-ssh" });
  stop(); stopOpener(); stopBrowser();
});

it("opens absolute files on the chat's Host and redirects absolute directories to the browser", async () => {
  const reveal = vi.fn(), open = vi.fn();
  const stopBrowser = registerFileBrowser("standalone", reveal);
  const stopOpener = registerFileOpener("standalone", open);
  const stop = registerPathResolver("standalone", async paths => paths.map(path => ({ path, kind: path.endsWith(".pdf") ? "file" as const : "directory" as const })));
  const file = render(<FileLink href="/Users/demo/report.pdf" inline>/Users/demo/report.pdf</FileLink>);
  const folder = render(<FileLink href="/Users/demo/notes" inline>/Users/demo/notes</FileLink>);
  await waitFor(() => expect(file.container.querySelector("a.file-reference")).not.toBeNull());
  await waitFor(() => expect(folder.container.querySelector("a.file-reference.is-directory")).not.toBeNull());
  fireEvent.click(file.container.querySelector("a.file-reference")!);
  expect(open).toHaveBeenCalledWith({ path: "/Users/demo/report.pdf", workspaceId: "", targetId: "current-ssh", source: "system" });
  fireEvent.click(folder.container.querySelector("a.file-reference")!);
  expect(reveal).toHaveBeenCalledWith({ path: "/Users/demo/notes", targetId: "current-ssh" });
  expect(open).toHaveBeenCalledTimes(1);
  stop(); stopOpener(); stopBrowser();
});

it("finishes later batches and retries a failed batch once", async () => {
  vi.useFakeTimers();
  const paths = Array.from({ length: 70 }, (_, index) => "src/entry-" + index + ".kt");
  const resolve = vi.fn(async (batch: readonly string[]) => files(batch))
    .mockRejectedValueOnce(new Error("Host disconnected"));
  stops.push(registerPathResolver("standalone", resolve));
  render(<>{paths.map(path => <FileLink key={path} inline href={path}>{path}</FileLink>)}</>);

  await advance(120);
  expect(resolve.mock.calls.map(([batch]) => batch.length)).toEqual([64, 6]);
  expect(screen.getAllByRole("link")).toHaveLength(6);
  await advance(600);
  expect(screen.getAllByRole("link")).toHaveLength(70);
  expect(resolve.mock.calls[2]?.[0]).toEqual(paths.slice(0, 64));
});

it("retries only the omitted paths and leaves the queue idle after a second omission", async () => {
  vi.useFakeTimers();
  const resolve = vi.fn(async () => files([])).mockResolvedValueOnce(files(["src/first.kt"]));
  stops.push(registerPathResolver("standalone", resolve));
  const omitted = <FileLink inline href="src/later.kt">Omitted</FileLink>;
  const view = render(<><FileLink inline href="src/first.kt">First</FileLink>{omitted}</>);

  await advance(1200);
  expect(screen.getByRole("link", { name: "First" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Omitted" })).toBeNull();
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(resolve.mock.calls[1]).toEqual([["src/later.kt"], { workspaceId: "current-workspace", targetId: "current-ssh" }]);
  view.unmount();
  resolve.mockResolvedValueOnce(files(["src/later.kt"]));
  render(omitted);
  await advance(40);
  expect(screen.getByRole("link", { name: "Omitted" })).toBeTruthy();
});

it("drops the old in-flight result when a resolver unmounts and is replaced", async () => {
  vi.useFakeTimers();
  let finish!: (value: readonly WorkspacePathResolution[]) => void;
  const old = vi.fn(() => new Promise<readonly WorkspacePathResolution[]>(resolve => { finish = resolve; }));
  const off = registerPathResolver("standalone", old);
  const view = render(<FileLink inline href="src/delayed.kt">Delayed</FileLink>);
  await advance(40);
  expect(old).toHaveBeenCalledTimes(1);
  view.unmount();
  off();
  const resolve = vi.fn(async (paths: readonly string[]) => files(paths));
  stops.push(registerPathResolver("standalone", resolve));
  render(<FileLink inline href="src/delayed.kt">Delayed</FileLink>);
  await advance(40);
  await act(async () => finish([{ path: "src/delayed.kt", kind: "missing" }]));
  expect(screen.getByRole("link", { name: "Delayed" })).toBeTruthy();
  expect(resolve).toHaveBeenCalledTimes(1);
});

it("recovers from a missing file on the bounded retry or on a later remount", async () => {
  vi.useFakeTimers();
  const existing = new Set<string>();
  const resolve = vi.fn(async (paths: readonly string[]) => paths.map(path => ({ path, kind: existing.has(path) ? "file" as const : "missing" as const })));
  stops.push(registerPathResolver("standalone", resolve));
  const links = <><FileLink href="generated/soon.txt">Soon</FileLink><FileLink href="generated/later.txt">Later</FileLink></>;
  const view = render(links);
  await advance(40);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  existing.add("generated/soon.txt");
  await advance(1200);
  expect(screen.getByRole("link", { name: "Soon" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Later" })).toBeNull();
  expect(resolve).toHaveBeenCalledTimes(2);
  view.unmount();
  existing.add("generated/later.txt");
  render(links);
  await advance(40);
  expect(screen.getByRole("link", { name: "Later" })).toBeTruthy();
  expect(resolve.mock.calls[2]?.[0]).toEqual(["generated/later.txt"]);
});

it("classifies and opens markdown links relative to the file on its own Host", async () => {
  const open = vi.fn(), reveal = vi.fn();
  const resolve = vi.fn(async (paths: readonly string[]) => paths.map(path => ({
    path, kind: path === "docs/assets" ? "directory" as const : path === "docs/note.txt" || path.startsWith("~/") || path.startsWith("/D:/") ? "file" as const : "missing" as const,
  })));
  stops.push(registerFileOpener("standalone", open), registerFileBrowser("standalone", reveal), registerPathResolver("standalone", resolve));
  render(<FileDocumentContext.Provider value={{ basePath: "docs/guide.md", workspaceId: "other-workspace", targetId: "other-ssh", preview: false }}>
    <FileLink href="note.txt#L5C2">Note</FileLink>
    <FileLink href="./assets">Assets</FileLink>
    <FileLink href="~/home.txt">Home</FileLink>
    <FileLink href="/D:/logs/run.txt">Drive</FileLink>
  </FileDocumentContext.Provider>);
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
  expect(resolve.mock.calls).toEqual(expect.arrayContaining([
    [["docs/note.txt", "docs/assets"], { workspaceId: "other-workspace", targetId: "other-ssh" }],
    [["~/home.txt", "/D:/logs/run.txt"], { workspaceId: "", targetId: "other-ssh" }],
  ]));
  for (const label of ["Note", "Assets", "Home", "Drive"]) fireEvent.click(screen.getByRole("link", { name: label }));
  expect(open).toHaveBeenCalledWith({ path: "docs/note.txt", line: 5, column: 2, workspaceId: "other-workspace", targetId: "other-ssh" });
  expect(open).toHaveBeenCalledWith({ path: "~/home.txt", workspaceId: "", targetId: "other-ssh", source: "system" });
  expect(open).toHaveBeenCalledWith({ path: "/D:/logs/run.txt", workspaceId: "", targetId: "other-ssh", source: "system" });
  expect(reveal).toHaveBeenCalledWith({ path: "docs/assets", workspaceId: "other-workspace", targetId: "other-ssh" });
});

it("defers a network file URL or UNC directory to an explicit click", async () => {
  vi.useFakeTimers();
  const reveal = vi.fn(), open = vi.fn(), resource = vi.fn();
  const resolve = vi.fn(async (paths: readonly string[]) => paths.map(path => ({ path, kind: path.endsWith(".png") ? "file" as const : "directory" as const })));
  vi.stubGlobal("ompStudioChrome", { files: { open: resource } });
  stops.push(registerFileOpener("standalone", open), registerFileBrowser("standalone", reveal), registerPathResolver("standalone", resolve));
  render(<>
    <FileLink href="\\fixture.invalid\files\notes" inline>Notes</FileLink>
    <LocalFileImage src="file://fixture.invalid/files/figure.png" alt="Figure" />
  </>);

  await advance(1200);
  expect(resolve).not.toHaveBeenCalled();
  expect(resource).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("link", { name: "Notes" })));
  expect(resolve).toHaveBeenCalledWith(["\\\\fixture.invalid\\files\\notes"], { workspaceId: "", targetId: "current-ssh" }, true);
  expect(reveal).toHaveBeenCalledWith({ path: "\\\\fixture.invalid\\files\\notes", targetId: "current-ssh" });
  await act(async () => fireEvent.click(screen.getByRole("link", { name: "Figure" })));
  expect(open).toHaveBeenCalledWith({ path: "//fixture.invalid/files/figure.png", workspaceId: "", targetId: "current-ssh", source: "system" });
});
