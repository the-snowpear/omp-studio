import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewSurface } from "../preview/PreviewContext";
import { registerFileBrowser } from "../fileBrowser/fileBrowserLinks";
import { FileImageContext, FileLink, LocalFileImage, registerFileOpener } from "./fileLinks";
import { registerPathResolver } from "./pathResolution";

vi.mock("../conversationWorkspace/Context", () => ({ useConversationView: () => ({ document: { ref: { targetId: "current-ssh", workspaceId: "current-workspace" } } }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("decodes local Markdown image paths and retains an explicit local source in a remote chat", async () => {
  const open = vi.fn(async () => ({ id: "image", url: "omp-file://viewer/image" })), release = vi.fn(async () => {});
  vi.stubGlobal("ompStudioChrome", { files: { open, release } });
  const view = render(<FileImageContext.Provider value={{ targetId: null, workspaceId: "local-workspace", basePath: "docs/guide.md", preview: false }}><LocalFileImage src="images/chart%20one.svg" alt="chart" /></FileImageContext.Provider>);
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
  expect(open).toHaveBeenCalledWith({ path: "src/Main.kt" });
  stop(); stopOpener(); stopBrowser();
});

it("sends absolute transcript links to the system files instead of the workspace", async () => {
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
  expect(reveal).not.toHaveBeenCalled();
  expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/Users/demo/notes", source: "system" }));
  stop(); stopOpener(); stopBrowser();
});
