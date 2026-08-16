import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudioClient, WorkspaceFileTreeReadModel, WorkspaceId } from "@omp-studio/client-contract";

vi.mock("@xterm/xterm", () => ({ Terminal: class Terminal {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon {} }));

import { RealFileTree } from "./App.js";

const workspaceId = "workspace-test" as WorkspaceId;
const noCreation = {
  createKind: null,
  createParentPath: undefined,
  createName: "",
  createBusy: false,
  createError: undefined,
  createInputRef: { current: null },
  onCreateNameChange: () => {},
  onCreateSubmit: () => {},
  onCreateCancel: () => {},
};

afterEach(cleanup);

function tree(nodes: WorkspaceFileTreeReadModel["nodes"]): WorkspaceFileTreeReadModel {
  return { workspaceId, nodes };
}

describe("RealFileTree", () => {
  it("loads folders on demand and follows standard tree keyboard navigation", async () => {
    const query = vi.fn(async (_name: string, input: { path?: string }) => input.path === "src"
      ? tree([{ type: "file", name: "main.ts", path: "src/main.ts" }])
      : tree([
          { type: "dir", name: "src", path: "src" },
          { type: "file", name: "package.json", path: "package.json" },
        ]));
    const client = { query } as unknown as StudioClient;

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} />);

    const src = await screen.findByRole("treeitem", { name: "src 文件夹" });
    const packageRow = screen.getByText("package.json").closest<HTMLDivElement>("[role=treeitem]");
    expect(packageRow).not.toBeNull();
    expect(src.tabIndex).toBe(0);
    expect(packageRow!.tabIndex).toBe(-1);

    fireEvent.keyDown(src, { key: "ArrowRight" });
    await waitFor(() => expect(query).toHaveBeenCalledWith("workspace.fileTree", { workspaceId, path: "src" }));
    const mainRow = await waitFor(() => screen.getByText("main.ts").closest<HTMLDivElement>("[role=treeitem]"));
    expect(mainRow).not.toBeNull();
    expect(src.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(src, { key: "ArrowRight" });
    expect(document.activeElement).toBe(mainRow);
    expect(mainRow!.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(mainRow!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(packageRow);

    fireEvent.keyDown(packageRow!, { key: "Home" });
    expect(document.activeElement).toBe(src);

    fireEvent.keyDown(mainRow!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(src);
  });

  it("does not issue duplicate folder reads while a directory is loading", async () => {
    let release: ((value: WorkspaceFileTreeReadModel) => void) | undefined;
    const pending = new Promise<WorkspaceFileTreeReadModel>((resolve) => { release = resolve; });
    const query = vi.fn(async (_name: string, input: { path?: string }) => input.path === "src"
      ? pending
      : tree([{ type: "dir", name: "src", path: "src" }]));
    const client = { query } as unknown as StudioClient;

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} />);
    const src = await screen.findByRole("treeitem", { name: "src 文件夹" });

    fireEvent.click(src);
    fireEvent.click(src);
    fireEvent.click(src);
    await waitFor(() => expect(query.mock.calls.filter(([, input]) => input.path === "src")).toHaveLength(1));

    release?.(tree([]));
    await waitFor(() => expect(src.getAttribute("aria-busy")).toBeNull());
  });

  it("clears the active selection when clicking blank tree space", async () => {
    const query = vi.fn(async () => tree([
      { type: "dir", name: "src", path: "src" },
      { type: "file", name: "README.md", path: "README.md" },
    ]));
    const selected = vi.fn();
    const client = { query } as unknown as StudioClient;

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} onSelectionChange={selected} />);

    const src = await screen.findByRole("treeitem", { name: "src 文件夹" });
    fireEvent.click(src);
    expect(src.getAttribute("aria-selected")).toBe("true");
    expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ path: "src" }));

    fireEvent.click(screen.getByRole("tree"));
    expect(src.getAttribute("aria-selected")).toBe("false");
    expect(selected).toHaveBeenLastCalledWith(undefined);
  });

  it("places the creation editor after the last item in the selected directory", async () => {
    const query = vi.fn(async () => tree([
      {
        type: "dir",
        name: "src",
        path: "src",
        children: [{ type: "file", name: "main.ts", path: "src/main.ts" }],
      },
      { type: "file", name: "README.md", path: "README.md" },
    ]));
    const onSubmit = vi.fn();
    const inputRef = { current: null as HTMLInputElement | null };
    const client = { query } as unknown as StudioClient;

    render(
      <RealFileTree
        client={client}
        workspaceId={workspaceId}
        label="OMP Studio"
        refreshToken={0}
        search=""
        createKind="file"
        createParentPath="src"
        createName=""
        createBusy={false}
        createError={undefined}
        createInputRef={inputRef}
        onCreateNameChange={() => {}}
        onCreateSubmit={onSubmit}
        onCreateCancel={() => {}}
      />,
    );

    const input = await screen.findByRole("textbox", { name: "新建文件名" });
    const editor = input.closest("form");
    const firstChild = screen.getByText("main.ts").closest("[role=treeitem]");
    expect(editor).not.toBeNull();
    expect(firstChild).not.toBeNull();
    expect(Boolean(editor!.compareDocumentPosition(firstChild!) & Node.DOCUMENT_POSITION_PRECEDING)).toBe(true);
    fireEvent.change(input, { target: { value: "index.ts" } });
    fireEvent.submit(editor!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("loads an unopened selected directory before showing its creation editor", async () => {
    const query = vi.fn(async (_name: string, input: { path?: string }) => input.path === "src"
      ? tree([])
      : tree([{ type: "dir", name: "src", path: "src" }]));
    const inputRef = { current: null as HTMLInputElement | null };
    const client = { query } as unknown as StudioClient;

    render(
      <RealFileTree
        client={client}
        workspaceId={workspaceId}
        label="OMP Studio"
        refreshToken={0}
        search=""
        createKind="directory"
        createParentPath="src"
        createName=""
        createBusy={false}
        createError={undefined}
        createInputRef={inputRef}
        onCreateNameChange={() => {}}
        onCreateSubmit={() => {}}
        onCreateCancel={() => {}}
      />,
    );

    await screen.findByRole("textbox", { name: "新建文件夹名" });
    expect(query).toHaveBeenCalledWith("workspace.fileTree", { workspaceId, path: "src" });
  });
});
