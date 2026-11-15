import { useEffect, useMemo, useState } from "react";
import type { WorkspaceId } from "@omp-studio/client-contract";
import { PanelInstances } from "../dock/PanelRegistration";
import { useDockEngine } from "../dock/DockContext";
import { useConversationView } from "../conversationWorkspace/Context";
import { useExecutionTargets } from "../workspaces/ExecutionTargets";
import { useI18n } from "../i18n";
import { hostErrorMessage } from "../hostError";
import { useOpenFile } from "../files/fileLinks";
import type { FileViewerActions } from "../files/fileActions";
import { usePreviewMode } from "../preview/PreviewContext";
import { createPreviewFileBrowserSource, previewProjectFile } from "../preview/fileBrowserPreview";
import { FileBrowserPanel, type FileBrowserSystemAction } from "./FileBrowserPanel";
import { createHostFileBrowserSource, systemFileReference } from "./fileBrowserSource";
import { registerFileBrowser } from "./fileBrowserLinks";
import type { FsEntry } from "./model";

/** Each instance remembers its own location; the source always belongs to this chat's Host. */
export function FileBrowserDock({ targetId, targetName, workspaceId, actions }: { targetId: string | null; targetName?: string | undefined; workspaceId?: string | undefined; actions?: FileViewerActions | undefined }) {
  const { preview } = usePreviewMode(), { resolvedLanguage } = useI18n();
  const targets = useExecutionTargets(), view = useConversationView(), { store } = useDockEngine();
  const open = useOpenFile(), language = resolvedLanguage === "zh" ? "zh" : "en";
  const [location, setLocation] = useState<{ revision: number; path?: string; error?: string }>();
  const source = useMemo(() => preview ? createPreviewFileBrowserSource(undefined, undefined, language) : createHostFileBrowserSource({
    client: () => targets.readyClient(targetId), targetId, workspaceId, language,
    label: targetId ? `SSH · ${targetName ?? targetId}` : language === "zh" ? "本机" : "Local",
  }), [preview, targets, targetId, targetName, workspaceId, language]);
  const scope = `${preview ? "preview" : "host"}:${targetId ?? "local"}`;
  useEffect(() => registerFileBrowser(view?.document.id ?? "standalone", intent => {
    store.dispatch({ type: "open", panel: "file-browser" });
    void (async () => {
      if (preview) {
        const places = await source.places();
        const path = intent.workspaceId ? `${places.projects[0]?.root ?? places.home}${places.separator}${intent.path.replaceAll("/", places.separator)}` : intent.path;
        setLocation(previous => ({ revision: (previous?.revision ?? 0) + 1, path }));
      } else {
        const client = await targets.readyClient(targetId);
        const directory = await client.query("fs.list", intent.workspaceId ? { workspaceId: intent.workspaceId as WorkspaceId, path: intent.path } : { path: intent.path });
        setLocation(previous => ({ revision: (previous?.revision ?? 0) + 1, path: directory.path }));
      }
    })().catch(error => setLocation(previous => ({ revision: (previous?.revision ?? 0) + 1, error: hostErrorMessage(error, language === "zh" ? "无法打开文件夹" : "Cannot open the folder") })));
  }), [view?.document.id, store, source, targets, targetId, preview, language]);

  const openFile = (entry: FsEntry) => {
    const intent = preview ? previewProjectFile(entry.path) ?? { source: "system" as const, path: entry.path } : systemFileReference(entry);
    open({ ...intent, targetId });
  };
  const systemActions: FileBrowserSystemAction[] = [
    ...(actions?.openProjectPath ? ["openAsProject" as const] : []),
    ...(actions?.revealInExplorer ? ["revealExplorer" as const] : []),
    ...(globalThis.ompStudioChrome?.systemFileOpen ? ["openSystem", "openWith", "reveal"] as const : []),
  ];
  const systemAction = async (action: FileBrowserSystemAction, entry: FsEntry, openerId?: string) => {
    if (action === "openAsProject") { await actions?.openProjectPath?.(entry.path, targetId); return; }
    if (action === "revealExplorer") { if (entry.workspace) actions?.revealInExplorer?.(entry.workspace.workspaceId, entry.workspace.relativePath); return; }
    const chrome = globalThis.ompStudioChrome!;
    const result = await (action === "openSystem" ? chrome.systemFileOpen({ path: entry.path }) : action === "openWith"
      ? chrome.systemFileOpenWith({ path: entry.path, openerId: openerId as "vscode" | "cursor" | "windsurf" | "choose" }) : chrome.systemFileReveal({ path: entry.path }));
    if (result.status === "failed") throw new Error(result.message);
  };
  return <PanelInstances base="file-browser">{(id, visibility) => <FileBrowserPanel key={`${scope}:${id}`} panelId={id} source={source} scope={scope} visible={visibility.visible}
    location={id === "file-browser" ? location : undefined} onOpenFile={openFile} openers={actions?.openers}
    {...(!preview ? { onSystemAction: systemAction, availableSystemActions: systemActions } : {})}
    {...(actions ? { onAddContext: (entry: FsEntry) => actions.addContext({ path: entry.workspace && entry.workspace.workspaceId === workspaceId ? entry.workspace.relativePath : entry.path, label: entry.name }) } : {})} />}</PanelInstances>;
}
