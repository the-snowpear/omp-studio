import type { Dispatch, SetStateAction } from "react";
import { useRef, useState } from "react";
import type { OperatorInvokeOutcome, SessionHistoryEntry, SessionHistoryReadModel, SessionId, ThreadId, WorkspaceId } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import { type IconName } from "../icons";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { resolveProvisionalHistoryTitle, type ProvisionalProjectThread } from "../sidebar/provisionalThread";
import { renameNeedsSessionResume } from "../sidebar/sessionTitle";
import { type ClientStateSource } from "../workbench/types";

interface useSessionRenameInput {
  renameTargetSessionId: SessionId | undefined;
  selected: SessionHistoryEntry | undefined;
  renameTargetWorkspaceId: WorkspaceId | undefined;
  threadTitle: string;
  workspaceActionQueue: { enqueue<T>(task: () => Promise<T>): Promise<T>; };
  snapshot: OperatorStateSnapshot | undefined;
  can: (id: string) => boolean;
  client: ClientStateSource;
  refreshHistoryAfterTitle: (workspaceId?: WorkspaceId) => Promise<SessionHistoryReadModel | undefined>;
  setProvisionalThreadsBySession: Dispatch<SetStateAction<Readonly<Record<string, ProvisionalProjectThread>>>>;
  setShellNotice: Dispatch<SetStateAction<{ text: string; icon: IconName; } | null>>;
  ensureWorkspaceActive: (workspaceId?: WorkspaceId) => Promise<void>;
}

export function useSessionRename({ renameTargetSessionId, selected, renameTargetWorkspaceId, threadTitle, workspaceActionQueue, snapshot, can, client, refreshHistoryAfterTitle, setProvisionalThreadsBySession, setShellNotice, ensureWorkspaceActive }: useSessionRenameInput) {
  /** 顶栏「重命名对话」模态：builtin.rename 持久化到会话标题槽。 */
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | undefined>(undefined);
  const renameContextRef = useRef<{ sessionId?: SessionId; threadId?: ThreadId; workspaceId?: WorkspaceId } | undefined>(undefined);
  /** initialTitle：行级菜单显式传入所在行标题；顶栏缺省用当前查看会话标题。 */
  const openRenameDialog = (initialTitle?: string, context?: { sessionId?: SessionId; threadId?: ThreadId; workspaceId?: WorkspaceId }) => {
    renameContextRef.current = context ?? {
      ...(renameTargetSessionId === undefined ? {} : { sessionId: renameTargetSessionId }),
      ...(selected?.threadId === undefined ? {} : { threadId: selected.threadId }),
      ...(renameTargetWorkspaceId === undefined ? {} : { workspaceId: renameTargetWorkspaceId }),
    };
    setRenameValue(initialTitle ?? threadTitle);
    setRenameError(undefined);
    setRenameOpen(true);
  };
  const submitRename = (generate = false) => {
    const next = generate ? "" : renameValue.trim();
    if ((!generate && !next) || renameBusy) return;
    setRenameError(undefined);
    setRenameBusy(true);
    void workspaceActionQueue.enqueue(async () => {
      try {
        const context = renameContextRef.current;
        const targetSessionId = context?.sessionId ?? renameTargetSessionId;
        const targetThreadId = context?.threadId ?? selected?.threadId;
        const targetWorkspaceId = context?.workspaceId ?? renameTargetWorkspaceId;
        if (!generate && targetSessionId && snapshot?.sessionId && can("session.history.rename")) {
          const handle = await client.command("session.history.rename", { sessionId: snapshot.sessionId, targetSessionId, title: next });
          const outcome = await waitReceipt<{ result: { targetSessionId: string; title: string } }>(client, handle.requestId);
          await refreshHistoryAfterTitle(targetWorkspaceId);
          setProvisionalThreadsBySession(current => current[targetSessionId] ? { ...current, [targetSessionId]: resolveProvisionalHistoryTitle(current[targetSessionId]!, outcome.result.title) } : current);
          setShellNotice({ text: `已重命名为「${outcome.result.title}」`, icon: "check" });
          setRenameOpen(false);
          return;
        }
        let renamedSessionId = targetSessionId;
        if (renameNeedsSessionResume({
          hasViewedHistory: context !== undefined || selected !== undefined,
          ...(targetSessionId === undefined ? {} : { viewedSessionId: targetSessionId }),
          ...(snapshot?.sessionId === undefined ? {} : { liveSessionId: snapshot.sessionId }),
        })) {
          if (targetThreadId === undefined) throw new Error("当前查看会话缺少 threadId，无法重命名");
          await ensureWorkspaceActive(targetWorkspaceId);
          const resume = await client.command("session.resume", { threadId: targetThreadId });
          const resumed = await waitReceipt<OperatorStateSnapshot>(client, resume.requestId);
          if (selected?.sessionId !== undefined && resumed.sessionId !== selected.sessionId) {
            throw new Error("恢复的会话与当前查看会话不一致");
          }
          renamedSessionId = resumed.sessionId;
        }
        const handle = await client.command("operator.invoke", { commandId: "builtin.rename", arguments: next });
        const outcome = await waitReceipt<OperatorInvokeOutcome>(client, handle.requestId);
        if (renamedSessionId !== undefined && outcome.snapshot.sessionId !== renamedSessionId) {
          throw new Error("重命名回执与目标会话不一致");
        }
        renamedSessionId ??= outcome.snapshot.sessionId;
        const receiptTitle = outcome.snapshot.sessionTitle?.trim();
        const refreshed = await refreshHistoryAfterTitle(targetWorkspaceId);
        const historyTitle = refreshed?.entries.find((entry) => entry.sessionId === renamedSessionId)?.title?.trim();
        const confirmedTitle = generate
          ? receiptTitle
          : receiptTitle === next
          ? receiptTitle
          : historyTitle === next
            ? historyTitle
            : undefined;
        if (confirmedTitle === undefined) {
          throw new Error("重命名回执或历史记录未确认目标标题");
        }
        if (renamedSessionId !== undefined) {
          const key = String(renamedSessionId);
          setProvisionalThreadsBySession((current) => {
            const thread = current[key];
            if (thread === undefined) return current;
            return { ...current, [key]: resolveProvisionalHistoryTitle(thread, confirmedTitle) };
          });
        }
        setShellNotice({ text: `已重命名为「${confirmedTitle}」`, icon: "check" });
        setRenameOpen(false);
      } catch (error) {
        setRenameError(hostErrorMessage(error, "重命名失败"));
      } finally {
        setRenameBusy(false);
      }
    });
  };
  return { openRenameDialog, renameOpen, renameBusy, setRenameOpen, renameValue, setRenameValue, submitRename, renameError };
}
