import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StudioClient, WorkspaceId, GitBranchRecord, GitOperationResult } from "@omp-studio/client-contract";
import { useI18n } from "../i18n";
import { useConversationDom } from "../conversationWorkspace/Context";
import { hostErrorMessage, waitReceipt } from "../hostError";
import type { useGitRepository } from "./useGitRepository";
import { switchBlockedFilesOf, type SwitchBlockedFile } from "./branchSwitchErrors";

export function useWorkbenchBranches({ client, gitWorkspaceId, realGit, preview, running, interactionPending }: { client: StudioClient; gitWorkspaceId: WorkspaceId | undefined; realGit: ReturnType<typeof useGitRepository>; preview: boolean; running: boolean; interactionPending: boolean }) {
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const zhRef = useRef(zh);
  zhRef.current = zh;
  const { window } = useConversationDom();
  const [contextBranchMenuOpen, setContextBranchMenuOpen] = useState(false);
  const [rawBranchListState, setRawBranchListState] = useState<{ workspaceId?: WorkspaceId | undefined; status: "idle" | "loading" | "ready" | "error"; branches: ReadonlyArray<GitBranchRecord>; error?: string }>({ status: "idle", branches: [] });
  const [rawBranchSwitch, setRawBranchSwitch] = useState<{ workspaceId: WorkspaceId; name: string } | undefined>(undefined);
  const [branchNotice, setBranchNotice] = useState<{ tone: "ok" | "error"; text: string } | undefined>(undefined);
  // 流式对话（或有 pending interaction）期间请求的分支操作先排队，本轮结束后由 effect 执行。
  const [rawPendingBranchAction, setRawPendingBranchAction] = useState<{ workspaceId: WorkspaceId; kind: "switch" | "create"; name: string } | undefined>(undefined);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [createBranchBusy, setCreateBranchBusy] = useState(false);
  const [createBranchError, setCreateBranchError] = useState<string | undefined>(undefined);
  // git switch 被未提交改动挡住：弹窗列出冲突文件，提交后重试切换。
  const [rawSwitchBlock, setRawSwitchBlock] = useState<{ workspaceId: WorkspaceId; branch: string; files: SwitchBlockedFile[] } | undefined>(undefined);
  const [switchCommitMessage, setSwitchCommitMessage] = useState("");
  const [switchCommitBusy, setSwitchCommitBusy] = useState(false);
  const [switchCommitError, setSwitchCommitError] = useState<string | undefined>(undefined);
  const loadGeneration = useRef(0);
  const actionGeneration = useRef(0);

  const branchListState = useMemo<{ status: "idle" | "loading" | "ready" | "error"; branches: ReadonlyArray<GitBranchRecord>; error?: string }>(
    () => (gitWorkspaceId !== undefined && rawBranchListState.workspaceId === gitWorkspaceId
      ? { status: rawBranchListState.status, branches: rawBranchListState.branches, ...(rawBranchListState.error !== undefined ? { error: rawBranchListState.error } : {}) }
      : { status: "idle", branches: [] }),
    [gitWorkspaceId, rawBranchListState],
  );
  const branchSwitchName =
    rawBranchSwitch !== undefined && gitWorkspaceId !== undefined && rawBranchSwitch.workspaceId === gitWorkspaceId
      ? rawBranchSwitch.name
      : undefined;
  const pendingBranchAction = useMemo(
    () => (
      rawPendingBranchAction !== undefined && gitWorkspaceId !== undefined && rawPendingBranchAction.workspaceId === gitWorkspaceId
        ? { kind: rawPendingBranchAction.kind, name: rawPendingBranchAction.name }
        : undefined
    ),
    [gitWorkspaceId, rawPendingBranchAction],
  );
  const switchBlock = useMemo(
    () => (
      rawSwitchBlock !== undefined && gitWorkspaceId !== undefined && rawSwitchBlock.workspaceId === gitWorkspaceId
        ? { branch: rawSwitchBlock.branch, files: rawSwitchBlock.files }
        : undefined
    ),
    [gitWorkspaceId, rawSwitchBlock],
  );

  useEffect(() => {
    loadGeneration.current += 1;
    actionGeneration.current += 1;
    setContextBranchMenuOpen(false);
    setRawBranchListState({ workspaceId: gitWorkspaceId, status: "idle", branches: [] });
    setRawBranchSwitch(undefined);
    setRawPendingBranchAction(undefined);
    setRawSwitchBlock(undefined);
    setBranchNotice(undefined);
    setCreateBranchOpen(false);
    setCreateBranchName("");
    setCreateBranchBusy(false);
    setCreateBranchError(undefined);
    setSwitchCommitMessage("");
    setSwitchCommitBusy(false);
    setSwitchCommitError(undefined);
  }, [gitWorkspaceId]);

  const loadBranches = useCallback(async () => {
    if (gitWorkspaceId === undefined) return;
    const targetWorkspaceId = gitWorkspaceId;
    const generation = ++loadGeneration.current;
    setRawBranchListState({ workspaceId: targetWorkspaceId, status: "loading", branches: [] });
    try {
      const value = await client.query("git.branches.list", { workspaceId: targetWorkspaceId });
      if (generation !== loadGeneration.current) return;
      setRawBranchListState({ workspaceId: targetWorkspaceId, status: "ready", branches: value.branches });
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      setRawBranchListState({ workspaceId: targetWorkspaceId, status: "error", branches: [], error: hostErrorMessage(cause, zhRef.current ? "无法读取分支列表" : "Cannot load branch list") });
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
  }, [branchNotice, window]);
  const localBranches = useMemo(() => branchListState.branches.filter((branch) => !branch.remote), [branchListState.branches]);
  const remoteBranches = useMemo(() => branchListState.branches.filter((branch) => branch.remote), [branchListState.branches]);
  // ---- 分支动作：run 进行中或有 pending interaction 时排队，本轮结束再执行 ----
  const branchActionDeferred = running || interactionPending;
  const performBranchSwitch = useCallback(async (name: string) => {
    if (gitWorkspaceId === undefined || branchSwitchName !== undefined) return;
    const targetWorkspaceId = gitWorkspaceId;
    const generation = actionGeneration.current;
    setRawBranchSwitch({ workspaceId: targetWorkspaceId, name });
    try {
      const handle = await client.command("git.execute", {
        workspaceId: targetWorkspaceId,
        operation: { kind: "branch.switch", name },
      });
      await waitReceipt<GitOperationResult>(client, handle.requestId, 60_000);
      if (generation === actionGeneration.current) setBranchNotice({ tone: "ok", text: t("git.switchedToBranch", { name }) });
    } catch (cause) {
      if (generation === actionGeneration.current) {
        const blocked = switchBlockedFilesOf(cause);
        if (blocked !== undefined) {
          setRawSwitchBlock({ workspaceId: targetWorkspaceId, branch: name, files: blocked });
          setSwitchCommitError(undefined);
        } else {
          setBranchNotice({ tone: "error", text: hostErrorMessage(cause, t("git.switchBranchFailed")) });
        }
      }
    } finally {
      if (generation === actionGeneration.current) {
        setRawBranchSwitch(undefined);
        void realGit.refresh();
        if (realGit.repository?.isRepository) void loadBranches();
      }
    }
  }, [branchSwitchName, client, gitWorkspaceId, loadBranches, realGit.refresh, realGit.repository?.isRepository, t]);
  const performBranchCreate = useCallback(async (name: string) => {
    if (gitWorkspaceId === undefined) return;
    const targetWorkspaceId = gitWorkspaceId;
    const generation = actionGeneration.current;
    setRawBranchSwitch({ workspaceId: targetWorkspaceId, name });
    try {
      const handle = await client.command("git.execute", {
        workspaceId: targetWorkspaceId,
        operation: { kind: "branch.create", name, checkout: true },
      });
      await waitReceipt<GitOperationResult>(client, handle.requestId, 60_000);
      if (generation === actionGeneration.current) {
        setBranchNotice({ tone: "ok", text: t("git.createdAndSwitchedTo", { name }) });
        void loadBranches();
      }
    } catch (cause) {
      if (generation === actionGeneration.current) setBranchNotice({ tone: "error", text: hostErrorMessage(cause, t("git.createBranchFailed")) });
    } finally {
      if (generation === actionGeneration.current) {
        setRawBranchSwitch(undefined);
        void realGit.refresh();
      }
    }
  }, [client, gitWorkspaceId, loadBranches, realGit.refresh, t]);
  const requestBranchSwitch = (name: string) => {
    setContextBranchMenuOpen(false);
    if (gitWorkspaceId === undefined) return;
    if (pendingBranchAction?.kind === "switch" && pendingBranchAction.name === name) {
      setRawPendingBranchAction(undefined);
      setBranchNotice({ tone: "ok", text: t("git.cancelledSwitchTo", { name }) });
      return;
    }
    if (branchActionDeferred) {
      setRawPendingBranchAction({ workspaceId: gitWorkspaceId, kind: "switch", name });
      setBranchNotice({ tone: "ok", text: t("git.switchBranchAfterTurn", { name }) });
      return;
    }
    void performBranchSwitch(name);
  };
  const createBranch = async () => {
    const name = createBranchName.trim();
    if (!name || createBranchBusy || gitWorkspaceId === undefined) return;
    const targetWorkspaceId = gitWorkspaceId;
    const generation = actionGeneration.current;
    if (branchActionDeferred) {
      setCreateBranchOpen(false);
      setRawPendingBranchAction({ workspaceId: targetWorkspaceId, kind: "create", name });
      setBranchNotice({ tone: "ok", text: t("git.createBranchAfterTurn", { name }) });
      return;
    }
    setCreateBranchError(undefined);
    setCreateBranchBusy(true);
    try {
      const handle = await client.command("git.execute", {
        workspaceId: targetWorkspaceId,
        operation: { kind: "branch.create", name, checkout: true },
      });
      await waitReceipt<GitOperationResult>(client, handle.requestId, 60_000);
      if (generation === actionGeneration.current) {
        setCreateBranchOpen(false);
        setBranchNotice({ tone: "ok", text: zhRef.current ? `已创建并切换到 ${name}` : `Created and switched to ${name}` });
        void loadBranches();
      }
    } catch (cause) {
      if (generation === actionGeneration.current) setCreateBranchError(hostErrorMessage(cause, t("git.createBranchFailed")));
    } finally {
      if (generation === actionGeneration.current) {
        setCreateBranchBusy(false);
        void realGit.refresh();
      }
    }
  };
  useEffect(() => {
    if (branchActionDeferred || rawPendingBranchAction === undefined) return;
    if (rawPendingBranchAction.workspaceId !== gitWorkspaceId) {
      setRawPendingBranchAction(undefined);
      return;
    }
    const action = rawPendingBranchAction;
    setRawPendingBranchAction(undefined);
    if (action.kind === "switch") void performBranchSwitch(action.name);
    else void performBranchCreate(action.name);
  }, [branchActionDeferred, gitWorkspaceId, rawPendingBranchAction, performBranchCreate, performBranchSwitch]);
  // ---- 切换被未提交改动挡住：提交列出的文件后重试切换 ----
  const cancelSwitchBlock = () => {
    if (switchCommitBusy) return;
    const branch = switchBlock?.branch;
    setRawSwitchBlock(undefined);
    setSwitchCommitMessage("");
    setSwitchCommitError(undefined);
    if (branch !== undefined) setBranchNotice({ tone: "ok", text: t("git.cancelledSwitchTo", { name: branch }) });
  };
  const submitSwitchCommit = async () => {
    const block =
      rawSwitchBlock !== undefined && gitWorkspaceId !== undefined && rawSwitchBlock.workspaceId === gitWorkspaceId
        ? rawSwitchBlock
        : undefined;
    const message = switchCommitMessage.trim();
    if (!block || !message || switchCommitBusy || gitWorkspaceId === undefined) return;
    const targetWorkspaceId = gitWorkspaceId;
    const generation = actionGeneration.current;
    setSwitchCommitBusy(true);
    setSwitchCommitError(undefined);
    try {
      // 未跟踪文件要先 add 才能 commit --only；已跟踪文件交给 --only 提交工作区内容。
      const paths = block.files.map((file) => file.path);
      const untracked = paths.filter((path) => realGit.repository?.changes.some((change) => change.path === path && change.worktree === "untracked") === true);
      if (untracked.length > 0) {
        const stageHandle = await client.command("git.execute", { workspaceId: targetWorkspaceId, operation: { kind: "stage", paths: untracked } });
        await waitReceipt<GitOperationResult>(client, stageHandle.requestId, 60_000);
      }
      if (generation !== actionGeneration.current) return;
      const commitHandle = await client.command("git.execute", { workspaceId: targetWorkspaceId, operation: { kind: "commit", message, paths } });
      await waitReceipt<GitOperationResult>(client, commitHandle.requestId, 60_000);
      if (generation !== actionGeneration.current) return;
      setRawSwitchBlock(undefined);
      setSwitchCommitMessage("");
      await performBranchSwitch(block.branch);
    } catch (cause) {
      if (generation === actionGeneration.current) {
        setSwitchCommitError(hostErrorMessage(cause, t("git.commitFailed")));
        void realGit.refresh();
      }
    } finally {
      if (generation === actionGeneration.current) setSwitchCommitBusy(false);
    }
  };
  return { contextBranchMenuOpen, setContextBranchMenuOpen, branchListState, branchSwitchName, branchNotice, pendingBranchAction, createBranchOpen, setCreateBranchOpen, createBranchName, setCreateBranchName, createBranchBusy, createBranchError, switchBlock, switchCommitMessage, setSwitchCommitMessage, switchCommitBusy, switchCommitError, loadBranches, openCreateBranch, localBranches, remoteBranches, branchActionDeferred, requestBranchSwitch, createBranch, cancelSwitchBlock, submitSwitchCommit };
}
