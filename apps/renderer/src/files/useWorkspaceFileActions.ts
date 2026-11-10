import { useEffect, useState } from "react";
import type { WorkspaceListReadModel } from "@omp-studio/client-contract";
import type { FileMenuAction, FileMenuTarget, FileOpenerOption } from "../menus";
import type { IconName } from "../icons";
import { PLATFORM } from "../platform";

export function useWorkspaceFileActions({ workspace, remote, onNotice, onOpenIda }: {
  workspace: WorkspaceListReadModel["workspaces"][number] | undefined; remote: boolean;
  onNotice(notice: { text: string; icon: IconName }): void; onOpenIda(path: string): void;
}) {
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
  const fileShellUnavailable = remote ? "远程文件请先下载，再使用系统应用打开" : globalThis.ompStudioChrome?.openFile === undefined ? "仅桌面端可用" : undefined;

  const runFileShellAction = (workspaceId: string, action: FileMenuAction, target: FileMenuTarget) => {
    const desktop = globalThis.ompStudioChrome;
    const messageOf = (cause: unknown): string => (cause instanceof Error && cause.message ? cause.message : String(cause));
    const notice = (text: string, icon: IconName): void => {
      onNotice({ text, icon });
    };
    if (action.type === "copyRelative") {
      void navigator.clipboard
        .writeText(target.path)
        .then(() => notice("已复制相对路径", "check"))
        .catch(() => notice("复制相对路径失败", "alert"));
      return;
    }
    const input = { workspaceId, path: target.path, kind: target.kind };
    if(action.type==="ida"){
      const resolve=desktop?.resolveFileAbsolutePath;if(!resolve)return;
      void resolve(input).then(absolute=>{onOpenIda(absolute);}).catch(cause=>notice(`IDA: ${messageOf(cause)}`,"alert"));return;
    }
    if (action.type === "copyAbsolute") {
      const resolve = desktop?.resolveFileAbsolutePath;
      if (resolve === undefined) return;
      void resolve(input)
        .then((absolute) => navigator.clipboard.writeText(absolute))
        .then(() => notice("已复制绝对路径", "check"))
        .catch((cause) => notice(`操作失败：${messageOf(cause)}`, "alert"));
      return;
    }
    const run = (invoke: () => Promise<WorkspaceFileActionResult>, openedText: string): void => {
      void invoke()
        .then((result) => {
          if (result.status === "cancelled") {
            notice("已取消选择打开器", "info");
            return;
          }
          if (result.status === "failed") {
            notice(`操作失败：${result.message}`, "alert");
            return;
          }
          notice(openedText, "check");
        })
        .catch((cause) => notice(`操作失败：${messageOf(cause)}`, "alert"));
    };
    if (action.type === "open" || action.type === "openSystem") {
      const open = desktop?.openFile;
      if (open === undefined) return;
      run(() => open(input), `已用默认程序打开 ${target.name}`);
      return;
    }
    if (action.type === "openWith") {
      const openWith = desktop?.openFileWith;
      if (openWith === undefined) return;
      run(() => openWith({ ...input, openerId: action.openerId as "vscode" | "cursor" | "windsurf" | "choose" }), `已用所选程序打开 ${target.name}`);
      return;
    }
    if (action.type === "reveal") {
      const reveal = desktop?.revealFileInFileManager;
      if (reveal === undefined) return;
      const manager = PLATFORM === "darwin" ? "访达" : "资源管理器";
      run(() => reveal(input), target.kind === "dir" ? `已在${manager}中打开 ${target.name}` : `已在${manager}中定位 ${target.name}`);
    }
  };

  return { fileOpeners, fileShellUnavailable, runFileShellAction };
}
