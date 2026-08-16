import type {
  ClientError,
  CommandRequestId,
  GitHubAuthReadModel,
  GitHubCheckRecord,
  GitHubChecksReadModel,
  GitHubExecuteInput,
  GitHubOperation,
  GitHubOperationResult,
  GitHubPullRequestDetailReadModel,
  GitHubPullRequestListReadModel,
  GitHubPullRequestRecord,
  OperationProgress,
  WorkspaceId,
} from "@omp-studio/client-contract";
import type { HostGitHubService } from "@omp-studio/host-client-api";
import type { WorkspaceRegistry } from "@omp-studio/studio-host";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { GitWriteQueue, HostProcessError, HostProcessRunner } from "./git-process.js";

const GH_TIMEOUT = 120_000;
const PR_FIELDS = "number,title,body,state,isDraft,headRefName,baseRefName,headRefOid,author,url,reviewDecision,mergeStateStatus,additions,deletions,changedFiles,updatedAt";

interface GithubServiceOptions {
  readonly registry: WorkspaceRegistry;
  readonly runner?: HostProcessRunner;
  readonly queue?: GitWriteQueue;
}

interface GithubRepository {
  readonly cwd: string;
  readonly host: string;
  readonly ownerRepo: string;
  readonly commonDir: string;
}

function clientError(code: ClientError["code"], message: string): ClientError { return { code, message }; }

function safeMessage(error: unknown, cwd?: string): ClientError {
  if (error !== null && typeof error === "object" && "code" in error && "message" in error) return error as ClientError;
  const raw = error instanceof Error ? error.message : "GitHub operation failed";
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || /spawn gh ENOENT/iu.test(raw)) return clientError("CAPABILITY_UNAVAILABLE", "GitHub CLI is not installed or is not available on PATH");
  if (error instanceof HostProcessError && error.kind === "cancelled") return clientError("UNAVAILABLE", "Operation cancelled");
  if (error instanceof HostProcessError && error.kind === "timeout") return clientError("UNAVAILABLE", "GitHub operation timed out");
  const withoutCwd = cwd === undefined ? raw : raw.replaceAll(cwd, "[workspace]").replaceAll(cwd.replaceAll("\\", "/"), "[workspace]");
  const redacted = withoutCwd.replace(/https?:\/\/[^\s/@]+@/giu, "https://[redacted]@").replace(/\b(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]+\b/gu, "[redacted]").replace(/\b[A-Za-z]:[\\/][^\s'"<>]+/gu, "[path]").replace(/(?:\/Users|\/home|\/mnt|\/tmp|\/var|\/private|\/Volumes)\/[^\s'"<>]+/gu, "[path]");
  if (/not logged|authentication|HTTP 401|HTTP 403/iu.test(redacted)) return clientError("CAPABILITY_UNAVAILABLE", "GitHub CLI authentication is required");
  return clientError("INTERNAL_ERROR", redacted.slice(-2_000));
}

function parseRemote(raw: string): { host: string; ownerRepo: string } | undefined {
  const value = raw.trim();
  const scp = /^(?:[^@\s]+@)?([^:\s]+):([^\s]+)$/u.exec(value);
  if (scp && !value.includes("://") && !/^[A-Za-z]:/u.test(value)) return { host: scp[1]!, ownerRepo: scp[2]!.replace(/^\//u, "").replace(/\.git$/u, "") };
  try {
    const url = new URL(value);
    return { host: url.hostname, ownerRepo: url.pathname.replace(/^\//u, "").replace(/\.git$/u, "") };
  } catch { return undefined; }
}

function pullRequest(value: unknown): GitHubPullRequestRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw clientError("INTERNAL_ERROR", "GitHub CLI returned an invalid pull request");
  const row = value as Record<string, unknown>;
  const stateValue = typeof row.state === "string" ? row.state.toLowerCase() : "open";
  const state = stateValue === "merged" ? "merged" : stateValue === "closed" ? "closed" : "open";
  const author = row.author !== null && typeof row.author === "object" && !Array.isArray(row.author) ? (row.author as Record<string, unknown>).login : undefined;
  return {
    number: Number(row.number),
    title: typeof row.title === "string" ? row.title : "Untitled pull request",
    ...(typeof row.body === "string" ? { body: row.body } : {}),
    state,
    draft: row.isDraft === true,
    headBranch: typeof row.headRefName === "string" ? row.headRefName : "",
    baseBranch: typeof row.baseRefName === "string" ? row.baseRefName : "",
    ...(typeof row.headRefOid === "string" ? { headOid: row.headRefOid } : {}),
    ...(typeof author === "string" ? { author } : {}),
    url: typeof row.url === "string" && row.url.startsWith("https://") ? row.url : "https://github.com",
    ...(typeof row.reviewDecision === "string" ? { reviewDecision: row.reviewDecision } : {}),
    ...(typeof row.mergeStateStatus === "string" ? { mergeState: row.mergeStateStatus } : {}),
    ...(typeof row.additions === "number" ? { additions: row.additions } : {}),
    ...(typeof row.deletions === "number" ? { deletions: row.deletions } : {}),
    ...(typeof row.changedFiles === "number" ? { changedFiles: row.changedFiles } : {}),
    ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
  };
}

function checkRecord(value: unknown): GitHubCheckRecord {
  const row = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const bucket = row.bucket === "pass" || row.bucket === "fail" || row.bucket === "pending" || row.bucket === "skipping" || row.bucket === "cancel" ? row.bucket : "pending";
  return {
    name: typeof row.name === "string" ? row.name : "check",
    state: typeof row.state === "string" ? row.state : "UNKNOWN",
    bucket,
    ...(typeof row.link === "string" && row.link.startsWith("https://") ? { link: row.link } : {}),
    ...(typeof row.workflow === "string" ? { workflow: row.workflow } : {}),
  };
}

export class DesktopGithubService implements HostGitHubService {
  readonly #runner: HostProcessRunner;
  readonly #queue: GitWriteQueue;
  constructor(readonly options: GithubServiceOptions) { this.#runner = options.runner ?? new HostProcessRunner(); this.#queue = options.queue ?? new GitWriteQueue(); }
  onProgress(listener: (progress: OperationProgress) => void): () => void {
    return this.#runner.onProgress((progress) => { if (progress.domain === "github") listener(progress); });
  }
  cancelAll(): void { this.#runner.cancelAll(); }

  async #run(args: ReadonlyArray<string>, options: { cwd?: string; stdin?: string; requestId?: CommandRequestId; phase?: string; allowedExitCodes?: ReadonlyArray<number>; timeoutMs?: number } = {}) {
    try {
      return await this.#runner.run({ command: "gh", args, domain: "github", ...options, timeoutMs: options.timeoutMs ?? GH_TIMEOUT });
    } catch (error) { throw safeMessage(error, options.cwd); }
  }

  async #repository(workspaceId: WorkspaceId): Promise<GithubRepository> {
    const workspace = this.options.registry.get(workspaceId);
    if (workspace === undefined) throw clientError("INVALID_ARGUMENT", "Unknown workspace id");
    let remote: string;
    let commonDir: string;
    try {
      const [remoteResult, commonResult] = await Promise.all([
        this.#runner.run({ command: "git", args: ["remote", "get-url", "origin"], cwd: workspace.canonicalPath, timeoutMs: 15_000, readOnly: true }),
        this.#runner.run({ command: "git", args: ["rev-parse", "--git-common-dir"], cwd: workspace.canonicalPath, timeoutMs: 15_000, readOnly: true }),
      ]);
      remote = remoteResult.stdout;
      const rawCommon = commonResult.stdout.trim();
      const resolvedCommon = resolve(isAbsolute(rawCommon) ? rawCommon : resolve(workspace.canonicalPath, rawCommon));
      try { commonDir = await realpath(resolvedCommon); } catch { commonDir = resolvedCommon; }
    } catch (error) { throw safeMessage(error, workspace.canonicalPath); }
    const parsed = parseRemote(remote);
    if (parsed === undefined || (!parsed.host.endsWith("github.com") && !parsed.host.includes("github"))) {
      throw clientError("CAPABILITY_UNAVAILABLE", "The origin remote is not a GitHub repository");
    }
    return { cwd: workspace.canonicalPath, host: parsed.host, ownerRepo: parsed.ownerRepo, commonDir };
  }

  async auth(input: { readonly workspaceId?: WorkspaceId }): Promise<GitHubAuthReadModel> {
    let host = "github.com";
    if (input.workspaceId !== undefined) {
      try { host = (await this.#repository(input.workspaceId)).host; } catch { /* use github.com */ }
    }
    try {
      const result = await this.#run(["auth", "status", "--hostname", host, "--json", "hosts"], { allowedExitCodes: [1] });
      const parsed = JSON.parse(result.stdout) as { hosts?: Record<string, Array<{ active?: boolean; login?: string; gitProtocol?: string; state?: string }>> };
      const accounts = parsed.hosts?.[host] ?? [];
      const account = accounts.find((item) => item.active === true) ?? accounts[0];
      const authenticated = account !== undefined && account.state !== "failure";
      return {
        available: true,
        authenticated,
        host,
        ...(account?.login === undefined ? {} : { account: account.login }),
        ...(account?.gitProtocol === "https" || account?.gitProtocol === "ssh" ? { gitProtocol: account.gitProtocol } : {}),
        ...(authenticated ? {} : { unavailableReason: "GitHub CLI is not authenticated" }),
      };
    } catch (error) {
      const mapped = safeMessage(error);
      return { available: false, authenticated: false, host, unavailableReason: mapped.message };
    }
  }

  async pullRequests(input: { readonly workspaceId: WorkspaceId; readonly state?: "open" | "closed" | "merged" | "all" }): Promise<GitHubPullRequestListReadModel> {
    const repo = await this.#repository(input.workspaceId);
    const state = input.state === undefined || input.state === "all" ? "all" : input.state;
    const result = await this.#run(["pr", "list", "--repo", `${repo.host}/${repo.ownerRepo}`, "--state", state, "--limit", "100", "--json", PR_FIELDS], { cwd: repo.cwd });
    const rows = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(rows)) throw clientError("INTERNAL_ERROR", "GitHub CLI returned an invalid PR list");
    return { workspaceId: input.workspaceId, pullRequests: rows.map(pullRequest) };
  }

  async pullRequest(input: { readonly workspaceId: WorkspaceId; readonly number: number }): Promise<GitHubPullRequestDetailReadModel> {
    const repo = await this.#repository(input.workspaceId);
    const result = await this.#run(["pr", "view", String(input.number), "--repo", `${repo.host}/${repo.ownerRepo}`, "--json", PR_FIELDS], { cwd: repo.cwd });
    const checks = await this.checks(input);
    return { workspaceId: input.workspaceId, pullRequest: pullRequest(JSON.parse(result.stdout)), checks: checks.checks };
  }

  async checks(input: { readonly workspaceId: WorkspaceId; readonly number: number }): Promise<GitHubChecksReadModel> {
    const repo = await this.#repository(input.workspaceId);
    const result = await this.#run(["pr", "checks", String(input.number), "--repo", `${repo.host}/${repo.ownerRepo}`, "--json", "bucket,name,state,link,workflow"], { cwd: repo.cwd, allowedExitCodes: [8] });
    const rows = JSON.parse(result.stdout) as unknown;
    const checks = Array.isArray(rows) ? rows.map(checkRecord) : [];
    const overall = checks.some((item) => item.bucket === "fail") ? "fail" : checks.some((item) => item.bucket === "pending") ? "pending" : checks.length > 0 && checks.every((item) => item.bucket === "pass" || item.bucket === "skipping") ? "pass" : "neutral";
    return { workspaceId: input.workspaceId, pullRequestNumber: input.number, checks, overall };
  }

  async execute(input: GitHubExecuteInput, requestId: CommandRequestId): Promise<GitHubOperationResult> {
    const operation = input.operation;
    if (operation.kind === "cancel") {
      const cancelled = this.#runner.cancel(operation.requestId);
      return { operation: operation.kind, message: cancelled ? "Operation cancelled" : "Operation is no longer running" };
    }
    this.#runner.track(requestId);
    try {
      if (operation.kind === "auth.login") {
        const host = operation.host ?? "github.com";
        await this.#run(["auth", "login", "--hostname", host, "--git-protocol", operation.gitProtocol ?? "https", "--web", "--clipboard"], { requestId, phase: "authenticating", timeoutMs: 15 * 60_000 });
        return { operation: operation.kind, message: "GitHub authentication completed" };
      }
      if (operation.kind === "auth.logout") {
        await this.#run(["auth", "logout", "--hostname", operation.host ?? "github.com"], { stdin: "y\n", requestId, phase: "signing-out" });
        return { operation: operation.kind, message: "GitHub account signed out" };
      }
      if (input.workspaceId === undefined) throw clientError("INVALID_ARGUMENT", "workspaceId is required for PR operations");
      const repo = await this.#repository(input.workspaceId);
      const repoArg = `${repo.host}/${repo.ownerRepo}`;
      let args: string[];
      let stdin: string | undefined;
      let number: number | undefined;
      let closeComment: string | undefined;
      switch (operation.kind) {
        case "pr.create": args = ["pr", "create", "--repo", repoArg, "--title", operation.title, "--body-file", "-", "--base", operation.base, ...(operation.head ? ["--head", operation.head] : []), ...(operation.draft ? ["--draft"] : [])]; stdin = operation.body; break;
        case "pr.edit": args = ["pr", "edit", String(operation.number), "--repo", repoArg, ...(operation.title ? ["--title", operation.title] : []), ...(operation.base ? ["--base", operation.base] : []), ...(operation.body !== undefined ? ["--body-file", "-"] : [])]; stdin = operation.body; number = operation.number; break;
        case "pr.ready": args = ["pr", "ready", String(operation.number), "--repo", repoArg, ...(operation.undo ? ["--undo"] : [])]; number = operation.number; break;
        case "pr.comment": args = ["pr", "comment", String(operation.number), "--repo", repoArg, "--body-file", "-"]; stdin = operation.body; number = operation.number; break;
        case "pr.review": args = ["pr", "review", String(operation.number), "--repo", repoArg, operation.decision === "approve" ? "--approve" : operation.decision === "request-changes" ? "--request-changes" : "--comment", ...(operation.body !== undefined ? ["--body-file", "-"] : [])]; stdin = operation.body; number = operation.number; break;
        case "pr.updateBranch": args = ["pr", "update-branch", String(operation.number), "--repo", repoArg, ...(operation.rebase ? ["--rebase"] : [])]; number = operation.number; break;
        case "pr.merge": args = ["pr", "merge", String(operation.number), "--repo", repoArg, `--${operation.method}`, "--match-head-commit", operation.expectedHeadOid, ...(operation.auto ? ["--auto"] : []), ...(operation.deleteBranch ? ["--delete-branch"] : [])]; number = operation.number; break;
        case "pr.close": args = ["pr", "close", String(operation.number), "--repo", repoArg, ...(operation.deleteBranch ? ["--delete-branch"] : [])]; closeComment = operation.comment; number = operation.number; break;
        case "pr.reopen": args = ["pr", "reopen", String(operation.number), "--repo", repoArg]; number = operation.number; break;
        case "pr.checkout": args = ["pr", "checkout", String(operation.number), "--repo", repoArg]; number = operation.number; break;
      }
      return await this.#queue.run(repo.commonDir, async () => {
        this.#runner.assertNotCancelled(requestId);
        const result = await this.#run(args, { cwd: repo.cwd, ...(stdin === undefined ? {} : { stdin }), requestId, phase: operation.kind });
        if (closeComment !== undefined && number !== undefined) {
          await this.#run(["api", "--hostname", repo.host, `repos/${repo.ownerRepo}/issues/${number}/comments`, "--method", "POST", "--input", "-"], { cwd: repo.cwd, stdin: JSON.stringify({ body: closeComment }), requestId, phase: "pr.close.comment" });
        }
        if (operation.kind === "pr.create") {
          const match = /\/pull\/(\d+)/u.exec(result.stdout);
          if (match) number = Number(match[1]);
        }
        this.#runner.assertNotCancelled(requestId);
        const detail = number === undefined ? undefined : await this.pullRequest({ workspaceId: input.workspaceId!, number });
        return { operation: operation.kind, message: `${operation.kind} completed`, ...(detail === undefined ? {} : { pullRequest: detail.pullRequest, url: detail.pullRequest.url }) };
      });
    } finally {
      this.#runner.untrack(requestId);
    }
  }
}

export function createDesktopGithubService(options: GithubServiceOptions): DesktopGithubService {
  return new DesktopGithubService(options);
}
