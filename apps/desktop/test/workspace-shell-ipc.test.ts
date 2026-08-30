/**
 * Desktop-chrome workspace shell IPC tests.
 *
 * Headless: fake ipcMain + fake actions. No Electron, no editor process.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  WORKSPACE_SHELL_IPC_CHANNELS,
  parseFileOpenWithInput,
  parseResolveDroppedPathsInput,
  parseWorkspaceFileTargetInput,
  parseWorkspaceShellInput,
  WorkspaceShellIpcError,
  type WorkspaceFileActionResult,
  type WorkspaceFileTargetInput,
  type WorkspaceShellEditorResult,
} from "../src/workspace-shell-shared.js";
import {
  registerWorkspaceShellIpc,
  type WorkspaceShellIpcMain,
  type WorkspaceShellSender,
} from "../src/workspace-shell-ipc.js";

interface FakeSender extends WorkspaceShellSender {
  destroyed: boolean;
}

function makeSender(): FakeSender {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getURL() {
      return "http://127.0.0.1:5173/";
    },
  };
}

interface FakeIpc extends WorkspaceShellIpcMain {
  readonly handlers: Map<string, (event: { sender: WorkspaceShellSender }, payload?: unknown) => unknown>;
  readonly removed: string[];
}

function makeIpc(): FakeIpc {
  return {
    handlers: new Map(),
    removed: [],
    handle(channel, listener) {
      this.handlers.set(channel, listener);
    },
    removeHandler(channel) {
      this.removed.push(channel);
      this.handlers.delete(channel);
    },
  };
}

interface Actions {
  readonly resolveCalls: string[];
  readonly editorCalls: string[];
  readonly revealCalls: string[];
  readonly droppedCalls: Array<{ cwd: string; paths: readonly string[] }>;
  readonly fileCalls: Array<{ cwd: string; target: WorkspaceFileTargetInput; openerId?: string }>;
  readonly absolutePathCalls: Array<{ cwd: string; target: WorkspaceFileTargetInput }>;
  readonly openerListCalls: number[];
}

function register(actions: Partial<{
  resolveWorkspaceCwd(workspaceId: string): Promise<string>;
  openInExternalEditor(cwd: string): Promise<WorkspaceShellEditorResult>;
  revealInFileManager(cwd: string): Promise<void>;
  resolveDroppedPaths(cwd: string, paths: readonly string[]): Promise<Array<{ ok: true; kind: "file"; scope: "workspace"; path: string; name: string }>>;
  openFile(cwd: string, target: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult>;
  openFileWith(cwd: string, target: WorkspaceFileTargetInput, openerId: string): Promise<WorkspaceFileActionResult>;
  revealFileInFileManager(cwd: string, target: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult>;
  resolveFileAbsolutePath(cwd: string, target: WorkspaceFileTargetInput): Promise<string>;
  listFileOpeners(): Promise<ReadonlyArray<{ id: string; name: string }>>;
}> = {}) {
  const ipc = makeIpc();
  const calls: Actions = {
    resolveCalls: [],
    editorCalls: [],
    revealCalls: [],
    droppedCalls: [],
    fileCalls: [],
    absolutePathCalls: [],
    openerListCalls: [],
  };
  const handle = registerWorkspaceShellIpc({
    ipcMain: ipc,
    isTrustedSender: (sender) => !sender.isDestroyed(),
    actions: {
      resolveWorkspaceCwd: actions.resolveWorkspaceCwd ?? (async (workspaceId) => {
        calls.resolveCalls.push(workspaceId);
        return "C:/work/project";
      }),
      openInExternalEditor: actions.openInExternalEditor ?? (async (cwd) => {
        calls.editorCalls.push(cwd);
        return { status: "opened", editorName: "Code.exe" };
      }),
      revealInFileManager: actions.revealInFileManager ?? (async (cwd) => {
        calls.revealCalls.push(cwd);
      }),
      resolveDroppedPaths: actions.resolveDroppedPaths ?? (async (cwd, paths) => {
        calls.droppedCalls.push({ cwd, paths });
        return paths.map((path) => ({
          ok: true as const,
          kind: "file" as const,
          scope: "workspace" as const,
          path: path.replace(/^.*[/\\]/u, ""),
          name: "x",
        }));
      }),
      pickPlanSavePath: async () => ({ status: "cancelled" } as const),
      openFile: actions.openFile ?? (async (cwd, target) => {
        calls.fileCalls.push({ cwd, target });
        return { status: "opened" };
      }),
      openFileWith: actions.openFileWith ?? (async (cwd, target, openerId) => {
        calls.fileCalls.push({ cwd, target, openerId });
        return { status: "opened" };
      }),
      revealFileInFileManager: actions.revealFileInFileManager ?? (async (cwd, target) => {
        calls.fileCalls.push({ cwd, target });
        return { status: "opened" };
      }),
      resolveFileAbsolutePath: actions.resolveFileAbsolutePath ?? (async (cwd, target) => {
        calls.absolutePathCalls.push({ cwd, target });
        return `C:/work/project/${target.path}`;
      }),
      listFileOpeners: actions.listFileOpeners ?? (async () => {
        calls.openerListCalls.push(1);
        return [{ id: "vscode", name: "Visual Studio Code" }];
      }),
    },
  });
  return {
    ipc,
    calls,
    handle,
    async invoke(channel: string, sender = makeSender(), payload?: unknown): Promise<unknown> {
      const handler = ipc.handlers.get(channel);
      assert.ok(handler, `no handler for ${channel}`);
      return await handler({ sender }, payload);
    },
  };
}

describe("workspace shell payload validation", () => {
  test("accepts an opaque workspaceId", () => {
    assert.deepEqual(parseWorkspaceShellInput({ workspaceId: "w_1-2.3~4" }), { workspaceId: "w_1-2.3~4" });
  });

  test("rejects non-objects, unknown fields and invalid workspace ids", () => {
    assert.throws(() => parseWorkspaceShellInput(null), WorkspaceShellIpcError);
    assert.throws(() => parseWorkspaceShellInput([]), WorkspaceShellIpcError);
    assert.throws(() => parseWorkspaceShellInput({ workspaceId: "ok", path: "C:/x" }), /unexpected field/u);
    assert.throws(() => parseWorkspaceShellInput({}), /workspaceId/u);
    assert.throws(() => parseWorkspaceShellInput({ workspaceId: "has space" }), /workspaceId/u);
    assert.throws(() => parseWorkspaceShellInput({ workspaceId: "x".repeat(129) }), /workspaceId/u);
  });

  test("dropped-path payload accepts opaque id plus path list", () => {
    assert.deepEqual(
      parseResolveDroppedPathsInput({ workspaceId: "ws-1", paths: ["C:/tmp/a.ts"] }),
      { workspaceId: "ws-1", paths: ["C:/tmp/a.ts"] },
    );
    assert.throws(() => parseResolveDroppedPathsInput({ workspaceId: "ws-1" }), /paths/u);
    assert.throws(() => parseResolveDroppedPathsInput({ workspaceId: "ws-1", paths: [], extra: 1 }), /unexpected field/u);
  });

  test("file target payload accepts a workspace-relative path with a kind", () => {
    assert.deepEqual(
      parseWorkspaceFileTargetInput({ workspaceId: "ws-1", path: "src/main.ts", kind: "file" }),
      { workspaceId: "ws-1", path: "src/main.ts", kind: "file" },
    );
    assert.deepEqual(
      parseWorkspaceFileTargetInput({ workspaceId: "ws-1", path: "src", kind: "dir" }),
      { workspaceId: "ws-1", path: "src", kind: "dir" },
    );
  });

  test("file target payload rejects traversal, absolute and malformed paths", () => {
    assert.throws(() => parseWorkspaceFileTargetInput({ workspaceId: "ws-1", path: "../outside.ts", kind: "file" }), WorkspaceShellIpcError);
    assert.throws(() => parseWorkspaceFileTargetInput({ workspaceId: "ws-1", path: "a/../b.ts", kind: "file" }), WorkspaceShellIpcError);
    assert.throws(() => parseWorkspaceFileTargetInput({ workspaceId: "ws-1", path: "/abs.ts", kind: "file" }), WorkspaceShellIpcError);
    assert.throws(() => parseWorkspaceFileTargetInput({ workspaceId: "ws-1", path: "src\\main.ts", kind: "file" }), WorkspaceShellIpcError);
    assert.throws(() => parseWorkspaceFileTargetInput({ workspaceId: "ws-1", path: "", kind: "file" }), WorkspaceShellIpcError);
    assert.throws(() => parseWorkspaceFileTargetInput({ workspaceId: "ws-1", path: "a.ts", kind: "symlink" }), /kind/u);
    assert.throws(() => parseWorkspaceFileTargetInput({ workspaceId: "ws-1", path: "a.ts", kind: "file", extra: 1 }), /unexpected field/u);
    assert.throws(() => parseWorkspaceFileTargetInput({ workspaceId: "bad id", path: "a.ts", kind: "file" }), /workspaceId/u);
  });

  test("open-with payload whitelists opener ids", () => {
    for (const openerId of ["vscode", "cursor", "windsurf", "choose"] as const) {
      assert.deepEqual(
        parseFileOpenWithInput({ workspaceId: "ws-1", path: "a.ts", kind: "file", openerId }),
        { workspaceId: "ws-1", path: "a.ts", kind: "file", openerId },
      );
    }
    assert.throws(() => parseFileOpenWithInput({ workspaceId: "ws-1", path: "a.ts", kind: "file", openerId: "notepad" }), /openerId/u);
    assert.throws(() => parseFileOpenWithInput({ workspaceId: "ws-1", path: "a.ts", kind: "file" }), /openerId/u);
  });
});

describe("registerWorkspaceShellIpc", () => {
  test("openInEditor resolves the id and launches the editor with the Host cwd", async () => {
    const shell = register();
    await shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.openInEditor, makeSender(), { workspaceId: "ws-editor" });
    assert.deepEqual(shell.calls.resolveCalls, ["ws-editor"]);
    assert.deepEqual(shell.calls.editorCalls, ["C:/work/project"]);
    assert.deepEqual(shell.calls.revealCalls, []);
  });

  test("openInEditor returns the picker outcome to the Renderer", async () => {
    const shell = register({
      openInExternalEditor: async () => ({ status: "cancelled" }),
    });
    const outcome = await shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.openInEditor, makeSender(), { workspaceId: "ws-cancel" });
    assert.deepEqual(outcome, { status: "cancelled" });
  });

  test("revealInFileManager resolves the id and opens the directory", async () => {
    const shell = register();
    await shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.revealInFileManager, makeSender(), { workspaceId: "ws-reveal" });
    assert.deepEqual(shell.calls.resolveCalls, ["ws-reveal"]);
    assert.deepEqual(shell.calls.revealCalls, ["C:/work/project"]);
    assert.deepEqual(shell.calls.editorCalls, []);
  });

  test("rejects a destroyed sender before resolving or launching", async () => {
    const shell = register();
    const sender = makeSender();
    sender.destroyed = true;
    await assert.rejects(
      () => shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.openInEditor, sender, { workspaceId: "ws-x" }),
      /untrusted sender/u,
    );
    assert.deepEqual(shell.calls.resolveCalls, []);
    assert.deepEqual(shell.calls.editorCalls, []);
  });

  test("a resolver failure never reaches the opener", async () => {
    const shell = register({
      resolveWorkspaceCwd: async () => {
        throw new Error("unknown workspace");
      },
    });
    await assert.rejects(
      () => shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.revealInFileManager, makeSender(), { workspaceId: "ws-x" }),
      /unknown workspace/u,
    );
    assert.deepEqual(shell.calls.revealCalls, []);
  });

  test("resolveDroppedPaths resolves the id then maps OS paths", async () => {
    const shell = register();
    await shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.resolveDroppedPaths, makeSender(), {
      workspaceId: "ws-drop",
      paths: ["C:/work/project/src/a.ts"],
    });
    assert.deepEqual(shell.calls.resolveCalls, ["ws-drop"]);
    assert.equal(shell.calls.droppedCalls[0]?.cwd, "C:/work/project");
    assert.deepEqual(shell.calls.droppedCalls[0]?.paths, ["C:/work/project/src/a.ts"]);
  });

  test("dispose removes both fixed channels", () => {
    const shell = register();
    shell.handle.dispose();
    assert.ok(shell.ipc.removed.includes(WORKSPACE_SHELL_IPC_CHANNELS.openInEditor));
    assert.ok(shell.ipc.removed.includes(WORKSPACE_SHELL_IPC_CHANNELS.revealInFileManager));
    assert.ok(shell.ipc.removed.includes(WORKSPACE_SHELL_IPC_CHANNELS.resolveDroppedPaths));
    assert.equal(shell.ipc.handlers.size, 0);
  });

  test("file actions resolve the id and forward the validated target", async () => {
    const shell = register();
    const target = { workspaceId: "ws-file", path: "src/main.ts", kind: "file" } as const;
    await shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileOpen, makeSender(), target);
    await shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileReveal, makeSender(), target);
    await shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileAbsolutePath, makeSender(), target);
    await shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileOpenWith, makeSender(), { ...target, openerId: "vscode" });
    assert.deepEqual(shell.calls.resolveCalls, ["ws-file", "ws-file", "ws-file", "ws-file"]);
    const forwarded = { cwd: "C:/work/project", target: { workspaceId: "ws-file", path: "src/main.ts", kind: "file" } };
    assert.deepEqual(shell.calls.fileCalls, [forwarded, forwarded, { ...forwarded, openerId: "vscode" }]);
    assert.deepEqual(shell.calls.absolutePathCalls, [forwarded]);
  });

  test("file actions reject malformed payloads before touching the workspace", async () => {
    const shell = register();
    await assert.rejects(
      () => shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileOpen, makeSender(), { workspaceId: "ws-x", path: "../escape.ts", kind: "file" }),
      WorkspaceShellIpcError,
    );
    assert.deepEqual(shell.calls.resolveCalls, []);
    assert.deepEqual(shell.calls.fileCalls, []);
  });

  test("fileOpeners requires the workspace payload and returns the opener list", async () => {
    const shell = register();
    const openers = await shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileOpeners, makeSender(), { workspaceId: "ws-x" });
    assert.deepEqual(openers, [{ id: "vscode", name: "Visual Studio Code" }]);
    assert.deepEqual(shell.calls.openerListCalls, [1]);
    assert.deepEqual(shell.calls.resolveCalls, []);
    await assert.rejects(
      () => shell.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileOpeners, makeSender(), { workspaceId: "ws-x", extra: true }),
      /unexpected field/u,
    );
  });
});
