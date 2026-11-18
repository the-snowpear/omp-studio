import { useEffect, useMemo, useRef, useState } from "react";
import type { GitHubItem, GitHubRepository, GitLogListReadModel, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { hostErrorMessage } from "../hostError";
import { PREVIEW_GIT_LOG } from "../preview/fixtures";
import { previewGithubSource } from "../preview/githubPreview";
import { githubSource } from "./githubSource";
import { useGitWorkspace } from "./GitWorkspaceContext";

export type GitQuickView = "changes" | "history" | "issue" | "pr";
type QuickRead = {
  loading: boolean;
  repository?: GitHubRepository;
  items?: readonly GitHubItem[];
  log?: GitLogListReadModel;
  branchCount?: number;
  error?: string;
};

/** Only the visible quick view reads data; cleanup discards old remote/workspace requests. */
export function useGitQuickReads(client: StudioClient, workspaceId: WorkspaceId | undefined, preview: boolean, visible: boolean, view: GitQuickView, zh: boolean) {
  const { repository, remote, setRemote, revision, githubRevision } = useGitWorkspace();
  const zhRef = useRef(zh);
  zhRef.current = zh;
  const source = useMemo(() => preview ? previewGithubSource : githubSource(client), [preview, client]);
  const target = preview ? "preview-git" as WorkspaceId : workspaceId;
  const [directoryState, setDirectoryState] = useState<{ target: WorkspaceId; repositories?: readonly GitHubRepository[]; error?: string }>();
  const directory = target !== undefined && directoryState !== undefined && directoryState.target === target ? directoryState : undefined;
  const [readState, setReadState] = useState<{ target?: WorkspaceId | undefined; view: GitQuickView; remote: string; value: QuickRead }>({ target, view, remote, value: { loading: true } });
  const read = readState.target === target && readState.view === view && (view === "history" || readState.remote === remote) ? readState.value : { loading: true };
  const githubVisible = visible && view !== "history";

  useEffect(() => {
    if (!githubVisible || !target) return;
    const requestedTarget = target;
    let current = true;
    setDirectoryState(undefined);
    void source.query("github.repositories.list", { workspaceId: requestedTarget }).then(value => {
      if (!current) return;
      setDirectoryState({ target: requestedTarget, repositories: value.repositories });
      setRemote(previous => value.repositories.some(repo => repo.remote === previous) ? previous : (value.repositories.find(repo => repo.remote === "origin") ?? value.repositories[0])?.remote ?? "");
    }, cause => { if (current) setDirectoryState({ target: requestedTarget, error: hostErrorMessage(cause, zhRef.current ? "无法读取 GitHub 仓库" : "Cannot read GitHub remotes") }); });
    return () => { current = false; };
  }, [source, target, githubVisible, githubRevision, setRemote]);

  const selectedRepository = directory?.repositories?.find(value => value.remote === remote);
  // Local staging should not reload GitHub, but a completed commit refreshes history.
  const localRevision = view === "history" ? revision : 0;
  useEffect(() => {
    if (!visible || !target) return;
    const requestedTarget = target;
    const requestedRemote = remote;
    let current = true;
    setReadState({ target: requestedTarget, view, remote: requestedRemote, value: { loading: true } });
    async function load(): Promise<QuickRead> {
      if (view === "history") {
        const log: GitLogListReadModel = preview
          ? { ...PREVIEW_GIT_LOG, workspaceId: requestedTarget, truncated: false }
          : await client.query("git.log.list", { workspaceId: requestedTarget, limit: 5 });
        return { loading: false, log: { ...log, commits: log.commits.slice(0, 5) } };
      }
      if (directory?.error) return { loading: false, error: directory.error };
      if (!directory?.repositories) return { loading: true };
      if (!selectedRepository) return { loading: false, error: zhRef.current ? "没有 GitHub 远端" : "No GitHub remote" };
      const input = { workspaceId: requestedTarget, remote: selectedRepository.remote };
      const auth = await source.query("github.auth.get", input);
      if (!auth.available || !auth.authenticated) throw new Error(auth.unavailableReason || (auth.available ? zhRef.current ? "尚未登录 GitHub" : "GitHub sign-in required" : zhRef.current ? "未找到 GitHub CLI" : "GitHub CLI unavailable"));
      if (!current) return { loading: false };
      if (view === "issue") {
        const page = await source.query("github.items.list", { ...input, kind: "issue", state: "open" });
        return { loading: false, repository: page.repository, items: newest(page.items).slice(0, 3) };
      }
      const [branch, all] = await Promise.all([
        repository?.branch ? source.query("github.items.list", { ...input, kind: "pr", state: "open", search: `head:${repository.branch}` }) : undefined,
        view === "pr" ? source.query("github.items.list", { ...input, kind: "pr", state: "open" }) : undefined,
      ]);
      const matches = newest(branch?.items.filter(item => item.headBranch === repository?.branch) ?? []);
      const others = newest(all?.items ?? []).filter(item => !matches.some(match => match.number === item.number));
      return { loading: false, repository: selectedRepository, items: [...matches, ...others].slice(0, view === "pr" ? 3 : 1), branchCount: branch?.totalCount ?? 0 };
    }
    void load().then(value => { if (current) setReadState({ target: requestedTarget, view, remote: requestedRemote, value }); }, cause => {
      if (current) setReadState({ target: requestedTarget, view, remote: requestedRemote, value: { loading: false, error: hostErrorMessage(cause, zhRef.current ? "读取失败" : "Could not load Git data") } });
    });
    return () => { current = false; };
  }, [client, source, target, remote, preview, visible, view, directory, selectedRepository, repository?.branch, repository?.headOid, localRevision, githubRevision, preview ? zh : false]);
  return { read, source, target };
}

function newest(items: readonly GitHubItem[]) {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
