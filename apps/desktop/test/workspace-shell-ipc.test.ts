/**
 * Desktop-chrome workspace shell IPC tests.
 *
 * Headless: fake ipcMain + fake actions. No Electron, no editor process.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  WORKSPACE_SHELL_IPC_CHANNELS,
  parseResolveDroppedPathsInput,
  parseWorkspaceShellInput,
  WorkspaceShellIpcError,
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
}

function register(actions: Partial<{
  resolveWorkspaceCwd(workspaceId: string): Promise<string>;
  openInExternalEditor(cwd: string): Promise<WorkspaceShellEditorResult>;
  revealInFileManager(cwd: string): Promise<void>;
  resolveDroppedPaths(cwd: string, paths: readonly string[]): Promise<Array<{ ok: true; kind: "file"; scope: "workspace"; path: string; name: string }>>;
}> = {}) {
  const ipc = makeIpc();
  const calls: Actions = { resolveCalls: [], editorCalls: [], revealCalls: [], droppedCalls: [] };
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
});
