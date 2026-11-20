import { useEffect, useState } from "react";
import type { WorkspaceListReadModel } from "@omp-studio/client-contract";
import type { FileMenuAction, FileMenuTarget, FileOpenerOption } from "../menus";
import { useI18n } from "../i18n";
import type { IconName } from "../icons";
import { PLATFORM } from "../platform";

export function useWorkspaceFileActions({ workspace, remote, targetId, onNotice, onOpenDisassembler }: {
  workspace: WorkspaceListReadModel["workspaces"][number] | undefined; remote: false | "ssh" | "wsl"; targetId: string | null;
  onNotice(notice: { text: string; icon: IconName }): void; onOpenDisassembler(path: string): void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [fileOpeners, setFileOpeners] = useState<ReadonlyArray<FileOpenerOption>>([]);
  useEffect(() => {
    const activeWorkspace = workspace;
    const list = globalThis.ompStudioChrome?.listFileOpeners;
    if (activeWorkspace === undefined || list === undefined) {
      setFileOpeners([]);
      return;
    }
    let cancelled = false;
    void list({ workspaceId: activeWorkspace.workspaceId })
      .then((openers) => {
        if (!cancelled) setFileOpeners([...openers]);
      })
      .catch(() => {
        if (!cancelled) setFileOpeners([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);
  const fileShellUnavailable = remote === "ssh"
    ? (zh ? "远程文件请先下载，再使用系统应用打开" : "Download remote files before opening with a system app")
    : globalThis.ompStudioChrome?.openFile === undefined
      ? (zh ? "仅桌面端可用" : "Desktop app only")
      : undefined;

  const runFileShellAction = (workspaceId: string, action: FileMenuAction, target: FileMenuTarget, ownerId: string | null = targetId) => {
    const desktop = globalThis.ompStudioChrome;
    const messageOf = (cause: unknown): string => (cause instanceof Error && cause.message ? cause.message : String(cause));
    const notice = (text: string, icon: IconName): void => {
      onNotice({ text, icon });
    };
    if (action.type === "copyRelative") {
      void navigator.clipboard
        .writeText(target.path)
        .then(() => notice(zh ? "已复制相对路径" : "Copied relative path", "check"))
        .catch(() => notice(zh ? "复制相对路径失败" : "Failed to copy relative path", "alert"));
      return;
    }
    const input = { workspaceId, ...(ownerId ? { targetId: ownerId } : {}), path: target.path, kind: target.kind };
    if(action.type==="disassembler"){
      if (ownerId) return;
      const resolve=desktop?.resolveFileAbsolutePath;if(!resolve)return;
      void resolve(input).then(absolute=>{onOpenDisassembler(absolute);}).catch(cause=>notice(`IDA: ${messageOf(cause)}`,"alert"));return;
    }
    if (action.type === "copyAbsolute") {
      const resolve = desktop?.resolveFileAbsolutePath;
      if (resolve === undefined) return;
      void resolve(input)
        .then((absolute) => navigator.clipboard.writeText(absolute))
        .then(() => notice(zh ? "已复制绝对路径" : "Copied absolute path", "check"))
        .catch((cause) => notice(zh ? `操作失败：${messageOf(cause)}` : `Action failed: ${messageOf(cause)}`, "alert"));
      return;
    }
    const run = (invoke: () => Promise<WorkspaceFileActionResult>, openedText: string): void => {
      void invoke()
        .then((result) => {
          if (result.status === "cancelled") {
            notice(zh ? "已取消选择打开器" : "App picker cancelled", "info");
            return;
          }
          if (result.status === "failed") {
            notice(zh ? `操作失败：${result.message}` : `Action failed: ${result.message}`, "alert");
            return;
          }
          notice(openedText, "check");
        })
        .catch((cause) => notice(zh ? `操作失败：${messageOf(cause)}` : `Action failed: ${messageOf(cause)}`, "alert"));
    };
    if (action.type === "open" || action.type === "openSystem") {
      const open = desktop?.openFile;
      if (open === undefined) return;
      run(() => open(input), zh ? `已用默认程序打开 ${target.name}` : `Opened ${target.name} with default app`);
      return;
    }
    if (action.type === "openWith") {
      const openWith = desktop?.openFileWith;
      if (openWith === undefined) return;
      run(() => openWith({ ...input, openerId: action.openerId as "vscode" | "cursor" | "windsurf" | "choose" }), zh ? `已用所选程序打开 ${target.name}` : `Opened ${target.name} with selected app`);
      return;
    }
    if (action.type === "reveal") {
      const reveal = desktop?.revealFileInFileManager;
      if (reveal === undefined) return;
      const manager = zh
        ? (PLATFORM === "darwin" ? "访达" : "资源管理器")
        : (PLATFORM === "darwin" ? "Finder" : "Explorer");
      run(() => reveal(input), target.kind === "dir"
        ? (zh ? `已在${manager}中打开 ${target.name}` : `Opened ${target.name} in ${manager}`)
        : (zh ? `已在${manager}中定位 ${target.name}` : `Revealed ${target.name} in ${manager}`));
    }
  };

  return { fileOpeners, fileShellUnavailable, runFileShellAction };
}
