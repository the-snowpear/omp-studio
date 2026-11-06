import { useEffect, useMemo, useState } from "react";
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
  const source = useMemo(() => preview ? previewGithubSource : githubSource(client), [preview, client]);
  const target = preview ? "preview-git" as WorkspaceId : workspaceId;
  const [directory, setDirectory] = useState<{ repositories?: readonly GitHubRepository[]; error?: string }>({});
  const [read, setRead] = useState<QuickRead>({ loading: true });
  const githubVisible = visible && view !== "history";

  useEffect(() => {
    if (!githubVisible || !target) return;
    let current = true;
    setDirectory({});
    void source.query("github.repositories.list", { workspaceId: target }).then(value => {
      if (!current) return;
      setDirectory({ repositories: value.repositories });
      setRemote(previous => value.repositories.some(repo => repo.remote === previous) ? previous : (value.repositories.find(repo => repo.remote === "origin") ?? value.repositories[0])?.remote ?? "");
    }, cause => { if (current) setDirectory({ error: hostErrorMessage(cause, zh ? "无法读取 GitHub 仓库" : "Cannot read GitHub remotes") }); });
    return () => { current = false; };
  }, [source, target, githubVisible, githubRevision, setRemote, zh]);

  const selectedRepository = directory.repositories?.find(value => value.remote === remote);
  // Local staging should not reload GitHub, but a completed commit refreshes history.
  const localRevision = view === "history" ? revision : 0;
  useEffect(() => {
    if (!visible || !target) return;
    let current = true;
    setRead({ loading: true });
    async function load(): Promise<QuickRead> {
      if (view === "history") {
        const log: GitLogListReadModel = preview
          ? { ...PREVIEW_GIT_LOG, workspaceId: target!, truncated: false }
          : await client.query("git.log.list", { workspaceId: target!, limit: 5 });
        return { loading: false, log: { ...log, commits: log.commits.slice(0, 5) } };
      }
      if (directory.error) return { loading: false, error: directory.error };
      if (!directory.repositories) return { loading: true };
      if (!selectedRepository) return { loading: false, error: zh ? "没有 GitHub 远端" : "No GitHub remote" };
      const input = { workspaceId: target!, remote: selectedRepository.remote };
      const auth = await source.query("github.auth.get", input);
      if (!auth.available || !auth.authenticated) throw new Error(auth.unavailableReason || (auth.available ? zh ? "尚未登录 GitHub" : "GitHub sign-in required" : zh ? "未找到 GitHub CLI" : "GitHub CLI unavailable"));
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
    void load().then(value => { if (current) setRead(value); }, cause => {
      if (current) setRead({ loading: false, error: hostErrorMessage(cause, zh ? "读取失败" : "Could not load Git data") });
    });
    return () => { current = false; };
  }, [client, source, target, preview, visible, view, directory, selectedRepository, repository?.branch, repository?.headOid, localRevision, githubRevision, zh]);
  return { read, source, target };
}

function newest(items: readonly GitHubItem[]) {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
