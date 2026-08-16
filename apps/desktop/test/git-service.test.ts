import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const closeComment = runner.calls.find((call) => call.command === "gh" && call.args[0] === "api");
    assert.ok(closeComment);
    assert.equal(closeComment.stdin, JSON.stringify({ body: "close reason" }));
    assert.ok(!closeComment.args.join(" ").includes("close reason"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DesktopGitService performs real repository, branch, worktree and safety flows", async (context) => {
  if (!(await hasGit())) { context.skip("system Git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "omp-git-service-"));
  const project = join(root, "project");
  const worktreeRoot = join(root, "worktrees");
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  try {
    await mkdir(project);
    await mkdir(worktreeRoot);
    const stored = await registry.upsertByPath(project);
    const workspaceId = stored.workspaceId as WorkspaceId;
    const service = createDesktopGitService({
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
    await rm(root, { recursive: true, force: true });
  }
});
