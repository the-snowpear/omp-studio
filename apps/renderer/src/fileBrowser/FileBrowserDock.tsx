import { useMemo } from "react";
import { PanelInstances } from "../dock/PanelRegistration";
import { useOpenFile } from "../files/fileLinks";
import type { FileViewerActions } from "../files/fileActions";
import { usePreviewMode } from "../preview/PreviewContext";
import { createPreviewFileBrowserSource, previewProjectFile } from "../preview/fileBrowserPreview";
import { FileBrowserPanel } from "./FileBrowserPanel";
import type { FsEntry } from "./model";

/**
 * 「文件浏览器」工具在对话 Dock 里的挂载点：每个实例（`file-browser@n`）一个正文。
 *
 * 预览模式：演示文件系统，打开文件走现有文件窗口的预览数据，加入对话走真实
 * Composer 胶囊（与 Explorer 相同）。真实模式：Host 还没有全机文件读模型，
 * 显示禁用壳和原因；接入后在这里把 Host 来源换进 `source` 即可，面板不用改。
 */
export function FileBrowserDock({ targetId, targetName, actions }: { targetId: string | null; targetName?: string | undefined; actions?: FileViewerActions | undefined }) {
  const { preview } = usePreviewMode();
  const open = useOpenFile();
  // 演示文件系统按预览会话保留：新建 / 重命名 / 回收站的结果在切换视图、移动窗口后仍在。
  const source = useMemo(() => preview ? createPreviewFileBrowserSource() : null, [preview]);
  const scope = `${preview ? "preview" : "host"}:${targetId ?? "local"}`;
  const openFile = (entry: FsEntry) => {
    const inProject = previewProjectFile(entry.path);
    open(inProject ?? { workspaceId: "preview-computer", path: entry.path.replaceAll("\\", "/") });
  };
  return <PanelInstances base="file-browser">{id => <FileBrowserPanel panelId={id} source={source} scope={scope}
    unavailable={{
      title: "文件浏览器尚未接入",
      detail: targetId ? `浏览 ${targetName ?? "远端"} 上的文件需要新版 Host 提供全机文件读取；目前可以用 Explorer 查看当前项目。` : "浏览整台电脑需要新版 Host 提供全机文件读取；目前可以用左下角 Explorer 查看当前项目。",
    }}
    {...(preview ? { onOpenFile: openFile } : {})}
    {...(actions ? { onAddContext: (entry: FsEntry) => actions.addContext({ path: entry.path, label: entry.name }) } : {})} />}</PanelInstances>;
}
