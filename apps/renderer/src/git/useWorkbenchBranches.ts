import { useCallback, useEffect, useMemo, useState } from "react";
import type { StudioClient, WorkspaceId, GitBranchRecord, GitOperationResult } from "@omp-studio/client-contract";
import { useI18n } from "../i18n";
import { useConversationDom } from "../conversationWorkspace/Context";
import { hostErrorMessage, waitReceipt } from "../hostError";
import type { useGitRepository } from "./useGitRepository";
import { switchBlockedFilesOf, type SwitchBlockedFile } from "./branchSwitchErrors";

export function useWorkbenchBranches({ client, gitWorkspaceId, realGit, preview, running, interactionPending }: { client: StudioClient; gitWorkspaceId: WorkspaceId | undefined; realGit: ReturnType<typeof useGitRepository>; preview: boolean; running: boolean; interactionPending: boolean }) {
  const { t } = useI18n();
  const { window } = useConversationDom();
  const [contextBranchMenuOpen, setContextBranchMenuOpen] = useState(false);
  const [branchListState, setBranchListState] = useState<{ status: "idle" | "loading" | "ready" | "error"; branches: ReadonlyArray<GitBranchRecord>; error?: string }>({ status: "idle", branches: [] });
  const [branchSwitchName, setBranchSwitchName] = useState<string | undefined>(undefined);
  const [branchNotice, setBranchNotice] = useState<{ tone: "ok" | "error"; text: string } | undefined>(undefined);
  // 流式对话（或有 pending interaction）期间请求的分支操作先排队，本轮结束后由 effect 执行。
  const [pendingBranchAction, setPendingBranchAction] = useState<{ kind: "switch" | "create"; name: string } | undefined>(undefined);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [createBranchBusy, setCreateBranchBusy] = useState(false);
  const [createBranchError, setCreateBranchError] = useState<string | undefined>(undefined);
  // git switch 被未提交改动挡住：弹窗列出冲突文件，提交后重试切换。
  const [switchBlock, setSwitchBlock] = useState<{ branch: string; files: SwitchBlockedFile[] } | undefined>(undefined);
  const [switchCommitMessage, setSwitchCommitMessage] = useState("");
  const [switchCommitBusy, setSwitchCommitBusy] = useState(false);
  const [switchCommitError, setSwitchCommitError] = useState<string | undefined>(undefined);
  const loadBranches = useCallback(async () => {
    if (gitWorkspaceId === undefined) return;
    setBranchListState({ status: "loading", branches: [] });
    try {
      const value = await client.query("git.branches.list", { workspaceId: gitWorkspaceId });
      setBranchListState({ status: "ready", branches: value.branches });
    } catch (cause) {
      setBranchListState({ status: "error", branches: [], error: hostErrorMessage(cause, "无法读取分支列表") });
    }
  }, [client, gitWorkspaceId]);
  const openCreateBranch = () => {
    setContextBranchMenuOpen(false);
    setCreateBranchName("");
    setCreateBranchError(undefined);
    setCreateBranchOpen(true);
  };
  useEffect(() => {
    if (!contextBranchMenuOpen || preview || gitWorkspaceId === undefined) return;
    if (branchListState.status === "idle" && realGit.repository?.isRepository) void loadBranches();
  }, [branchListState.status, contextBranchMenuOpen, gitWorkspaceId, loadBranches, preview, realGit.repository?.isRepository]);
  useEffect(() => {
    if (branchNotice === undefined) return;
    const timer = window.setTimeout(() => setBranchNotice(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [branchNotice]);
  const localBranches = useMemo(() => branchListState.branches.filter((branch) => !branch.remote), [branchListState.branches]);
  const remoteBranches = useMemo(() => branchListState.branches.filter((branch) => branch.remote), [branchListState.branches]);
  // ---- 分支动作：run 进行中或有 pending interaction 时排队，本轮结束再执行 ----
  const branchActionDeferred = running || interactionPending;
  const performBranchSwitch = useCallback(async (name: string) => {
    if (gitWorkspaceId === undefined || branchSwitchName !== undefined) return;
    setBranchSwitchName(name);
    try {
      const handle = await client.command("git.execute", {
        workspaceId: gitWorkspaceId,
        operation: { kind: "branch.switch", name },
      });
      await waitReceipt<GitOperationResult>(client, handle.requestId, 60_000);
      setBranchNotice({ tone: "ok", text: t("git.switchedToBranch", { name }) });
    } catch (cause) {
      const blocked = switchBlockedFilesOf(cause);
      if (blocked !== undefined) {
        setSwitchBlock({ branch: name, files: blocked });
        setSwitchCommitError(undefined);
      } else {
        setBranchNotice({ tone: "error", text: hostErrorMessage(cause, t("git.switchBranchFailed")) });
      }
    } finally {
      setBranchSwitchName(undefined);
      void realGit.refresh();
      if (realGit.repository?.isRepository) void loadBranches();
    }
  }, [branchSwitchName, client, gitWorkspaceId, loadBranches, realGit.refresh, realGit.repository?.isRepository]);
  const performBranchCreate = useCallback(async (name: string) => {
    if (gitWorkspaceId === undefined) return;
    setBranchSwitchName(name);
    try {
      const handle = await client.command("git.execute", {
        workspaceId: gitWorkspaceId,
        operation: { kind: "branch.create", name, checkout: true },
      });
      await waitReceipt<GitOperationResult>(client, handle.requestId, 60_000);
      setBranchNotice({ tone: "ok", text: t("git.createdAndSwitchedTo", { name }) });
      void loadBranches();
    } catch (cause) {
      setBranchNotice({ tone: "error", text: hostErrorMessage(cause, t("git.createBranchFailed")) });
    } finally {
      setBranchSwitchName(undefined);
      void realGit.refresh();
    }
  }, [client, gitWorkspaceId, loadBranches, realGit.refresh]);
  const requestBranchSwitch = (name: string) => {
    setContextBranchMenuOpen(false);
    if (pendingBranchAction?.kind === "switch" && pendingBranchAction.name === name) {
      setPendingBranchAction(undefined);
      setBranchNotice({ tone: "ok", text: t("git.cancelledSwitchTo", { name }) });
      return;
    }
    if (branchActionDeferred) {
      setPendingBranchAction({ kind: "switch", name });
      setBranchNotice({ tone: "ok", text: t("git.switchBranchAfterTurn", { name }) });
      return;
    }
    void performBranchSwitch(name);
  };
  const createBranch = async () => {
    const name = createBranchName.trim();
    if (!name || createBranchBusy || gitWorkspaceId === undefined) return;
    if (branchActionDeferred) {
      setCreateBranchOpen(false);
      setPendingBranchAction({ kind: "create", name });
      setBranchNotice({ tone: "ok", text: t("git.createBranchAfterTurn", { name }) });
      return;
    }
    setCreateBranchError(undefined);
    setCreateBranchBusy(true);
    try {
      const handle = await client.command("git.execute", {
        workspaceId: gitWorkspaceId,
        operation: { kind: "branch.create", name, checkout: true },
      });
      await waitReceipt<GitOperationResult>(client, handle.requestId, 60_000);
      setCreateBranchOpen(false);
      setBranchNotice({ tone: "ok", text: `已创建并切换到 ${name}` });
      void loadBranches();
    } catch (cause) {
      setCreateBranchError(hostErrorMessage(cause, t("git.createBranchFailed")));
    } finally {
      setCreateBranchBusy(false);
      void realGit.refresh();
    }
  };
  useEffect(() => {
    if (branchActionDeferred || pendingBranchAction === undefined) return;
    const action = pendingBranchAction;
    setPendingBranchAction(undefined);
    if (action.kind === "switch") void performBranchSwitch(action.name);
    else void performBranchCreate(action.name);
  }, [branchActionDeferred, pendingBranchAction, performBranchCreate, performBranchSwitch]);
  // ---- 切换被未提交改动挡住：提交列出的文件后重试切换 ----
  const cancelSwitchBlock = () => {
    if (switchCommitBusy) return;
    const branch = switchBlock?.branch;
    setSwitchBlock(undefined);
    setSwitchCommitMessage("");
    setSwitchCommitError(undefined);
    if (branch !== undefined) setBranchNotice({ tone: "ok", text: t("git.cancelledSwitchTo", { name: branch }) });
  };
  const submitSwitchCommit = async () => {
    const block = switchBlock;
    const message = switchCommitMessage.trim();
    if (!block || !message || switchCommitBusy || gitWorkspaceId === undefined) return;
    setSwitchCommitBusy(true);
    setSwitchCommitError(undefined);
    try {
      // 未跟踪文件要先 add 才能 commit --only；已跟踪文件交给 --only 提交工作区内容。
      const paths = block.files.map((file) => file.path);
      const untracked = paths.filter((path) => realGit.repository?.changes.some((change) => change.path === path && change.worktree === "untracked") === true);
      if (untracked.length > 0) {
        const stageHandle = await client.command("git.execute", { workspaceId: gitWorkspaceId, operation: { kind: "stage", paths: untracked } });
        await waitReceipt<GitOperationResult>(client, stageHandle.requestId, 60_000);
      }
      const commitHandle = await client.command("git.execute", { workspaceId: gitWorkspaceId, operation: { kind: "commit", message, paths } });
      await waitReceipt<GitOperationResult>(client, commitHandle.requestId, 60_000);
      setSwitchBlock(undefined);
      setSwitchCommitMessage("");
      await performBranchSwitch(block.branch);
    } catch (cause) {
      setSwitchCommitError(hostErrorMessage(cause, t("git.commitFailed")));
      void realGit.refresh();
    } finally {
      setSwitchCommitBusy(false);
    }
  };
  return { contextBranchMenuOpen, setContextBranchMenuOpen, branchListState, branchSwitchName, branchNotice, pendingBranchAction, createBranchOpen, setCreateBranchOpen, createBranchName, setCreateBranchName, createBranchBusy, createBranchError, switchBlock, switchCommitMessage, setSwitchCommitMessage, switchCommitBusy, switchCommitError, loadBranches, openCreateBranch, localBranches, remoteBranches, branchActionDeferred, requestBranchSwitch, createBranch, cancelSwitchBlock, submitSwitchCommit };
}
