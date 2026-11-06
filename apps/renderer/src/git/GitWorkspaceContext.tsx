import { createContext, useCallback, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { CommandRequestId, GitFileChange, GitFileState, GitHubOperation, GitOperation, GitOperationResult, GitRepositoryReadModel, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_GIT } from "../preview/fixtures";
import { useTargetMemory } from "../workspaces/ExecutionTargets";
import { useGitRepository } from "./useGitRepository";

type ActiveRequest = { domain: "git" | "github"; requestId: CommandRequestId };
type GitWorkspaceState = {
  repository?: GitRepositoryReadModel | undefined;
  loading: boolean;
  error?: string | undefined;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  busy: boolean;
  activeRequest?: ActiveRequest | undefined;
  notice?: string | undefined;
  setNotice: Dispatch<SetStateAction<string | undefined>>;
  remote: string;
  setRemote: Dispatch<SetStateAction<string>>;
  revision: number;
  githubRevision: number;
  refresh(): Promise<void>;
  execute(operation: GitOperation): Promise<boolean>;
  executeGithub(operation: GitHubOperation): Promise<void>;
  cancel(): Promise<void>;
};

const Context = createContext<GitWorkspaceState | null>(null);
export const useOptionalGitWorkspace = () => useContext(Context);
export function useGitWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("GitWorkspaceProvider is required");
  return value;
}

function previewRepository(): GitRepositoryReadModel {
  const change = (row: { path: string; status: string }, staged: boolean): GitFileChange => {
    const state: GitFileState = row.status === "新增" ? "added" : row.status === "未跟踪" ? "untracked" : "modified";
    return { path: row.path, index: staged ? state : "unmodified", worktree: staged ? "unmodified" : state, conflicted: false };
  };
  return { workspaceId: "preview-git" as WorkspaceId, isRepository: true, branch: PREVIEW_GIT.branch, detached: false, unborn: false, ahead: PREVIEW_GIT.ahead, behind: PREVIEW_GIT.behind, stashCount: 0, insertions: 6, deletions: 3,
    changes: [...PREVIEW_GIT.staged.map(row => change(row, true)), ...PREVIEW_GIT.working.map(row => change(row, false))] };
}

function previewOperation(repository: GitRepositoryReadModel, operation: GitOperation): GitRepositoryReadModel {
  if (operation.kind === "stage" || operation.kind === "unstage") {
    const stage = operation.kind === "stage";
    const changes = repository.changes.map(row => {
      if (!operation.paths.includes(row.path)) return row;
      if (stage) return { ...row, index: row.worktree === "untracked" ? "added" as const : row.worktree, worktree: "unmodified" as const };
      return { ...row, worktree: row.worktree !== "unmodified" ? row.worktree : row.index === "added" ? "untracked" as const : row.index, index: "unmodified" as const };
    });
    return { ...repository, changes };
  }
  if (operation.kind === "commit") return { ...repository, changes: repository.changes.map(row => ({ ...row, index: "unmodified" as const })).filter(row => row.worktree !== "unmodified") };
  if (operation.kind === "pull") return { ...repository, behind: 0 };
  if (operation.kind === "push") return { ...repository, ahead: 0 };
  return repository;
}

/** Shared by the quick card and full Git view for one execution target/workspace. */
export function GitWorkspaceProvider({ client, workspaceId, children }: { client: StudioClient; workspaceId?: WorkspaceId | undefined; children: ReactNode }) {
  const { preview, marks } = usePreviewMode();
  const repositoryHook = useGitRepository(client, preview ? undefined : workspaceId);
  const [demoRepository, setDemoRepository] = useState(previewRepository);
  const memoryKey = `${preview ? "preview:" : "real:"}${workspaceId ?? "none"}`;
  const [draft, setDraft] = useTargetMemory(`git.draft:${memoryKey}`, () => "");
  const [remote, setRemote] = useTargetMemory(`git.remote:${memoryKey}`, () => "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [activeRequest, setActiveRequest] = useState<ActiveRequest>();
  const [revision, setRevision] = useState(0);
  const [githubRevision, setGithubRevision] = useState(0);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refreshRepository = repositoryHook.refresh;
  const update = useCallback(async (refreshGithub: boolean) => { setRevision(value => value + 1); if (refreshGithub) setGithubRevision(value => value + 1); if (!preview) await refreshRepository(); }, [preview, refreshRepository]);
  const refresh = useCallback(() => update(true), [update]);

  const execute = useCallback(async (operation: GitOperation) => {
    if (lock.current || (!preview && operation.kind !== "clone" && !workspaceId)) return false;
    lock.current = true; setBusy(true); setNotice(undefined);
    try {
      if (preview) {
        setDemoRepository(current => previewOperation(current, operation));
        if (marks) setNotice("演示操作已完成");
      } else {
        const handle = await client.command("git.execute", { ...(workspaceId ? { workspaceId } : {}), operation });
        if (!alive.current) return false;
        setActiveRequest({ domain: "git", requestId: handle.requestId });
        const result = await waitReceipt<GitOperationResult>(client, handle.requestId, 5 * 60_000);
        if (!alive.current) return false;
        setNotice(result.message);
      }
      await update(operation.kind === "fetch" || operation.kind === "pull" || operation.kind === "push");
      return true;
    } catch (cause) { if (alive.current) setNotice(hostErrorMessage(cause, "Git operation failed")); return false; }
    finally { if (alive.current) { setActiveRequest(undefined); setBusy(false); } lock.current = false; }
  }, [client, workspaceId, preview, marks, update]);

  const executeGithub = useCallback(async (operation: GitHubOperation) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setNotice(undefined);
    try {
      if (!preview) {
        const handle = await client.command("github.execute", { ...(workspaceId ? { workspaceId } : {}), operation });
        if (!alive.current) return;
        setActiveRequest({ domain: "github", requestId: handle.requestId });
        await waitReceipt(client, handle.requestId, 16 * 60_000);
        if (!alive.current) return;
        setNotice(`${operation.kind} completed`);
      } else if (marks) setNotice("演示操作已完成");
      await refresh();
    } catch (cause) { if (alive.current) setNotice(hostErrorMessage(cause, "GitHub operation failed")); }
    finally { if (alive.current) { setActiveRequest(undefined); setBusy(false); } lock.current = false; }
  }, [client, workspaceId, preview, marks, refresh]);
  const cancel = useCallback(async () => {
    if (!activeRequest) return;
    try {
      const handle = await client.command(activeRequest.domain === "git" ? "git.execute" : "github.execute", { operation: { kind: "cancel", requestId: activeRequest.requestId } });
      await waitReceipt(client, handle.requestId, 30_000);
      if (alive.current) setNotice("Cancellation requested");
    } catch (cause) { if (alive.current) setNotice(hostErrorMessage(cause, "Cancellation failed")); }
  }, [client, activeRequest]);
  return <Context.Provider value={{ repository: preview ? demoRepository : repositoryHook.repository, loading: preview ? false : repositoryHook.loading, error: preview ? undefined : repositoryHook.error,
    draft, setDraft, busy, activeRequest, notice, setNotice, remote, setRemote, revision, githubRevision, refresh, execute, executeGithub, cancel }}>{children}</Context.Provider>;
}
