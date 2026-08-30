import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudioClient, WorkspaceFileTreeReadModel, WorkspaceId } from "@omp-studio/client-contract";

import { buildGitStatusLookup } from "./git/treeStatus";
import { I18nProvider } from "./i18n";
import { __resetExpandMemoryForTests, readExplorerExpansion, writeExplorerExpansion } from "./sidebar/expandMemory";

vi.mock("@xterm/xterm", () => ({ Terminal: class Terminal {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon {} }));

import { RealFileTree } from "./App.js";

function render(ui: React.ReactElement) {
  return rtlRender(<I18nProvider forcedLanguage="zh">{ui}</I18nProvider>);
}

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

afterEach(() => {
  cleanup();
  // 展开记忆落在 localStorage，用例间复位避免互相泄漏。
  __resetExpandMemoryForTests();
});

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

  it("decorates changed files and their ancestor folders with git status badges", async () => {
    const query = vi.fn(async () => tree([
      {
        type: "dir",
        name: "src",
        path: "src",
        children: [
          { type: "file", name: "main.ts", path: "src/main.ts" },
          { type: "file", name: "notes.md", path: "src/notes.md" },
        ],
      },
      { type: "file", name: "README.md", path: "README.md" },
    ]));
    const client = { query } as unknown as StudioClient;
    const gitStatus = buildGitStatusLookup([
      { path: "src/main.ts", index: "unmodified", worktree: "modified", conflicted: false },
      { path: "src/notes.md", index: "unmodified", worktree: "untracked", conflicted: false },
    ]);

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" gitStatus={gitStatus} {...noCreation} />);

    const fileRow = await waitFor(() => {
      const row = screen.getByText("main.ts").closest<HTMLDivElement>("[role=treeitem]");
      expect(row).not.toBeNull();
      return row!;
    });
    expect(fileRow.querySelector(".fstat.m")).not.toBeNull();
    expect(screen.getAllByText("已修改").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("未跟踪").closest(".fstat.u")).not.toBeNull();
    const dirRow = screen.getByRole("treeitem", { name: "src 文件夹" });
    expect(dirRow.querySelector(".fstat.m")).not.toBeNull();
    const untouched = screen.getByText("README.md").closest("[role=treeitem]");
    expect(untouched!.querySelector(".fstat")).toBeNull();
  });

  it("renders no git badges when status lookup is empty or absent", async () => {
    const query = vi.fn(async () => tree([
      { type: "dir", name: "src", path: "src", children: [{ type: "file", name: "main.ts", path: "src/main.ts" }] },
    ]));
    const client = { query } as unknown as StudioClient;

    const { unmount } = render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" gitStatus={new Map()} {...noCreation} />);
    await screen.findByRole("treeitem", { name: "src 文件夹" });
    expect(document.querySelector(".fstat")).toBeNull();
    unmount();

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} />);
    await screen.findByRole("treeitem", { name: "src 文件夹" });
    expect(document.querySelector(".fstat")).toBeNull();
  });

  it("shows a red live dot on a file the agent is reading", async () => {
    const query = vi.fn(async () => tree([
      { type: "dir", name: "src", path: "src", children: [{ type: "file", name: "main.ts", path: "src/main.ts" }] },
      { type: "file", name: "README.md", path: "README.md" },
    ]));
    const client = { query } as unknown as StudioClient;

    render(
      <RealFileTree
        client={client}
        workspaceId={workspaceId}
        label="OMP Studio"
        refreshToken={0}
        search=""
        fileActivity={{ reading: ["src/main.ts"], writing: [] }}
        {...noCreation}
      />,
    );

    const fileRow = await waitFor(() => {
      const row = screen.getByText("main.ts").closest<HTMLDivElement>("[role=treeitem]");
      expect(row).not.toBeNull();
      return row!;
    });
    expect(fileRow.querySelector(".dot.red.pulse")).not.toBeNull();
    expect(fileRow.querySelector('[aria-label="读取中"]')).not.toBeNull();
    expect(fileRow.querySelector(".dot.green")).toBeNull();
    const dirRow = screen.getByRole("treeitem", { name: "src 文件夹" });
    expect(dirRow.querySelector(".dot.red.pulse")).not.toBeNull();
    const untouched = screen.getByText("README.md").closest("[role=treeitem]");
    expect(untouched!.querySelector(".live")).toBeNull();
  });

  it("shows a green live dot on a file the agent is writing", async () => {
    const query = vi.fn(async () => tree([
      { type: "file", name: "README.md", path: "README.md" },
      { type: "file", name: "notes.md", path: "notes.md" },
    ]));
    const client = { query } as unknown as StudioClient;

    render(
      <RealFileTree
        client={client}
        workspaceId={workspaceId}
        label="OMP Studio"
        refreshToken={0}
        search=""
        fileActivity={{ reading: [], writing: ["README.md"] }}
        {...noCreation}
      />,
    );

    const fileRow = await waitFor(() => {
      const row = screen.getByText("README.md").closest<HTMLDivElement>("[role=treeitem]");
      expect(row).not.toBeNull();
      return row!;
    });
    expect(fileRow.querySelector(".dot.green.pulse")).not.toBeNull();
    expect(fileRow.querySelector('[aria-label="写入中"]')).not.toBeNull();
    const other = screen.getByText("notes.md").closest("[role=treeitem]");
    expect(other!.querySelector(".live")).toBeNull();
  });

  it("hides live dots when file activity is empty", async () => {
    const query = vi.fn(async () => tree([{ type: "file", name: "README.md", path: "README.md" }]));
    const client = { query } as unknown as StudioClient;

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} />);
    await screen.findByText("README.md");
    expect(document.querySelector(".tree-row .live")).toBeNull();
  });

  it("does not render open file message banner when clicking a file", async () => {
    const query = vi.fn(async () => tree([{ type: "file", name: "package.json", path: "package.json" }]));
    const client = { query } as unknown as StudioClient;

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} />);
    const fileRow = await screen.findByText("package.json");
    fireEvent.click(fileRow);

    expect(screen.queryByText(/打开 package\.json/)).toBeNull();
  });

  it("restores remembered folder expansion on mount without user interaction", async () => {
    writeExplorerExpansion(String(workspaceId), new Set(["src"]));
    const query = vi.fn(async (_name: string, input: { path?: string }) => input.path === "src"
      ? tree([{ type: "file", name: "main.ts", path: "src/main.ts" }])
      : tree([{ type: "dir", name: "src", path: "src" }]));
    const client = { query } as unknown as StudioClient;

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} />);

    const src = await screen.findByRole("treeitem", { name: "src 文件夹" });
    await waitFor(() => expect(src.getAttribute("aria-expanded")).toBe("true"));
    expect(query).toHaveBeenCalledWith("workspace.fileTree", { workspaceId, path: "src" });
    await screen.findByText("main.ts");
  });

  it("restores nested remembered paths level by level as children load", async () => {
    writeExplorerExpansion(String(workspaceId), new Set(["src", "src/conversation"]));
    const query = vi.fn(async (_name: string, input: { path?: string }) => {
      if (input.path === "src") return tree([{ type: "dir", name: "conversation", path: "src/conversation" }]);
      if (input.path === "src/conversation") return tree([{ type: "file", name: "App.tsx", path: "src/conversation/App.tsx" }]);
      return tree([{ type: "dir", name: "src", path: "src" }]);
    });
    const client = { query } as unknown as StudioClient;

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} />);

    await screen.findByText("App.tsx");
    expect(screen.getByRole("treeitem", { name: "conversation 文件夹" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("persists manual toggles and restores them after a file-tree refresh", async () => {
    const query = vi.fn(async (_name: string, input: { path?: string }) => input.path === "src"
      ? tree([{ type: "file", name: "main.ts", path: "src/main.ts" }])
      : tree([{ type: "dir", name: "src", path: "src" }]));
    const client = { query } as unknown as StudioClient;

    const { rerender } = render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} />);
    const src = await screen.findByRole("treeitem", { name: "src 文件夹" });
    fireEvent.click(src);
    await waitFor(() => expect(src.getAttribute("aria-expanded")).toBe("true"));
    expect(readExplorerExpansion(String(workspaceId)).has("src")).toBe(true);

    rerender(
      <I18nProvider forcedLanguage="zh">
        <RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={1} search="" {...noCreation} />
      </I18nProvider>,
    );
    const srcAfterRefresh = await screen.findByRole("treeitem", { name: "src 文件夹" });
    await waitFor(() => expect(srcAfterRefresh.getAttribute("aria-expanded")).toBe("true"));
    await screen.findByText("main.ts");
  });

  it("drops a folder from remembered expansion when the user collapses it", async () => {
    writeExplorerExpansion(String(workspaceId), new Set(["src"]));
    const query = vi.fn(async (_name: string, input: { path?: string }) => input.path === "src"
      ? tree([{ type: "file", name: "main.ts", path: "src/main.ts" }])
      : tree([
          { type: "dir", name: "src", path: "src", children: [{ type: "file", name: "main.ts", path: "src/main.ts" }] },
          { type: "file", name: "README.md", path: "README.md" },
        ]));
    const client = { query } as unknown as StudioClient;

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} />);
    const src = await screen.findByRole("treeitem", { name: "src 文件夹" });
    await waitFor(() => expect(src.getAttribute("aria-expanded")).toBe("true"));
    fireEvent.click(src);
    await waitFor(() => expect(src.getAttribute("aria-expanded")).toBe("false"));
    expect(readExplorerExpansion(String(workspaceId)).has("src")).toBe(false);
  });

  it("provides 添加上下文 tooltip and aria-label on @ buttons", async () => {
    const query = vi.fn(async () => tree([
      { type: "dir", name: "src", path: "src" },
      { type: "file", name: "package.json", path: "package.json" },
    ]));
    const client = { query } as unknown as StudioClient;
    const addContext = vi.fn();

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} onAddContext={addContext} />);
    await screen.findByText("package.json");

    const atButtons = screen.getAllByRole("button", { name: /添加上下文/ });
    expect(atButtons.length).toBe(2);
    expect(atButtons[0]?.getAttribute("data-tip")).toBe("添加上下文");
    expect(atButtons[1]?.getAttribute("data-tip")).toBe("添加上下文");

    fireEvent.click(atButtons[1]!);
    expect(addContext).toHaveBeenCalledWith("package.json", "file");
  });

  it("opens the file ⋯ menu with the standard items and dispatches actions", async () => {
    const query = vi.fn(async () => tree([
      { type: "dir", name: "src", path: "src" },
      { type: "file", name: "package.json", path: "package.json" },
    ]));
    const client = { query } as unknown as StudioClient;
    const fileAction = vi.fn();

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} onFileAction={fileAction} />);
    await screen.findByText("package.json");

    const moreButtons = screen.getAllByRole("button", { name: /更多操作/ });
    expect(moreButtons.length).toBe(2);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(moreButtons[1]!);
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("explorer-file-popover");
    for (const label of ["打开", "打开方式", "在资源管理器中打开", "复制绝对路径", "复制相对路径", "添加上下文"]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("menuitem", { name: "复制相对路径" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(fileAction).toHaveBeenCalledWith({ type: "copyRelative" }, { path: "package.json", name: "package.json", kind: "file" });
  });

  it("maps the dir ⋯ menu 打开 to tree expand/collapse and 添加上下文 to the context chain", async () => {
    const query = vi.fn(async (_name: string, input: { path?: string }) => input.path === "src"
      ? tree([{ type: "file", name: "main.ts", path: "src/main.ts" }])
      : tree([{ type: "dir", name: "src", path: "src" }]));
    const client = { query } as unknown as StudioClient;
    const fileAction = vi.fn();
    const addContext = vi.fn();

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} onFileAction={fileAction} onAddContext={addContext} />);
    const src = await screen.findByRole("treeitem", { name: "src 文件夹" });
    expect(src.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: /更多操作 src/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "打开" }));
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(fileAction).not.toHaveBeenCalled();

    fireEvent.contextMenu(src, { clientX: 120, clientY: 40 });
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "添加上下文" }));
    expect(addContext).toHaveBeenCalledWith("src", "dir");
  });

  it("disables desktop-dependent ⋯ items with a reason when the handler is unavailable", async () => {
    const query = vi.fn(async () => tree([{ type: "file", name: "package.json", path: "package.json" }]));
    const client = { query } as unknown as StudioClient;

    render(<RealFileTree client={client} workspaceId={workspaceId} label="OMP Studio" refreshToken={0} search="" {...noCreation} />);
    await screen.findByText("package.json");

    fireEvent.click(screen.getByRole("button", { name: /更多操作/ }));
    expect((screen.getByRole("menuitem", { name: "打开" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "在资源管理器中打开" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "复制绝对路径" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "打开方式" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "复制相对路径" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("menuitem", { name: "添加上下文" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
