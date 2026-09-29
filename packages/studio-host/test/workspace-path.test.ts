import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";

import { WorkspaceRegistry, canonicalWorkspacePath, sameWorkspacePath, workspacePathKey } from "../src/index.js";

test("Windows keeps the case-insensitive resolve comparison the session services always used", () => {
  const legacy = (left: string, right: string) => win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  const pairs: Array<[string, string]> = [
    ["C:\\Work\\Proj", "c:\\work\\proj"],
    ["C:\\Work\\Proj\\", "C:\\Work\\Proj"],
    ["C:\\Work\\Proj\\..\\Proj", "C:\\Work\\Proj"],
    ["C:\\Work\\Proj", "C:\\Work\\Proj2"],
    ["\\\\server\\share\\Proj", "\\\\SERVER\\share\\proj"],
    ["D:\\Proj", "C:\\Proj"],
  ];
  for (const [left, right] of pairs) assert.equal(sameWorkspacePath(left, right, "win32"), legacy(left, right), `${left} vs ${right}`);
  assert.equal(workspacePathKey("C:\\Work\\Proj", "win32"), "c:\\work\\proj");
});

test("macOS treats the /private aliases and NFC/NFD spellings as one workspace", () => {
  assert.equal(sameWorkspacePath("/private/var/folders/ab/T/proj", "/var/folders/ab/T/proj", "darwin"), true);
  assert.equal(sameWorkspacePath("/private/tmp/proj/", "/tmp/proj", "darwin"), true);
  assert.equal(sameWorkspacePath("/private/etc", "/etc", "darwin"), true);
  assert.equal(sameWorkspacePath("/Users/dev/Caf\u00e9", "/Users/dev/Cafe\u0301", "darwin"), true);
  assert.equal(sameWorkspacePath("/private/varnish/proj", "/varnish/proj", "darwin"), false);
  assert.equal(sameWorkspacePath("/Users/dev/Proj", "/Users/dev/proj", "darwin"), false);
  assert.equal(workspacePathKey("/private/var/x", "darwin"), "/var/x");
});

test("Linux compares resolved paths exactly", () => {
  assert.equal(sameWorkspacePath("/home/dev/proj/", "/home/dev/proj", "linux"), true);
  assert.equal(sameWorkspacePath("/private/tmp/proj", "/tmp/proj", "linux"), false);
  assert.equal(sameWorkspacePath("/home/dev/Caf\u00e9", "/home/dev/Cafe\u0301", "linux"), false);
});

test("the stored spelling is the real path, with the short /private aliases on macOS", async () => {
  const links: Readonly<Record<string, string>> = {
    "/var/folders/ab/T/proj": "/private/var/folders/ab/T/proj",
    "/Users/dev/link": "/Volumes/Data/proj",
  };
  const realpath = async (path: string) => links[path] ?? path;
  assert.equal(await canonicalWorkspacePath("/var/folders/ab/T/proj/", { platform: "darwin", realpath }), "/var/folders/ab/T/proj");
  assert.equal(await canonicalWorkspacePath("/Users/dev/link", { platform: "darwin", realpath }), "/Volumes/Data/proj");
  const denied = async () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
  assert.equal(await canonicalWorkspacePath("/Users/dev/Documents/proj/../proj", { platform: "darwin", realpath: denied }), "/Users/dev/Documents/proj");
  assert.equal(await canonicalWorkspacePath("C:\\Work\\proj", { platform: "win32", realpath: async () => "C:\\Work\\Proj" }), "C:\\Work\\Proj");
  assert.equal(await canonicalWorkspacePath("C:\\Work\\proj\\", { platform: "win32", realpath: denied }), "C:\\Work\\proj");
  let asked = false;
  assert.equal(await canonicalWorkspacePath("/home/dev/proj/", { platform: "linux", realpath: async (path) => { asked = true; return path; } }), "/home/dev/proj");
  assert.equal(asked, false);
});

const darwinOnly = { skip: process.platform === "darwin" ? false : "macOS file system" } as const;

test("a workspace opened through a symlink or /private is registered once", darwinOnly, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "omp-workspace-path-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const project = join(profile, "real", "project");
  await mkdir(project, { recursive: true });
  // A linked parent is an ordinary way in; the workspace root itself must not be a link.
  await symlink(join(profile, "real"), join(profile, "link"));
  await symlink(project, join(profile, "leaf"));
  const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
  await registry.load();
  const direct = await registry.upsertByPath(project);
  const viaLink = await registry.upsertByPath(join(profile, "link", "project"));
  await assert.rejects(() => registry.upsertByPath(join(profile, "leaf")), /symbolic link/u);
  const viaPrivate = await registry.upsertByPath(await realpath(project));
  assert.equal(viaLink.workspaceId, direct.workspaceId);
  assert.equal(viaPrivate.workspaceId, direct.workspaceId);
  assert.equal(registry.list().length, 1);
  assert.equal(direct.canonicalPath.startsWith("/private/"), false);
});
