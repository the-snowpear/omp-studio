import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ClientError, CommandRequestId, WorkspaceId } from "@omp-studio/client-contract";
import { WorkspaceRegistry } from "@omp-studio/studio-host";

import { createDesktopGitService } from "../src/git-service.js";
import { createDesktopGithubService } from "../src/github-service.js";
import { GitWriteQueue, HostProcessError, HostProcessRunner, type ProcessRunOptions, type ProcessRunResult } from "../src/git-process.js";

const execFileAsync = promisify(execFile);

async function hasGit(): Promise<boolean> {
  try { await execFileAsync("git", ["--version"]); return true; } catch { return false; }
}

async function removeGitFixture(root: string): Promise<void> {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}

test("HostProcessRunner uses argv execution and enforces its output bound", async () => {
  const runner = new HostProcessRunner();
  const result = await runner.run({ command: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", "literal;not-a-shell"], readOnly: true });
  assert.equal(result.stdout, "literal;not-a-shell");
  await assert.rejects(
    runner.run({ command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(2048))"], outputLimit: 128 }),
    (error: unknown) => error instanceof HostProcessError && /safe limit/u.test(error.message),
  );
  await runner.run({ command: process.execPath, args: ["-e", "process.exit(0)"], stdin: "x".repeat(2 * 1024 * 1024) });
});

test("HostProcessRunner cancels tracked work before it reaches spawn", () => {
  const runner = new HostProcessRunner();
  const requestId = "queued-request" as CommandRequestId;
  runner.track(requestId);
  assert.equal(runner.cancel(requestId), true);
  assert.throws(() => runner.assertNotCancelled(requestId), (error: unknown) => error instanceof HostProcessError && error.kind === "cancelled");
  runner.untrack(requestId);
  assert.equal(runner.cancel(requestId), false);
});

test("GitWriteQueue serializes writes for one common directory", async () => {
  const queue = new GitWriteQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.run("repo", async () => { order.push("first:start"); await gate; order.push("first:end"); });
  const second = queue.run("repo", async () => { order.push("second:start"); order.push("second:end"); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

class GithubFixtureRunner extends HostProcessRunner {
  readonly calls: ProcessRunOptions[] = [];

  override async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.calls.push(options);
    const result = (value: unknown): ProcessRunResult => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
    if (options.command === "git" && options.args.length === 1 && options.args[0] === "remote") return { stdout: "origin\nupstream\n", stderr: "", exitCode: 0 };
    if (options.command === "git" && options.args.includes("upstream")) return { stdout: "https://github.com/upstream/project.git\n", stderr: "", exitCode: 0 };
    if (options.command === "gh" && options.args.includes("graphql")) {
      const row = { number: 7, title: "Fixture PR", body: "Source body", url: "https://github.com/acme/repo/pull/7", state: "OPEN", author: { login: "fixture" }, updatedAt: "2026-11-01T00:00:00Z", labels: { nodes: [{ name: "bug" }] }, comments: { totalCount: 1 }, isDraft: false, headRefName: "feature", baseRefName: "main", headRefOid: "abc123", reviewDecision: "APPROVED", additions: 2, deletions: 1, changedFiles: 1 };
      return options.args.some(arg => arg.startsWith("q=")) ? result({ data: { search: { issueCount: 51, nodes: [row], pageInfo: { hasNextPage: !options.args.includes("cursor=page2"), endCursor: "page2" } } } }) : result({ data: { repository: { item: row } } });
    }
    if (options.command === "gh" && options.args[0] === "api" && !options.args.includes("POST")) {
      const endpoint = options.args[3] ?? "";
      if (endpoint.includes("/files?")) return result([{ filename: "src/file.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }]);
      if (endpoint.endsWith("/pulls/7")) return result({ head: { sha: "abc123" } });
      return result([{ id: 1, user: { login: "reviewer" }, body: "Review text", created_at: "2026-11-01T00:00:00Z", html_url: "https://github.com/upstream/project/pull/7#comment", ...(endpoint.includes("pulls/7/comments") ? { path: "src/file.ts", line: 2 } : {}) }]);
    }
    if (options.command === "git" && options.args[0] === "remote") return { stdout: "https://github.com/acme/repo.git\n", stderr: "", exitCode: 0 };
    if (options.command === "git" && options.args[0] === "rev-parse") return { stdout: ".git\n", stderr: "", exitCode: 0 };
    if (options.command === "gh" && options.args[0] === "auth") return { stdout: '{"hosts":{"github.com":[{"state":"success","active":true,"login":"fixture","gitProtocol":"https"}]}}', stderr: "", exitCode: 0 };
    if (options.command === "gh" && options.args[0] === "pr" && options.args[1] === "list") return { stdout: '[{"number":7,"title":"Fixture PR","state":"OPEN","isDraft":false,"headRefName":"feature","baseRefName":"main","headRefOid":"abc123","author":{"login":"fixture"},"url":"https://github.com/acme/repo/pull/7"}]', stderr: "", exitCode: 0 };
    if (options.command === "gh" && options.args[0] === "pr" && options.args[1] === "view") return { stdout: '{"number":7,"title":"Fixture PR","state":"OPEN","isDraft":false,"headRefName":"feature","baseRefName":"main","headRefOid":"abc123","author":{"login":"fixture"},"url":"https://github.com/acme/repo/pull/7"}', stderr: "", exitCode: 0 };
    if (options.command === "gh" && options.args[0] === "pr" && options.args[1] === "checks") return { stdout: "[]", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

test("DesktopGithubService uses gh JSON reads and sends PR bodies through stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-github-service-"));
  const project = join(root, "project");
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  try {
    await mkdir(project);
    const stored = await registry.upsertByPath(project);
    const workspaceId = stored.workspaceId as WorkspaceId;
    const runner = new GithubFixtureRunner();
    const service = createDesktopGithubService({ registry, runner });
    const auth = await service.auth({ workspaceId });
    assert.equal(auth.authenticated, true);
    assert.equal(auth.account, "fixture");
    const list = await service.pullRequests({ workspaceId, state: "open" });
    assert.equal(list.pullRequests[0]?.number, 7);
    await service.execute({ workspaceId, operation: { kind: "pr.comment", number: 7, body: "body kept out of argv" } }, "github-comment" as CommandRequestId);
    const comment = runner.calls.find((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "comment");
    assert.ok(comment);
    assert.equal(comment.stdin, "body kept out of argv");
    assert.ok(!comment.args.join(" ").includes("body kept out of argv"));
    assert.equal(comment.args.includes("--body-file"), true);
    await service.execute({ workspaceId, operation: { kind: "pr.close", number: 7, comment: "close reason" } }, "github-close" as CommandRequestId);
    const closeComment = runner.calls.find((call) => call.command === "gh" && call.args[0] === "api" && call.args.includes("POST"));
    assert.ok(closeComment);
    assert.equal(closeComment.stdin, JSON.stringify({ body: "close reason" }));
    assert.ok(!closeComment.args.join(" ").includes("close reason"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub browser keeps upstream scope through pagination, discussion, diffs and PR actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-github-browse-"));
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  try {
    const stored = await registry.upsertByPath(root);
    const runner = new GithubFixtureRunner();
    const service = createDesktopGithubService({ registry, runner });
    const target = { workspaceId: stored.workspaceId as WorkspaceId, remote: "upstream" };
    const remotes = await service.repositories(target);
    assert.deepEqual(remotes.repositories.map(row => row.remote), ["origin", "upstream"]);
    const first = await service.items({ ...target, kind: "pr", label: "bug", assignedToMe: true, reviewRequested: true, search: "theme" });
    assert.equal(first.repository.ownerRepo, "upstream/project");
    assert.equal(first.nextCursor, "page2");
    await service.items({ ...target, kind: "pr", cursor: first.nextCursor });
    const search = runner.calls.find(call => call.args.some(arg => arg.startsWith("q=")))!.args.join(" ");
    assert.match(search, /repo:upstream\/project/);
    assert.match(search, /assignee:@me/);
    assert.match(search, /review-requested:@me/);
    assert.ok(runner.calls.some(call => call.args.includes("cursor=page2")));
    const discussion = await service.discussion({ ...target, kind: "pr", number: 7 });
    assert.deepEqual(discussion.comments.map(row => row.kind), ["comment", "review", "inline"]);
    assert.equal(discussion.comments[2]?.path, "src/file.ts");
    const files = await service.files({ ...target, number: 7, headOid: "abc123" });
    assert.equal(files.files[0]?.path, "src/file.ts");
    const diff = await service.fileDiff({ ...target, number: 7, path: "src/file.ts", headOid: "abc123" });
    assert.match(diff.patch, /\+new/);
    await assert.rejects(service.fileDiff({ ...target, number: 7, path: "src/file.ts", headOid: "older" }), /PR_HEAD_CHANGED/);
    await service.execute({ ...target, operation: { kind: "pr.ready", number: 7 } }, "upstream-ready" as CommandRequestId);
    const ready = runner.calls.find(call => call.args[0] === "pr" && call.args[1] === "ready");
    assert.ok(ready?.args.includes("github.com/upstream/project"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("DesktopGitService performs real repository, branch, worktree and safety flows", async (context) => {
  if (!(await hasGit())) { context.skip("system Git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "omp-git-service-"));
  const project = join(root, "project");
  const worktreeRoot = join(root, "worktrees");
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  // The service's .git watchers hold Windows directory handles; dispose them
  // before the recursive rm below or the cleanup fails and the run hangs.
  let service: ReturnType<typeof createDesktopGitService> | undefined;
  try {
    await mkdir(project);
    await mkdir(worktreeRoot);
    const stored = await registry.upsertByPath(project);
    const workspaceId = stored.workspaceId as WorkspaceId;
    service = createDesktopGitService({
      registry,
      pickDirectory: async () => worktreeRoot,
      preferencesPath: join(root, "git-preferences.json"),
    });
    const request = (value: string) => value as CommandRequestId;

    const initialized = await service.execute({ workspaceId, operation: { kind: "init" } }, request("git-init"));
    assert.equal(initialized.repository?.isRepository, true);
    await execFileAsync("git", ["config", "user.name", "OMP Test"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "omp@example.invalid"], { cwd: project });

    await writeFile(join(project, "README.md"), "first\n", "utf8");
    let repository = await service.repository({ workspaceId });
    assert.equal(repository.changes[0]?.path, "README.md");
    assert.equal(repository.changes[0]?.worktree, "untracked");

    await service.execute({ workspaceId, operation: { kind: "stage", paths: ["README.md"] } }, request("git-stage"));
    repository = await service.repository({ workspaceId });
    assert.equal(repository.changes[0]?.index, "added");
    await service.execute({ workspaceId, operation: { kind: "unstage", paths: ["README.md"] } }, request("git-unstage"));
    repository = await service.repository({ workspaceId });
    assert.equal(repository.changes[0]?.worktree, "untracked");
    await service.execute({ workspaceId, operation: { kind: "discard", paths: ["README.md"], expectedRevision: repository.revision! } }, request("git-discard-untracked"));
    assert.equal((await service.repository({ workspaceId })).changes.length, 0);
    await writeFile(join(project, "README.md"), "first\n", "utf8");
    await service.execute({ workspaceId, operation: { kind: "stage", paths: ["README.md"] } }, request("git-restage"));
    await service.execute({ workspaceId, operation: { kind: "commit", message: "initial commit" } }, request("git-commit"));
    assert.equal((await service.repository({ workspaceId })).changes.length, 0);

    await service.execute({ workspaceId, operation: { kind: "branch.create", name: "feature", checkout: true } }, request("git-branch"));
    assert.equal((await service.repository({ workspaceId })).branch, "feature");
    assert.ok((await service.branches({ workspaceId })).branches.some((branch) => branch.name === "feature" && branch.current));

    await service.execute({ workspaceId, operation: { kind: "remote.add", name: "origin", url: "https://user:secret@github.com/acme/repo.git" } }, request("git-remote"));
    const remoteJson = JSON.stringify(await service.remotes({ workspaceId }));
    assert.ok(!remoteJson.includes("secret"));
    assert.ok(!remoteJson.includes("user:"));
    await service.execute({ workspaceId, operation: { kind: "remote.add", name: "local", url: project } }, request("git-local-remote"));
    const localRemoteJson = JSON.stringify(await service.remotes({ workspaceId }));
    assert.ok(!localRemoteJson.includes(root));
    assert.ok(localRemoteJson.includes("[local repository]"));

    await service.execute({ workspaceId, operation: { kind: "worktree.pickRoot" } }, request("git-root"));
    const created = await service.execute({ workspaceId, operation: { kind: "worktree.create", branch: "worktree-feature", createBranch: true } }, request("git-worktree"));
    assert.ok(created.createdWorkspaceId);
    assert.equal((await service.worktrees({ workspaceId })).rootConfigured, true);
    assert.ok((await service.worktrees({ workspaceId })).worktrees.some((entry) => entry.branch === "worktree-feature"));

    const cloned = await service.execute({ operation: { kind: "clone", url: project, directoryName: "clone-copy" } }, request("git-clone"));
    assert.ok(cloned.createdWorkspaceId);
    assert.equal(cloned.repository?.isRepository, true);
    assert.ok(!JSON.stringify(cloned).includes(root));

    await writeFile(join(project, "README.md"), "second\n", "utf8");
    const reviewed = await service.repository({ workspaceId });
    assert.ok(reviewed.revision);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await writeFile(join(project, "README.md"), "third and newer\n", "utf8");
    await assert.rejects(
      service.execute({ workspaceId, operation: { kind: "discard", paths: ["README.md"], expectedRevision: reviewed.revision! } }, request("git-stale")),
      (error: unknown) => (error as ClientError).code === "STATE_VERSION_CONFLICT",
    );
    await assert.rejects(
      service.execute({ workspaceId, operation: { kind: "stage", paths: ["../outside"] } }, request("git-escape")),
      (error: unknown) => (error as ClientError).code === "INVALID_ARGUMENT",
    );
  } finally {
    service?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("file operations treat bracketed filenames literally and preserve unselected files", async context => {
  if (!(await hasGit())) { context.skip("system Git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "omp-git-literal-"));
  const project = join(root, "project"), registry = new WorkspaceRegistry(join(root, "registry.json"));
  let service: ReturnType<typeof createDesktopGitService> | undefined;
  try {
    await mkdir(project);
    const workspaceId = (await registry.upsertByPath(project)).workspaceId as WorkspaceId;
    service = createDesktopGitService({ registry, pickDirectory: async () => undefined, preferencesPath: join(root, "preferences.json") });
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: project });
    const run = (operation: import("@omp-studio/client-contract").GitOperation) => service!.execute({ workspaceId, operation }, "literal-operation" as CommandRequestId);
    const selected = "report[1].txt", other = "report1.txt";
    await git("init", "--quiet"); await git("config", "user.name", "OMP Test"); await git("config", "user.email", "omp@example.invalid"); await git("config", "core.autocrlf", "false");
    for (const name of [selected, other]) await writeFile(join(project, name), "base\n");
    await git("add", ".");
    await run({ kind: "unstage", paths: [selected] });
    let repository = await service.repository({ workspaceId });
    assert.equal(repository.changes.find(change => change.path === selected)?.worktree, "untracked");
    assert.equal(repository.changes.find(change => change.path === other)?.index, "added");
    await run({ kind: "stage", paths: [selected] }); await run({ kind: "commit", message: "seed" });

    await writeFile(join(project, selected), "selected local\n"); await writeFile(join(project, other), "unselected local\n");
    const diff = await service.diff({ workspaceId, path: selected, target: "working" });
    assert.match(diff.patch, /selected local/); assert.doesNotMatch(diff.patch, /unselected local/);
    await run({ kind: "stage", paths: [selected] });
    repository = await service.repository({ workspaceId });
    assert.equal(repository.changes.find(change => change.path === selected)?.index, "modified");
    assert.equal(repository.changes.find(change => change.path === other)?.index, "unmodified");
    await run({ kind: "stage", paths: [other] }); await run({ kind: "unstage", paths: [selected] });
    repository = await service.repository({ workspaceId });
    assert.equal(repository.changes.find(change => change.path === other)?.index, "modified");
    await run({ kind: "commit", message: "selected only", paths: [selected] });
    const committed = await service.commitChanges({ workspaceId, oid: "HEAD" });
    assert.deepEqual(committed.files.map(file => file.path), [selected]);
    const committedDiff = await service.commitDiff({ workspaceId, oid: "HEAD", path: selected });
    assert.match(committedDiff.patch, /selected local/); assert.doesNotMatch(committedDiff.patch, /unselected local/);
    assert.equal((await git("show", `HEAD:${other}`)).stdout, "base\n");

    await writeFile(join(project, selected), "discard selected\n"); await writeFile(join(project, other), "keep unselected\n");
    repository = await service.repository({ workspaceId });
    await run({ kind: "discard", paths: [selected], expectedRevision: repository.revision! });
    assert.equal(await readFile(join(project, selected), "utf8"), "selected local\n");
    assert.equal(await readFile(join(project, other), "utf8"), "keep unselected\n");
    await writeFile(join(project, "new[1].txt"), "remove this\n"); await writeFile(join(project, "new1.txt"), "keep this\n");
    repository = await service.repository({ workspaceId });
    await run({ kind: "discard", paths: ["new[1].txt"], expectedRevision: repository.revision! });
    await assert.rejects(readFile(join(project, "new[1].txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(project, "new1.txt"), "utf8"), "keep this\n");
  } finally { service?.dispose(); await removeGitFixture(root); }
});

test("subdirectory workspaces use repository-relative paths for diffs and writes", async context => {
  if (!(await hasGit())) { context.skip("system Git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "omp-git-subdirectory-"));
  const project = join(root, "project"), registry = new WorkspaceRegistry(join(root, "registry.json"));
  let service: ReturnType<typeof createDesktopGitService> | undefined;
  try {
    await mkdir(join(project, "src", "src"), { recursive: true });
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: project });
    await git("init", "--quiet"); await git("config", "user.name", "OMP Test"); await git("config", "user.email", "omp@example.invalid"); await git("config", "core.autocrlf", "false");
    await writeFile(join(project, "src/a.txt"), "base\n"); await writeFile(join(project, "src/src/a.txt"), "base\n");
    await git("add", "."); await git("commit", "--quiet", "-m", "seed");
    const workspaceId = (await registry.upsertByPath(join(project, "src"))).workspaceId as WorkspaceId;
    service = createDesktopGitService({ registry, pickDirectory: async () => undefined, preferencesPath: join(root, "preferences.json") });
    const run = (operation: import("@omp-studio/client-contract").GitOperation) => service!.execute({ workspaceId, operation }, "subdirectory-operation" as CommandRequestId);
    await writeFile(join(project, "src/a.txt"), "selected edit\n"); await writeFile(join(project, "src/src/a.txt"), "other edit\n");
    let repository = await service.repository({ workspaceId });
    assert.equal(repository.workspacePrefix, "src");
    assert.equal((await service.summary({ workspaceId })).workspacePrefix, "src");
    assert.deepEqual(repository.changes.map(change => change.path), ["src/a.txt", "src/src/a.txt"]);
    const diff = await service.diff({ workspaceId, path: "src/a.txt", target: "working" });
    assert.match(diff.patch, /selected edit/); assert.doesNotMatch(diff.patch, /other edit/);
    await run({ kind: "discard", paths: ["src/a.txt"], expectedRevision: repository.revision! });
    assert.equal(await readFile(join(project, "src/a.txt"), "utf8"), "base\n");
    assert.equal(await readFile(join(project, "src/src/a.txt"), "utf8"), "other edit\n");
    await writeFile(join(project, "src/a.txt"), "selected commit\n");
    await run({ kind: "stage", paths: ["src/a.txt"] });
    repository = await service.repository({ workspaceId });
    assert.equal(repository.changes.find(change => change.path === "src/a.txt")?.index, "modified");
    assert.equal(repository.changes.find(change => change.path === "src/src/a.txt")?.index, "unmodified");
    await run({ kind: "unstage", paths: ["src/a.txt"] });
    await run({ kind: "commit", message: "selected subdirectory file", paths: ["src/a.txt"] });
    assert.deepEqual((await service.commitChanges({ workspaceId, oid: "HEAD" })).files.map(file => file.path), ["src/a.txt"]);
    assert.match((await service.commitDiff({ workspaceId, oid: "HEAD", path: "src/a.txt" })).patch, /selected commit/);
    assert.equal(await readFile(join(project, "src/src/a.txt"), "utf8"), "other edit\n");
  } finally { service?.dispose(); await removeGitFixture(root); }
});

test("macOS short workspace aliases keep Git models usable and preserve prefix casing", async context => {
  if (!(await hasGit())) { context.skip("system Git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "omp-git-mac-alias-"));
  const project = join(root, "private", "var", "project"), shortProject = join(root, "var", "project");
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  let service: ReturnType<typeof createDesktopGitService> | undefined;
  try {
    await mkdir(join(project, "SrcCase"), { recursive: true });
    await symlink(join(root, "private", "var"), join(root, "var"), process.platform === "win32" ? "junction" : "dir");
    await execFileAsync("git", ["init", "--quiet"], { cwd: project });
    await writeFile(join(project, "SrcCase", "file.txt"), "alias edit\n");
    const rootId = (await registry.upsertByPath(project)).workspaceId as WorkspaceId;
    const nestedId = (await registry.upsertByPath(join(project, "SrcCase"))).workspaceId as WorkspaceId;
    const aliases = new Map([[rootId, shortProject], [nestedId, join(shortProject, "SrcCase")]]);
    const storedWorkspace = registry.get.bind(registry);
    // The macOS registry stores /var while realpath and Git identify /private/var.
    context.mock.method(registry, "get", (workspaceId: string) => {
      const stored = storedWorkspace(workspaceId);
      return stored ? { ...stored, canonicalPath: aliases.get(workspaceId as WorkspaceId) ?? stored.canonicalPath } : undefined;
    });
    service = createDesktopGitService({ registry, pickDirectory: async () => undefined, preferencesPath: join(root, "preferences.json") });
    for (const [workspaceId, prefix] of [[rootId, undefined], [nestedId, "SrcCase"]] as const) {
      const repository = await service.repository({ workspaceId });
      const summary = await service.summary({ workspaceId });
      assert.equal(repository.isRepository, true); assert.equal(summary.isRepository, true);
      assert.equal(repository.workspacePrefix, prefix); assert.equal(summary.workspacePrefix, prefix);
      assert.deepEqual(repository.changes.map(change => change.path), ["SrcCase/file.txt"]);
    }
  } finally { service?.dispose(); context.mock.restoreAll(); await removeGitFixture(root); }
});

test("workspace identity eviction closes native Git watchers and a revisit recreates them", async context => {
  if (!(await hasGit())) { context.skip("system Git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "omp-git-watcher-"));
  const project = join(root, "project"), registry = new WorkspaceRegistry(join(root, "registry.json"));
  const nativeWatch = fs.watch;
  let created = 0, closed = 0, peak = 0;
  let service: ReturnType<typeof createDesktopGitService> | undefined;
  try {
    await mkdir(project);
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: project });
    await git("init", "--quiet"); await git("config", "user.name", "OMP Test"); await git("config", "user.email", "omp@example.invalid");
    await writeFile(join(project, "seed.txt"), "seed\n"); await git("add", "."); await git("commit", "--quiet", "-m", "seed"); await git("pack-refs", "--all");
    context.mock.method(fs, "watch", (...args: unknown[]) => {
      const handle = Reflect.apply(nativeWatch, fs, args) as fs.FSWatcher;
      created++; peak = Math.max(peak, created - closed);
      const nativeClose = handle.close.bind(handle); let ended = false;
      handle.close = () => { if (!ended) { ended = true; closed++; } nativeClose(); };
      return handle;
    });
    syncBuiltinESMExports();
    service = createDesktopGitService({ registry, pickDirectory: async () => undefined, preferencesPath: join(root, "preferences.json") });
    const workspaces: WorkspaceId[] = [];
    for (let index = 0; index < 40; index++) {
      const path = join(project, `workspace-${index}`); await mkdir(path);
      const workspaceId = (await registry.upsertByPath(path)).workspaceId as WorkspaceId; workspaces.push(workspaceId);
      await service.repository({ workspaceId });
    }
    assert.equal(created, 120); assert.equal(created - closed, 48); assert.equal(peak, 48);
    await service.repository({ workspaceId: workspaces[39]! });
    assert.equal(created, 120);
    await service.repository({ workspaceId: workspaces[0]! });
    assert.equal(created, 123); assert.equal(created - closed, 48);
    service.dispose(); assert.equal(closed, created);
  } finally { service?.dispose(); context.mock.restoreAll(); syncBuiltinESMExports(); await removeGitFixture(root); }
});

test("DesktopGitService reports external repository changes and stays quiet for its own commands", async (context) => {
  if (!(await hasGit())) { context.skip("system Git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "omp-git-external-"));
  const project = join(root, "project");
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return predicate();
  };
  try {
    await mkdir(project);
    const stored = await registry.upsertByPath(project);
    const workspaceId = stored.workspaceId as WorkspaceId;
    const service = createDesktopGitService({
      registry,
      pickDirectory: async () => undefined,
      preferencesPath: join(root, "git-preferences.json"),
    });
    const request = (value: string) => value as CommandRequestId;
    await service.execute({ workspaceId, operation: { kind: "init" } }, request("git-init"));
    await execFileAsync("git", ["config", "user.name", "OMP Test"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "omp@example.invalid"], { cwd: project });
    await writeFile(join(project, "README.md"), "first\n", "utf8");
    await service.execute({ workspaceId, operation: { kind: "stage", paths: ["README.md"] } }, request("git-stage"));
    await service.execute({ workspaceId, operation: { kind: "commit", message: "initial commit" } }, request("git-commit"));
    await service.repository({ workspaceId });
    // Let the post-command suppression window from the commit above elapse so
    // only the external switch below can produce a notification.
    await new Promise((resolve) => setTimeout(resolve, 2_200));

    const seen: WorkspaceId[] = [];
    const unsubscribe = service.onExternalRepositoryChange((change) => seen.push(change.workspaceId));

    await execFileAsync("git", ["switch", "-c", "feature-external"], { cwd: project });
    assert.equal(await waitFor(() => seen.length > 0, 5_000), true, "external branch switch should notify");
    assert.deepEqual(seen, [workspaceId]);

    seen.length = 0;
    await service.execute({ workspaceId, operation: { kind: "branch.create", name: "via-studio" } }, request("git-branch-create"));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(seen.length, 0, "service-owned commands must not notify as external");

    unsubscribe();
    service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DesktopGitService surfaces blocked switch file lists and commits only listed paths", async (context) => {
  if (!(await hasGit())) { context.skip("system Git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "omp-git-blocked-"));
  const project = join(root, "project");
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  let service: ReturnType<typeof createDesktopGitService> | undefined;
  try {
    await mkdir(project);
    const stored = await registry.upsertByPath(project);
    const workspaceId = stored.workspaceId as WorkspaceId;
    service = createDesktopGitService({
      registry,
      pickDirectory: async () => undefined,
      preferencesPath: join(root, "git-preferences.json"),
    });
    const request = (value: string) => value as CommandRequestId;
    await service.execute({ workspaceId, operation: { kind: "init" } }, request("git-init"));
    await execFileAsync("git", ["config", "user.name", "OMP Test"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "omp@example.invalid"], { cwd: project });
    await writeFile(join(project, "README.md"), "first\n", "utf8");
    await writeFile(join(project, "NOTES.md"), "note\n", "utf8");
    await service.execute({ workspaceId, operation: { kind: "stage", paths: ["README.md", "NOTES.md"] } }, request("git-stage"));
    await service.execute({ workspaceId, operation: { kind: "commit", message: "initial commit" } }, request("git-commit"));
    const mainBranch = (await service.repository({ workspaceId })).branch!;

    // Diverge README.md on a sibling branch and add EXTRA.md there; NOTES.md
    // stays identical so only README.md (tracked) and EXTRA.md (untracked in
    // the way) block a switch from a dirty working tree.
    await execFileAsync("git", ["branch", "other"], { cwd: project });
    await execFileAsync("git", ["switch", "other"], { cwd: project });
    await writeFile(join(project, "README.md"), "other\n", "utf8");
    await writeFile(join(project, "EXTRA.md"), "extra other\n", "utf8");
    await execFileAsync("git", ["add", "README.md", "EXTRA.md"], { cwd: project });
    await execFileAsync("git", ["commit", "-m", "other branch readme"], { cwd: project });
    await execFileAsync("git", ["switch", mainBranch], { cwd: project });

    await writeFile(join(project, "README.md"), "local edit\n", "utf8");
    await writeFile(join(project, "NOTES.md"), "note local\n", "utf8");
    await writeFile(join(project, "EXTRA.md"), "extra local\n", "utf8");

    await assert.rejects(
      service.execute({ workspaceId, operation: { kind: "branch.switch", name: "other" } }, request("git-switch-blocked")),
      (error: unknown) => {
        const shaped = error as ClientError;
        assert.equal(shaped.code, "INVALID_ARGUMENT");
        assert.ok(shaped.message.startsWith("Local changes would be overwritten by checkout"));
        // Tracked conflict carries diff-vs-HEAD counts; untracked conflict counts file lines.
        assert.deepEqual(shaped.message.split("\n").slice(1), ["README.md\t1\t1", "EXTRA.md\t1\t0"]);
        return true;
      },
    );

    await assert.rejects(
      service.execute({ workspaceId, operation: { kind: "commit", message: "no amend with paths", amend: true, paths: ["README.md"] } }, request("git-commit-amend-paths")),
      (error: unknown) => (error as ClientError).code === "INVALID_ARGUMENT",
    );

    // The Renderer flow: stage the untracked blocker, then commit both listed paths.
    await service.execute({ workspaceId, operation: { kind: "stage", paths: ["EXTRA.md"] } }, request("git-stage-blocker"));
    await service.execute({ workspaceId, operation: { kind: "commit", message: "save blockers before switch", paths: ["README.md", "EXTRA.md"] } }, request("git-commit-paths"));
    const after = await service.repository({ workspaceId });
    assert.deepEqual(after.changes.map((change) => change.path), ["NOTES.md"]);

    const switched = await service.execute({ workspaceId, operation: { kind: "branch.switch", name: "other" } }, request("git-switch-after"));
    assert.equal(switched.repository?.branch, "other");
    // core.autocrlf may check blobs out with CRLF; normalize before comparing.
    assert.equal((await readFile(join(project, "README.md"), "utf8")).replaceAll("\r\n", "\n"), "other\n");
    assert.equal((await readFile(join(project, "EXTRA.md"), "utf8")).replaceAll("\r\n", "\n"), "extra other\n");
    // The unlisted local modification carries over to the new branch.
    assert.ok(switched.repository?.changes.some((change) => change.path === "NOTES.md" && change.worktree === "modified"));
  } finally {
    service?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("DesktopGitService lists a merge graph, commit files, and detaches checkout", async (context) => {
  if (!(await hasGit())) { context.skip("system Git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "omp-git-log-"));
  const project = join(root, "project");
  const upstream = join(root, "upstream.git");
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  let service: ReturnType<typeof createDesktopGitService> | undefined;
  try {
    await mkdir(project);
    const stored = await registry.upsertByPath(project);
    const workspaceId = stored.workspaceId as WorkspaceId;
    service = createDesktopGitService({
      registry,
      pickDirectory: async () => undefined,
      preferencesPath: join(root, "git-preferences.json"),
    });
    const request = (value: string) => value as CommandRequestId;
    await service.execute({ workspaceId, operation: { kind: "init" } }, request("git-init"));
    await execFileAsync("git", ["config", "user.name", "OMP Test"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "omp@example.invalid"], { cwd: project });
    await writeFile(join(project, "README.md"), "base\n", "utf8");
    await service.execute({ workspaceId, operation: { kind: "stage", paths: ["README.md"] } }, request("git-stage"));
    await service.execute({ workspaceId, operation: { kind: "commit", message: "initial commit" } }, request("git-commit"));
    await execFileAsync("git", ["init", "--bare", upstream]);
    await execFileAsync("git", ["remote", "add", "origin", upstream], { cwd: project });
    const branch = (await service.repository({ workspaceId })).branch!;
    await execFileAsync("git", ["push", "-u", "origin", branch], { cwd: project });

    await execFileAsync("git", ["switch", "-c", "feature"], { cwd: project });
    await writeFile(join(project, "FEATURE.md"), "side\n", "utf8");
    await service.execute({ workspaceId, operation: { kind: "stage", paths: ["FEATURE.md"] } }, request("git-stage-feature"));
    await service.execute({ workspaceId, operation: { kind: "commit", message: "feat: side work" } }, request("git-commit-feature"));
    await execFileAsync("git", ["switch", branch], { cwd: project });
    await execFileAsync("git", ["merge", "--no-ff", "-m", "merge: integrate feature", "feature"], { cwd: project });

    const log = await service.log({ workspaceId, limit: 20 });
    assert.equal(log.ahead, 2);
    assert.equal(log.behind, 0);
    assert.ok(log.mergeBaseOid);
    assert.equal(log.commits[0]?.relation, "head");
    assert.ok(log.commits[0]?.parents.length === 2);
    assert.ok(log.commits.some((commit) => commit.subject === "feat: side work" && commit.relation === "outgoing"));
    assert.ok(log.commits.some((commit) => commit.refs.some((ref) => ref.name === `origin/${branch}`)));

    const mergeOid = log.commits[0]!.oid;
    const changes = await service.commitChanges({ workspaceId, oid: mergeOid });
    assert.equal(changes.subject, "merge: integrate feature");
    assert.ok(changes.files.some((file) => file.path === "FEATURE.md"));
    const diff = await service.commitDiff({ workspaceId, oid: mergeOid, path: "FEATURE.md" });
    assert.match(diff.patch, /side/);

    const checked = await service.execute({ workspaceId, operation: { kind: "checkout", ref: log.commits.find((commit) => commit.subject === "initial commit")!.oid } }, request("git-checkout"));
    assert.equal(checked.repository?.detached, true);
  } finally {
    service?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
