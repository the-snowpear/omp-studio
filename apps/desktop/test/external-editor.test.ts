/**
 * External editor discovery tests. No editor is ever spawned.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  externalEditorCommandForPath,
  resolveExternalEditorCommand,
  type ExternalEditorCommand,
} from "../src/external-editor.js";

test("win32 prefers an existing per-user VS Code executable", async () => {
  const local = await mkdtemp(join(tmpdir(), "omp-editor-local-"));
  const code = join(local, "Programs", "Microsoft VS Code", "Code.exe");
  await mkdir(join(local, "Programs", "Microsoft VS Code"), { recursive: true });
  await writeFile(code, "fake");
  try {
    const command = resolveExternalEditorCommand({
      platform: "win32",
      env: { LOCALAPPDATA: local },
      exists: (path) => path === code,
    });
    assert.ok(command);
    assert.equal(command.label, "Visual Studio Code");
    assert.deepEqual([...command.argsFor("D:/repo")], ["D:/repo"]);
  } finally {
    await rm(local, { recursive: true, force: true });
  }
});

test("win32 returns undefined when no known editor path exists", () => {
  const command = resolveExternalEditorCommand({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\Users\nobody\AppData\Local" },
    exists: () => false,
  });
  assert.equal(command, undefined);
});

test("darwin picks the first existing app CLI", () => {
  const cursor = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
  const command = resolveExternalEditorCommand({
    platform: "darwin",
    env: {},
    exists: (path) => path === cursor,
  });
  assert.ok(command);
  assert.equal(command.label, "Cursor");
  assert.deepEqual([...command.argsFor("/Users/dev/repo")], ["/Users/dev/repo"]);
});

test("linux defaults to the VS Code PATH command", () => {
  const command = resolveExternalEditorCommand({ platform: "linux", env: {}, exists: () => false });
  assert.ok(command);
  assert.equal(command.file, "code");
  assert.equal(command.argsFor("/srv/repo")[0], "/srv/repo");
});

test("externalEditorCommandForPath launches a picked Windows executable with the project path", () => {
  const command = externalEditorCommandForPath("C:/Apps/Cursor.exe", { platform: "win32" });
  assert.equal(command.label, "Cursor.exe");
  assert.equal(command.file, "C:/Apps/Cursor.exe");
  assert.deepEqual([...command.argsFor("D:/repo")], ["D:/repo"]);
});

test("externalEditorCommandForPath routes a picked macOS app through open -a", () => {
  const command = externalEditorCommandForPath("/Applications/Visual Studio Code.app", { platform: "darwin" });
  assert.equal(command.label, "Visual Studio Code");
  assert.equal(command.file, "/usr/bin/open");
  assert.deepEqual([...command.argsFor("/Users/dev/repo")], ["-a", "/Applications/Visual Studio Code.app", "/Users/dev/repo"]);
});

test("command shape is stable for launching", () => {
  const command: ExternalEditorCommand = {
    label: "Test Editor",
    file: "editor",
    argsFor: (cwd) => [cwd],
  };
  assert.equal(command.label, "Test Editor");
  assert.equal(command.file, "editor");
  assert.deepEqual([...command.argsFor("/tmp/repo")], ["/tmp/repo"]);
});
