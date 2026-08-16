import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  ClientError,
  CommandRequestId,
  GitBranchListReadModel,
  GitBranchRecord,
  GitDiffReadModel,
  GitExecuteInput,
  GitFileChange,
  GitFileState,
  GitOperation,
  GitOperationResult,
  GitRemoteListReadModel,
  GitRemoteRecord,
  GitRepositoryId,
  GitRepositoryReadModel,
  GitToolchainReadModel,
  GitWorktreeId,
  GitWorktreeListReadModel,
  GitWorktreeRecord,
  OperationProgress,
  WorkspaceId,
} from "@omp-studio/client-contract";
import type { HostGitService } from "@omp-studio/host-client-api";
import type { StoredWorkspace, WorkspaceRegistry } from "@omp-studio/studio-host";

import { GitWriteQueue, HostProcessError, HostProcessRunner } from "./git-process.js";

const DIFF_LIMIT = 2 * 1024 * 1024;
const READ_TIMEOUT = 60_000;
const WRITE_TIMEOUT = 60_000;
const NETWORK_TIMEOUT = 120_000;

interface RepositoryIdentity {
  readonly cwd: string;
  readonly topLevel: string;
  readonly commonDir: string;
  readonly gitDir: string;
  readonly repositoryId: GitRepositoryId;
  readonly worktreeId: GitWorktreeId;
}

interface GitPreferencesFile {
  readonly version: 1;
  readonly worktreeRoots: Readonly<Record<string, string>>;
}

interface GitServiceOptions {
  readonly registry: WorkspaceRegistry;
  readonly pickDirectory: () => Promise<string | undefined>;
  readonly preferencesPath: string;
  readonly runner?: HostProcessRunner;
  readonly queue?: GitWriteQueue;
}

function clientError(code: ClientError["code"], message: string): ClientError {
  return { code, message };
}

function opaqueId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function trimLine(value: string): string {
  return value.replace(/[\r\n]+$/u, "");
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
    throw clientError("INVALID_ARGUMENT", "Git path must be repository-relative");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw clientError("INVALID_ARGUMENT", "Git path escapes the repository");
  }
  return parts.join("/");
}

function assertRef(value: string): string {
  if (!value || value.startsWith("-") || /[\0\r\n]/u.test(value)) {
    throw clientError("INVALID_ARGUMENT", "Invalid Git ref");
  }
  return value;
}

function sanitizeDirectoryName(value: string): string {
  const slug = value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!slug || slug === "." || slug === "..") throw clientError("INVALID_ARGUMENT", "Invalid directory name");
  return slug.slice(0, 120);
}

function resolveGitPath(cwd: string, raw: string): string {
  const value = trimLine(raw);
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch { return resolve(path); }
}

function displayError(error: unknown, cwd?: string): ClientError {
  if (error !== null && typeof error === "object" && "code" in error && "message" in error) {
    const shaped = error as ClientError;
    if (typeof shaped.code === "string" && typeof shaped.message === "string") return shaped;
  }
  const raw = error instanceof Error ? error.message : "Git operation failed";
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || /spawn git ENOENT/iu.test(raw)) {
    return clientError("CAPABILITY_UNAVAILABLE", "Git is not installed or is not available on PATH");
  }
  if (error instanceof HostProcessError && error.kind === "cancelled") {
    return clientError("UNAVAILABLE", "Operation cancelled");
  }
  if (error instanceof HostProcessError && error.kind === "timeout") {
    return clientError("UNAVAILABLE", "Git operation timed out");
  }
  const withoutCwd = cwd === undefined ? raw : raw.replaceAll(cwd, "[workspace]").replaceAll(cwd.replaceAll("\\", "/"), "[workspace]");
  const redacted = withoutCwd
    .replace(/https?:\/\/[^\s/@]+@/giu, "https://[redacted]@")
    .replace(/\b(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]+\b/gu, "[redacted]")
    .replace(/\b[A-Za-z]:[\\/][^\s'"<>]+/gu, "[path]")
    .replace(/(?:\/Users|\/home|\/mnt|\/tmp|\/var|\/private|\/Volumes)\/[^\s'"<>]+/gu, "[path]");
  if (/authentication failed|could not read username|permission denied \(publickey\)|not logged/iu.test(redacted)) {
    return clientError("CAPABILITY_UNAVAILABLE", "Git authentication is required; sign in with the system credential manager or GitHub CLI");
  }
  if (/not a git repository/iu.test(redacted)) return clientError("INVALID_ARGUMENT", "The selected workspace is not a Git repository");
  if (/conflict|would be overwritten|local changes|index\.lock/iu.test(redacted)) return clientError("INVALID_ARGUMENT", redacted.slice(-2_000));
  return clientError("INTERNAL_ERROR", redacted.slice(-2_000));
}

function stateFor(code: string): GitFileState {
  switch (code) {
    case ".": return "unmodified";
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "U": return "conflicted";
    case "?": return "untracked";
    default: return "modified";
  }
}

function splitStatusFields(record: string, fixed: number): { fields: string[]; path: string } {
  const fields: string[] = [];
  let rest = record;
  for (let index = 0; index < fixed; index += 1) {
    const boundary = rest.indexOf(" ");
    if (boundary < 0) return { fields, path: "" };
    fields.push(rest.slice(0, boundary));
    rest = rest.slice(boundary + 1);
  }
  return { fields, path: rest };
}

function parseStatus(stdout: string): {
  branch?: string;
  headOid?: string;
  detached: boolean;
  unborn: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  stashCount: number;
  changes: GitFileChange[];
} {
  const records = stdout.split("\0");
  let branch: string | undefined;
  let headOid: string | undefined;
  let detached = false;
  let unborn = false;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let stashCount = 0;
  const changes: GitFileChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice(13);
      unborn = oid === "(initial)";
      if (!unborn) headOid = oid;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const value = record.slice(14);
      detached = value === "(detached)";
      if (!detached) branch = value;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) { upstream = record.slice(18); continue; }
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
      continue;
    }
    if (record.startsWith("# stash ")) { stashCount = Number(record.slice(8)) || 0; continue; }
    if (record.startsWith("? ")) {
      changes.push({ path: normalizeRelativePath(record.slice(2)), index: "unmodified", worktree: "untracked", conflicted: false });
      continue;
    }
    if (record.startsWith("1 ")) {
      const parsed = splitStatusFields(record, 8);
      const xy = parsed.fields[1] ?? "..";
      changes.push({ path: normalizeRelativePath(parsed.path), index: stateFor(xy[0] ?? "."), worktree: stateFor(xy[1] ?? "."), conflicted: xy.includes("U") });
      continue;
    }
    if (record.startsWith("2 ")) {
      const parsed = splitStatusFields(record, 9);
      const xy = parsed.fields[1] ?? "..";
      const originalPath = records[index + 1];
      if (originalPath !== undefined) index += 1;
      changes.push({
        path: normalizeRelativePath(parsed.path),
        ...(originalPath ? { originalPath: normalizeRelativePath(originalPath) } : {}),
        index: stateFor(xy[0] ?? "."),
        worktree: stateFor(xy[1] ?? "."),
        conflicted: xy.includes("U"),
      });
      continue;
    }
    if (record.startsWith("u ")) {
      const parsed = splitStatusFields(record, 10);
      changes.push({ path: normalizeRelativePath(parsed.path), index: "conflicted", worktree: "conflicted", conflicted: true });
    }
  }
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(headOid === undefined ? {} : { headOid }),
    detached,
    unborn,
    ...(upstream === undefined ? {} : { upstream }),
    ahead,
    behind,
    stashCount,
    changes,
  };
}

function safeRemoteUrl(raw: string): { display: string; host?: string; repository?: string } {
  const value = trimLine(raw);
  const scp = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/u.exec(value);
  if (scp && !value.includes("://") && !/^[A-Za-z]:/u.test(value)) {
    const path = scp[2]!.replace(/\.git$/u, "");
    return { display: `ssh://${scp[1]}/${path}`, ...(scp[1] === undefined ? {} : { host: scp[1] }), repository: path };
  }
  try {
    const url = new URL(value);
    if (!url.hostname || (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:" && url.protocol !== "git:")) {
      return { display: "[local repository]" };
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const repository = url.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
    return { display: url.toString().replace(/\/$/u, ""), host: url.hostname, repository };
  } catch {
    return { display: "[local repository]" };
  }
}

class GitPreferencesStore {
  #loaded = false;
  #roots: Record<string, string> = {};
  constructor(readonly path: string) {}

  async get(repositoryId: GitRepositoryId): Promise<string | undefined> {
    await this.#load();
    return this.#roots[repositoryId];
  }

  async set(repositoryId: GitRepositoryId, root: string): Promise<void> {
    await this.#load();
    this.#roots[repositoryId] = root;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    const value: GitPreferencesFile = { version: 1, worktreeRoots: this.#roots };
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.path);
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<GitPreferencesFile>;
      if (parsed.version === 1 && parsed.worktreeRoots !== null && typeof parsed.worktreeRoots === "object") {
        this.#roots = Object.fromEntries(Object.entries(parsed.worktreeRoots).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class DesktopGitService implements HostGitService {
  readonly #runner: HostProcessRunner;
  readonly #queue: GitWriteQueue;
  readonly #preferences: GitPreferencesStore;

  constructor(readonly options: GitServiceOptions) {
    this.#runner = options.runner ?? new HostProcessRunner();
    this.#queue = options.queue ?? new GitWriteQueue();
    this.#preferences = new GitPreferencesStore(options.preferencesPath);
  }

  onProgress(listener: (progress: OperationProgress) => void): () => void {
    return this.#runner.onProgress((progress) => { if (progress.domain === "git") listener(progress); });
  }
  cancelAll(): void { this.#runner.cancelAll(); }

  async toolchain(): Promise<GitToolchainReadModel> {
    const probe = async (command: string) => {
      try {
        const result = await this.#runner.run({ command, args: ["--version"], readOnly: true, timeoutMs: 8_000 });
        const version = trimLine(result.stdout).split(/\r?\n/u)[0];
        return { available: true, ...(version === undefined ? {} : { version }) } as const;
      } catch (error) {
        return { available: false, unavailableReason: error instanceof Error ? error.message.slice(0, 240) : `${command} is unavailable` } as const;
      }
    };
    return { git: await probe("git"), githubCli: await probe("gh") };
  }

  #workspace(workspaceId: WorkspaceId): StoredWorkspace {
    const workspace = this.options.registry.get(workspaceId);
    if (workspace === undefined) throw clientError("INVALID_ARGUMENT", "Unknown workspace id");
    return workspace;
  }

  async #git(cwd: string, args: ReadonlyArray<string>, options: { requestId?: CommandRequestId; stdin?: string; timeoutMs?: number; outputLimit?: number; readOnly?: boolean; phase?: string } = {}) {
    try {
      return await this.#runner.run({ command: "git", args, cwd, ...options, domain: "git" });
    } catch (error) {
      throw displayError(error, cwd);
    }
  }

  async #identity(workspaceId: WorkspaceId): Promise<RepositoryIdentity> {
    const workspace = this.#workspace(workspaceId);
    const cwd = workspace.canonicalPath;
    const [top, common, gitDir] = await Promise.all([
      this.#git(cwd, ["rev-parse", "--show-toplevel"], { readOnly: true }),
      this.#git(cwd, ["rev-parse", "--git-common-dir"], { readOnly: true }),
      this.#git(cwd, ["rev-parse", "--git-dir"], { readOnly: true }),
    ]);
    const topLevel = await canonicalPath(resolveGitPath(cwd, top.stdout));
    const commonDir = await canonicalPath(resolveGitPath(cwd, common.stdout));
    const resolvedGitDir = await canonicalPath(resolveGitPath(cwd, gitDir.stdout));
    return {
      cwd,
      topLevel,
      commonDir,
      gitDir: resolvedGitDir,
      repositoryId: opaqueId("repo", commonDir) as GitRepositoryId,
      worktreeId: opaqueId("wt", topLevel) as GitWorktreeId,
    };
  }

  async repository(input: { readonly workspaceId: WorkspaceId }): Promise<GitRepositoryReadModel> {
    const workspace = this.#workspace(input.workspaceId);
    try {
      const identity = await this.#identity(input.workspaceId);
      const result = await this.#git(identity.cwd, ["status", "--porcelain=v2", "--branch", "--show-stash", "--untracked-files=all", "-z"], { readOnly: true, timeoutMs: READ_TIMEOUT, outputLimit: 16 * 1024 * 1024 });
      const parsed = parseStatus(result.stdout);
      const operation = await this.#operation(identity);
      const revision = await this.#repositoryRevision(identity, result.stdout, parsed.changes, operation);
      return {
        workspaceId: input.workspaceId,
        isRepository: true,
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
        ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
        ...(parsed.headOid === undefined ? {} : { headOid: parsed.headOid }),
        detached: parsed.detached,
        unborn: parsed.unborn,
        ...(parsed.upstream === undefined ? {} : { upstream: parsed.upstream }),
        ahead: parsed.ahead,
        behind: parsed.behind,
        stashCount: parsed.stashCount,
        ...(operation === undefined ? {} : { operation }),
        changes: parsed.changes,
        revision,
      };
    } catch (error) {
      const mapped = displayError(error, workspace.canonicalPath);
      if (mapped.code === "INVALID_ARGUMENT" || mapped.code === "CAPABILITY_UNAVAILABLE" || mapped.code === "UNAVAILABLE") {
        return { workspaceId: input.workspaceId, isRepository: false, detached: false, unborn: false, ahead: 0, behind: 0, stashCount: 0, changes: [], unavailableReason: mapped.message };
      }
      throw mapped;
    }
  }

  async #operation(identity: RepositoryIdentity): Promise<GitRepositoryReadModel["operation"] | undefined> {
    const exists = async (path: string) => { try { await lstat(path); return true; } catch { return false; } };
    if (await exists(join(identity.gitDir, "MERGE_HEAD"))) return "merge";
    if (await exists(join(identity.commonDir, "rebase-merge")) || await exists(join(identity.commonDir, "rebase-apply"))) return "rebase";
    if (await exists(join(identity.gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
    if (await exists(join(identity.gitDir, "REVERT_HEAD"))) return "revert";
    return undefined;
  }

  async #repositoryRevision(
    identity: RepositoryIdentity,
    status: string,
    changes: ReadonlyArray<GitFileChange>,
    operation: GitRepositoryReadModel["operation"] | undefined,
  ): Promise<string> {
    const hash = createHash("sha256").update(status).update(`\0operation:${operation ?? "none"}`);
    const paths = [...new Set(changes.flatMap((change) => [change.path, ...(change.originalPath === undefined ? [] : [change.originalPath])]))].sort();
    for (const path of paths) {
      const target = resolve(identity.topLevel, ...path.split("/"));
      const escaped = relative(identity.topLevel, target);
      if (escaped === ".." || escaped.startsWith(`..${sep}`)) continue;
      try {
        const stat = await lstat(target, { bigint: true });
        hash.update(`\0${path}\0${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") hash.update(`\0${path}\0missing`);
        else throw error;
      }
    }
    try {
      const index = await lstat(join(identity.gitDir, "index"), { bigint: true });
      hash.update(`\0index:${index.size}:${index.mtimeNs}:${index.ctimeNs}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return `rev_${hash.digest("hex").slice(0, 24)}`;
  }

  async diff(input: { readonly workspaceId: WorkspaceId; readonly path: string; readonly target: "working" | "staged" }): Promise<GitDiffReadModel> {
    const identity = await this.#identity(input.workspaceId);
    const path = normalizeRelativePath(input.path);
    const args = ["diff", "--no-ext-diff", "--no-color", "--unified=3", ...(input.target === "staged" ? ["--cached"] : []), "--", path];
    const result = await this.#git(identity.cwd, args, { readOnly: true, outputLimit: DIFF_LIMIT + 1 });
    const patch = result.stdout.slice(0, DIFF_LIMIT);
    return { workspaceId: input.workspaceId, path, target: input.target, patch, binary: /Binary files|GIT binary patch/u.test(patch), truncated: result.stdout.length > DIFF_LIMIT, revision: opaqueId("rev", result.stdout) };
  }

  async branches(input: { readonly workspaceId: WorkspaceId }): Promise<GitBranchListReadModel> {
    const identity = await this.#identity(input.workspaceId);
    const worktrees = await this.worktrees(input);
    const worktreeByBranch = new Map(worktrees.worktrees.filter((entry) => entry.branch !== undefined).map((entry) => [entry.branch!, entry.worktreeId]));
    const format = "%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)";
    const result = await this.#git(identity.cwd, ["for-each-ref", `--format=${format}`, "refs/heads", "refs/remotes"], { readOnly: true });
    const branches: GitBranchRecord[] = [];
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (!line) continue;
      const [full = "", name = "", headOid = "", upstream = "", track = "", head = ""] = line.split("\0");
      if (!name || full.endsWith("/HEAD")) continue;
      const ahead = /ahead (\d+)/u.exec(track)?.[1];
      const behind = /behind (\d+)/u.exec(track)?.[1];
      branches.push({
        name,
        remote: full.startsWith("refs/remotes/"),
        current: head === "*",
        headOid,
        ...(upstream ? { upstream } : {}),
        ahead: ahead === undefined ? 0 : Number(ahead),
        behind: behind === undefined ? 0 : Number(behind),
        ...(worktreeByBranch.get(name) === undefined ? {} : { checkedOutWorktreeId: worktreeByBranch.get(name)! }),
      });
    }
    return { workspaceId: input.workspaceId, branches };
  }

  async #worktreeEntries(identity: RepositoryIdentity): Promise<Array<GitWorktreeRecord & { internalPath: string }>> {
    const result = await this.#git(identity.cwd, ["worktree", "list", "--porcelain", "-z"], { readOnly: true });
    const records = result.stdout.split("\0");
    const output: Array<GitWorktreeRecord & { internalPath: string }> = [];
    let current: Record<string, string | true> = {};
    const flush = () => {
      const path = current.worktree;
      if (typeof path !== "string") { current = {}; return; }
      let canonical = resolve(path);
      try { canonical = realpathSync(canonical); } catch { /* keep normalized path for prunable entries */ }
      const branchValue = typeof current.branch === "string" ? current.branch.replace(/^refs\/heads\//u, "") : undefined;
      const worktreeId = opaqueId("wt", canonical) as GitWorktreeId;
      const workspace = this.options.registry.list().find((entry) => (process.platform === "win32" ? entry.canonicalPath.toLowerCase() === canonical.toLowerCase() : entry.canonicalPath === canonical));
      output.push({
        worktreeId,
        name: basename(canonical),
        ...(branchValue === undefined ? {} : { branch: branchValue }),
        ...(typeof current.HEAD === "string" ? { headOid: current.HEAD } : {}),
        current: worktreeId === identity.worktreeId,
        detached: current.detached === true,
        bare: current.bare === true,
        locked: current.locked !== undefined,
        ...(typeof current.locked === "string" ? { lockReason: current.locked } : {}),
        prunable: current.prunable !== undefined,
        ...(workspace === undefined ? {} : { workspaceId: workspace.workspaceId as WorkspaceId }),
        internalPath: canonical,
      });
      current = {};
    };
    for (const record of records) {
      if (!record) { flush(); continue; }
      const boundary = record.indexOf(" ");
      const key = boundary < 0 ? record : record.slice(0, boundary);
      const value = boundary < 0 ? true : record.slice(boundary + 1);
      if (key === "worktree" && current.worktree !== undefined) flush();
      current[key] = value;
    }
    flush();
    return output;
  }

  async worktrees(input: { readonly workspaceId: WorkspaceId }): Promise<GitWorktreeListReadModel> {
    const identity = await this.#identity(input.workspaceId);
    const entries = await this.#worktreeEntries(identity);
    const root = await this.#preferences.get(identity.repositoryId);
    return { workspaceId: input.workspaceId, rootConfigured: root !== undefined, worktrees: entries.map(({ internalPath: _internalPath, ...entry }) => entry) };
  }

  async remotes(input: { readonly workspaceId: WorkspaceId }): Promise<GitRemoteListReadModel> {
    const identity = await this.#identity(input.workspaceId);
    const names = (await this.#git(identity.cwd, ["remote"], { readOnly: true })).stdout.split(/\r?\n/u).filter(Boolean);
    const remotes: GitRemoteRecord[] = [];
    for (const name of names) {
      const fetch = safeRemoteUrl((await this.#git(identity.cwd, ["remote", "get-url", name], { readOnly: true })).stdout);
      const push = safeRemoteUrl((await this.#git(identity.cwd, ["remote", "get-url", "--push", name], { readOnly: true })).stdout);
      remotes.push({ name, fetchUrl: fetch.display, pushUrl: push.display, ...(fetch.host === undefined ? {} : { host: fetch.host }), ...(fetch.repository === undefined ? {} : { repository: fetch.repository }) });
    }
    return { workspaceId: input.workspaceId, remotes };
  }

  async #assertRevision(workspaceId: WorkspaceId, expected: string): Promise<void> {
    const current = await this.repository({ workspaceId });
    if (current.revision !== expected) throw clientError("STATE_VERSION_CONFLICT", "Repository state changed; review the operation again");
  }

  async execute(input: GitExecuteInput, requestId: CommandRequestId): Promise<GitOperationResult> {
    const operation = input.operation;
    if (operation.kind === "cancel") {
      const cancelled = this.#runner.cancel(operation.requestId);
      return { operation: operation.kind, message: cancelled ? "Operation cancelled" : "Operation is no longer running" };
    }
    this.#runner.track(requestId);
    try {
      if (operation.kind === "clone") return await this.#clone(operation, requestId);
      if (input.workspaceId === undefined) throw clientError("INVALID_ARGUMENT", "workspaceId is required for this Git operation");
      if (operation.kind === "init") {
        const workspace = this.#workspace(input.workspaceId);
        await this.#git(workspace.canonicalPath, ["init"], { requestId, timeoutMs: WRITE_TIMEOUT, phase: "initializing" });
        return { operation: operation.kind, message: "Repository initialized", repository: await this.repository({ workspaceId: input.workspaceId }), workspaceId: input.workspaceId };
      }
      const identity = await this.#identity(input.workspaceId);
      return await this.#queue.run(identity.commonDir, async () => {
        this.#runner.assertNotCancelled(requestId);
        return this.#executeQueued(identity, input.workspaceId!, operation, requestId);
      });
    } finally {
      this.#runner.untrack(requestId);
    }
  }

  async #clone(operation: Extract<GitOperation, { kind: "clone" }>, requestId: CommandRequestId): Promise<GitOperationResult> {
    const parent = await this.options.pickDirectory();
    if (parent === undefined) throw clientError("UNAVAILABLE", "Clone destination selection was cancelled");
    const guessed = operation.directoryName ?? operation.url.replace(/[\\/]$/u, "").split(/[\\/:]/u).pop()?.replace(/\.git$/u, "") ?? "repository";
    const name = sanitizeDirectoryName(guessed);
    const target = resolve(parent, name);
    const escaped = relative(parent, target);
    if (escaped === ".." || escaped.startsWith(`..${sep}`)) throw clientError("INVALID_ARGUMENT", "Clone destination escapes the selected directory");
    try {
      await this.#runner.run({ command: "git", args: ["clone", "--", operation.url, target], cwd: parent, requestId, domain: "git", phase: "cloning", timeoutMs: NETWORK_TIMEOUT, outputLimit: 16 * 1024 * 1024 });
    } catch (error) {
      throw displayError(error, parent);
    }
    const stored = await this.options.registry.upsertByPath(target);
    const workspaceId = stored.workspaceId as WorkspaceId;
    return { operation: operation.kind, message: "Repository cloned", createdWorkspaceId: workspaceId, workspaceId, repository: await this.repository({ workspaceId }) };
  }

  async #executeQueued(identity: RepositoryIdentity, workspaceId: WorkspaceId, operation: GitOperation, requestId: CommandRequestId): Promise<GitOperationResult> {
    let args: string[] = [];
    let stdin: string | undefined;
    let timeoutMs = WRITE_TIMEOUT;
    let createdWorkspaceId: WorkspaceId | undefined;
    switch (operation.kind) {
      case "stage": args = ["add", "--", ...operation.paths.map(normalizeRelativePath)]; break;
      case "unstage": {
        const paths = operation.paths.map(normalizeRelativePath);
        const current = await this.repository({ workspaceId });
        args = current.unborn
          ? ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...paths]
          : ["restore", "--staged", "--", ...paths];
        break;
      }
      case "discard": {
        const current = await this.repository({ workspaceId });
        if (current.revision !== operation.expectedRevision) throw clientError("STATE_VERSION_CONFLICT", "Repository state changed; review the operation again");
        const paths = operation.paths.map(normalizeRelativePath);
        const untrackedPaths = new Set(current.changes.filter((change) => change.worktree === "untracked").map((change) => change.path));
        const untracked = paths.filter((path) => untrackedPaths.has(path));
        const tracked = paths.filter((path) => !untrackedPaths.has(path));
        if (tracked.length > 0) await this.#git(identity.cwd, ["restore", "--worktree", "--", ...tracked], { requestId, timeoutMs, phase: operation.kind });
        if (untracked.length > 0) await this.#git(identity.cwd, ["clean", "-f", "--", ...untracked], { requestId, timeoutMs, phase: operation.kind });
        return { operation: operation.kind, message: `${operation.kind} completed`, workspaceId, repository: await this.repository({ workspaceId }) };
      }
      case "commit": args = ["commit", "-F", "-", ...(operation.amend ? ["--amend"] : []), ...(operation.sign ? ["--gpg-sign"] : [])]; stdin = operation.message; break;
      case "branch.create": args = operation.checkout ? ["switch", "-c", assertRef(operation.name), ...(operation.startPoint ? [assertRef(operation.startPoint)] : [])] : ["branch", assertRef(operation.name), ...(operation.startPoint ? [assertRef(operation.startPoint)] : [])]; break;
      case "branch.switch": args = ["switch", assertRef(operation.name)]; break;
      case "branch.rename": args = ["branch", "-m", ...(operation.oldName ? [assertRef(operation.oldName)] : []), assertRef(operation.newName)]; break;
      case "branch.delete": if (operation.force) { if (!operation.expectedRevision) throw clientError("INVALID_ARGUMENT", "Force delete requires a reviewed repository revision"); await this.#assertRevision(workspaceId, operation.expectedRevision); } args = ["branch", operation.force ? "-D" : "-d", assertRef(operation.name)]; break;
      case "worktree.pickRoot": {
        const root = await this.options.pickDirectory();
        if (root === undefined) throw clientError("UNAVAILABLE", "Worktree root selection was cancelled");
        const canonical = await canonicalPath(root);
        const inside = relative(identity.topLevel, canonical);
        if (!inside.startsWith("..") && !isAbsolute(inside)) throw clientError("INVALID_ARGUMENT", "Worktree root must be outside the current worktree");
        await this.#preferences.set(identity.repositoryId, canonical);
        return { operation: operation.kind, message: "Worktree root saved", workspaceId, repository: await this.repository({ workspaceId }) };
      }
      case "worktree.create": {
        const root = await this.#preferences.get(identity.repositoryId);
        if (root === undefined) throw clientError("INVALID_ARGUMENT", "Choose a Worktree root directory first");
        const name = sanitizeDirectoryName(operation.directoryName ?? operation.branch);
        const target = resolve(root, name);
        const escaped = relative(root, target);
        if (escaped === ".." || escaped.startsWith(`..${sep}`)) throw clientError("INVALID_ARGUMENT", "Worktree destination escapes the configured root");
        args = ["worktree", "add", ...(operation.createBranch ? ["-b", assertRef(operation.branch)] : []), target, ...(operation.createBranch ? (operation.startPoint ? [assertRef(operation.startPoint)] : []) : [assertRef(operation.branch)])];
        await this.#git(identity.cwd, args, { requestId, timeoutMs: WRITE_TIMEOUT, phase: "creating-worktree" });
        const stored = await this.options.registry.upsertByPath(target);
        createdWorkspaceId = stored.workspaceId as WorkspaceId;
        return { operation: operation.kind, message: "Worktree created", workspaceId, createdWorkspaceId, repository: await this.repository({ workspaceId }) };
      }
      case "worktree.lock": { const target = await this.#resolveWorktree(identity, operation.worktreeId); args = ["worktree", "lock", ...(operation.reason ? ["--reason", operation.reason] : []), target]; break; }
      case "worktree.unlock": { const target = await this.#resolveWorktree(identity, operation.worktreeId); args = ["worktree", "unlock", target]; break; }
      case "worktree.remove": { if (operation.force) { if (!operation.expectedRevision) throw clientError("INVALID_ARGUMENT", "Force removal requires a reviewed repository revision"); await this.#assertRevision(workspaceId, operation.expectedRevision); } const target = await this.#resolveWorktree(identity, operation.worktreeId); args = ["worktree", "remove", ...(operation.force ? ["--force"] : []), target]; break; }
      case "worktree.prune": args = ["worktree", "prune", ...(operation.dryRun ? ["--dry-run"] : [])]; break;
      case "remote.add": args = ["remote", "add", assertRef(operation.name), operation.url]; break;
      case "remote.setUrl": args = ["remote", "set-url", ...(operation.push ? ["--push"] : []), assertRef(operation.name), operation.url]; break;
      case "remote.remove": args = ["remote", "remove", assertRef(operation.name)]; break;
      case "fetch": args = ["fetch", ...(operation.prune ? ["--prune"] : []), ...(operation.remote ? [assertRef(operation.remote)] : [])]; timeoutMs = NETWORK_TIMEOUT; break;
      case "pull": args = ["pull", operation.strategy === "ff-only" ? "--ff-only" : operation.strategy === "rebase" ? "--rebase" : "--no-rebase", ...(operation.remote ? [assertRef(operation.remote)] : []), ...(operation.branch ? [assertRef(operation.branch)] : [])]; timeoutMs = NETWORK_TIMEOUT; break;
      case "push": {
        if (operation.forceWithLease && !operation.expectedRemoteOid) throw clientError("INVALID_ARGUMENT", "Force-with-lease requires the reviewed remote commit id");
        args = ["push", ...(operation.setUpstream ? ["--set-upstream"] : []), ...(operation.forceWithLease ? [`--force-with-lease=${assertRef(operation.branch ?? "HEAD")}:${assertRef(operation.expectedRemoteOid!)}`] : []), ...(operation.remote ? [assertRef(operation.remote)] : []), ...(operation.branch ? [assertRef(operation.branch)] : [])];
        timeoutMs = NETWORK_TIMEOUT;
        break;
      }
      case "stash.push": args = ["stash", "push", ...(operation.includeUntracked ? ["--include-untracked"] : []), ...(operation.message ? ["-m", operation.message] : [])]; break;
      case "stash.apply": args = ["stash", operation.pop ? "pop" : "apply", ...(operation.stash ? [assertRef(operation.stash)] : [])]; break;
      case "stash.drop": await this.#assertRevision(workspaceId, operation.expectedRevision); args = ["stash", "drop", assertRef(operation.stash)]; break;
      case "tag.create": args = ["tag", ...(operation.message ? ["-a", "-F", "-"] : []), assertRef(operation.name), ...(operation.target ? [assertRef(operation.target)] : [])]; stdin = operation.message; break;
      case "tag.delete": args = ["tag", "-d", assertRef(operation.name)]; break;
      case "merge": args = ["merge", ...(operation.noFastForward ? ["--no-ff"] : []), assertRef(operation.ref)]; break;
      case "rebase": args = ["rebase", assertRef(operation.ref)]; break;
      case "cherry-pick": args = ["cherry-pick", assertRef(operation.ref)]; break;
      case "revert": args = ["revert", "--no-edit", assertRef(operation.ref)]; break;
      case "reset": await this.#assertRevision(workspaceId, operation.expectedRevision); args = ["reset", `--${operation.mode}`, assertRef(operation.ref)]; break;
      case "continue": args = [operation.operation, "--continue"]; break;
      case "abort": args = [operation.operation, "--abort"]; break;
      case "init":
      case "clone":
      case "cancel": throw clientError("INVALID_ARGUMENT", "Operation is not valid in this context");
    }
    await this.#git(identity.cwd, args, { requestId, ...(stdin === undefined ? {} : { stdin }), timeoutMs, phase: operation.kind });
    return { operation: operation.kind, message: `${operation.kind} completed`, workspaceId, ...(createdWorkspaceId === undefined ? {} : { createdWorkspaceId }), repository: await this.repository({ workspaceId }) };
  }

  async #resolveWorktree(identity: RepositoryIdentity, worktreeId: GitWorktreeId): Promise<string> {
    const entry = (await this.#worktreeEntries(identity)).find((item) => item.worktreeId === worktreeId);
    if (entry === undefined) throw clientError("INVALID_ARGUMENT", "Unknown Worktree id");
    return entry.internalPath;
  }
}

export function createDesktopGitService(options: GitServiceOptions): DesktopGitService {
  return new DesktopGitService(options);
}
