import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient, WorkspaceFileInfo } from "@omp-studio/client-contract";
import { FileDocument } from "./fileDocuments";
import { FileCloseDialog, requestFileClose } from "./FileCloseDialog";

afterEach(() => { const cancel = screen.queryByRole("button", { name: "取消" }); if (cancel) fireEvent.click(cancel); cleanup(); vi.restoreAllMocks(); });

it("keeps a newly requested dirty file open while another file finishes saving", async () => {
  const file = (path: string): WorkspaceFileInfo => ({ workspaceId: "workspace" as WorkspaceFileInfo["workspaceId"], id: path, path, name: path, mime: "text/plain", size: 4, version: "v1", writable: true });
  const client = async () => ({} as StudioClient);
  const first = new FileDocument(file("first.txt"), client, true), second = new FileDocument(file("second.txt"), client, true);
  await first.load(); await second.load(); first.edit("first draft"); second.edit("second draft");
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }), save = first.save.bind(first);
  vi.spyOn(first, "save").mockImplementation(async () => { await gate; return save(); });
  const firstClose = requestFileClose([first]);
  render(<FileCloseDialog />);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  let secondResolved = false;
  let secondClose!: Promise<boolean>;
  act(() => { secondClose = requestFileClose([second]); void secondClose.then(() => { secondResolved = true; }); });
  await act(async () => { finish(); await firstClose; });
  expect(await firstClose).toBe(true); expect(secondResolved).toBe(false);
  expect(screen.queryByText("first.txt")).toBeNull(); expect(screen.getByText("second.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(await secondClose).toBe(false); expect(second.getSnapshot().dirty).toBe(true);
  first.dispose(); second.dispose();
});
