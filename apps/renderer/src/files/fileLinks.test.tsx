import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewSurface } from "../preview/PreviewContext";
import { FileImageContext, LocalFileImage } from "./fileLinks";

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
