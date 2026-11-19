import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceId } from "@omp-studio/client-contract";
import { PanelInstances } from "../dock/PanelRegistration";
import { useDockEngine } from "../dock/DockContext";
import { useConversationView } from "../conversationWorkspace/Context";
import { executionTargetLabel } from "../workspaces/remoteStatus";
import { useExecutionTarget, useExecutionTargets } from "../workspaces/ExecutionTargets";
import { useI18n } from "../i18n";
import { hostErrorMessage } from "../hostError";
import { useOpenFile } from "../files/fileLinks";
import type { FileViewerActions } from "../files/fileActions";
import { usePreviewMode } from "../preview/PreviewContext";
import { createPreviewFileBrowserSource, previewProjectFile } from "../preview/fileBrowserPreview";
import { FileBrowserPanel, type FileBrowserSystemAction } from "./FileBrowserPanel";
import { createHostFileBrowserSource, systemFileReference } from "./fileBrowserSource";
import { registerFileBrowser } from "./fileBrowserLinks";
import { COMPUTER, driveDisplayName, type FileBrowserSource, type FsEntry, type FsQuickKind } from "./model";

const PREVIEW_QUICK_LABELS: Record<FsQuickKind, readonly [zh: string, en: string]> = {
  home: ["demo", "demo"],
  desktop: ["桌面", "Desktop"],
  downloads: ["下载", "Downloads"],
  documents: ["文档", "Documents"],
  pictures: ["图片", "Pictures"],
};
const PREVIEW_DRIVE_LABELS: Record<string, readonly [zh: string, en: string]> = {
  系统: ["系统", "System"],
  System: ["系统", "System"],
  数据: ["数据", "Data"],
  Data: ["数据", "Data"],
  "U 盘": ["U 盘", "USB drive"],
  "USB drive": ["U 盘", "USB drive"],
};

function createDynamicPreviewSource(readLanguage: () => "zh" | "en"): FileBrowserSource {
  const base = createPreviewFileBrowserSource(undefined, undefined, readLanguage());
  const localizePlaces = async () => {
    const raw = await base.places();
    const zh = readLanguage() === "zh";
    return {
      ...raw,
      computerLabel: raw.platform === "darwin" ? (zh ? "此 Mac" : "This Mac") : (zh ? "此电脑" : "This computer"),
      quick: raw.quick.map(item => ({ ...item, label: PREVIEW_QUICK_LABELS[item.kind][zh ? 0 : 1] })),
      drives: raw.drives.map(drive => {
        const pair = PREVIEW_DRIVE_LABELS[drive.label];
        return pair ? { ...drive, label: pair[zh ? 0 : 1] } : drive;
      }),
    };
  };
  return {
    kind: "preview",
    get label() { return readLanguage() === "zh" ? "本机" : "Local"; },
    local: base.local,
    trash: base.trash,
    places: localizePlaces,
    async list(path, showHidden) {
      if (path === COMPUTER) {
        const localized = await localizePlaces();
        return {
          path,
          entries: localized.drives.map(drive => ({ name: driveDisplayName(drive, localized.separator), path: drive.path, type: "dir" as const, denied: !drive.ready })),
        };
      }
      return base.list(path, showHidden);
    },
    peek: entry => base.peek(entry),
    createFolder: (parent, name) => base.createFolder(parent, name),
    rename: (path, name) => base.rename(path, name),
    trashItems: paths => base.trashItems(paths),
  };
}

/** Each instance remembers its own location; the source always belongs to this chat's Host. */
export function FileBrowserDock({ targetId, targetName, workspaceId, actions }: { targetId: string | null; targetName?: string | undefined; workspaceId?: string | undefined; actions?: FileViewerActions | undefined }) {
  const { preview } = usePreviewMode(), { resolvedLanguage } = useI18n();
  const targets = useExecutionTargets(), view = useConversationView(), { store } = useDockEngine();
  const open = useOpenFile(), language: "zh" | "en" = resolvedLanguage === "zh" ? "zh" : "en";
  const { inventory } = useExecutionTarget();
  const contextRef = useRef({ inventory, language, workspaceId, targetId, targetName, targets });
  contextRef.current = { inventory, language, workspaceId, targetId, targetName, targets };
  const [location, setLocation] = useState<{ revision: number; path?: string; error?: string; targetId: string | null }>();
  const browserTarget = location ? location.targetId : targetId;
  const source = useMemo(
    () =>
      preview
        ? createDynamicPreviewSource(() => contextRef.current.language)
        : createHostFileBrowserSource({
            client: () => contextRef.current.targets.readyClient(browserTarget),
            targetId: browserTarget,
            workspaceId: () => contextRef.current.workspaceId,
            language: () => contextRef.current.language,
            label: () => {
              const context = contextRef.current;
              if (!browserTarget) return context.language === "zh" ? "本机" : "Local";
              const profile = context.inventory.profiles.find(item => item.id === browserTarget);
              const name = profile?.name ?? (browserTarget === context.targetId ? context.targetName : undefined) ?? browserTarget;
              return executionTargetLabel(profile?.kind ?? "ssh", name);
            },
          }),
    [preview, browserTarget],
  );
  const scope = `${preview ? "preview" : "host"}:${browserTarget ?? "local"}`;
  useEffect(() => registerFileBrowser(view?.document.id ?? "standalone", intent => {
    const openTarget = intent.targetId === undefined ? targetId : intent.targetId;
    store.dispatch({ type: "open", panel: "file-browser" });
    void (async () => {
      if (preview) {
        const places = await source.places();
        const path = intent.workspaceId ? `${places.projects[0]?.root ?? places.home}${places.separator}${intent.path.replaceAll("/", places.separator)}` : intent.path;
        setLocation(previous => ({ revision: (previous?.revision ?? 0) + 1, path, targetId: openTarget }));
      } else {
        const client = await contextRef.current.targets.readyClient(openTarget);
        const directory = await client.query("fs.list", intent.workspaceId ? { workspaceId: intent.workspaceId as WorkspaceId, path: intent.path } : { path: intent.path });
        setLocation(previous => ({ revision: (previous?.revision ?? 0) + 1, path: directory.path, targetId: openTarget }));
      }
    })().catch(error => setLocation(previous => ({ revision: (previous?.revision ?? 0) + 1, targetId: openTarget, error: hostErrorMessage(error, contextRef.current.language === "zh" ? "无法打开文件夹" : "Cannot open the folder") })));
  }), [view?.document.id, store, source, targetId, preview]);

  const openFile = (entry: FsEntry) => {
    const intent = preview ? previewProjectFile(entry.path) ?? { source: "system" as const, path: entry.path } : systemFileReference(entry);
    open({ ...intent, targetId: browserTarget });
  };
  const systemActions: FileBrowserSystemAction[] = [
    ...(actions?.openProjectPath ? ["openAsProject" as const] : []),
    ...(actions?.revealInExplorer ? ["revealExplorer" as const] : []),
    ...(globalThis.ompStudioChrome?.systemFileOpen ? ["openSystem", "openWith", "reveal"] as const : []),
  ];
  const systemAction = async (action: FileBrowserSystemAction, entry: FsEntry, openerId?: string) => {
    if (action === "openAsProject") { await actions?.openProjectPath?.(entry.path, browserTarget); return; }
    if (action === "revealExplorer") { if (entry.workspace) actions?.revealInExplorer?.(entry.workspace.workspaceId, entry.workspace.relativePath); return; }
    const chrome = globalThis.ompStudioChrome!;
    const result = await (action === "openSystem" ? chrome.systemFileOpen({ path: entry.path }) : action === "openWith"
      ? chrome.systemFileOpenWith({ path: entry.path, openerId: openerId as "vscode" | "cursor" | "windsurf" | "choose" }) : chrome.systemFileReveal({ path: entry.path }));
    if (result.status === "failed") throw new Error(result.message);
  };
  return <PanelInstances base="file-browser">{(id, visibility) => <FileBrowserPanel key={`${scope}:${id}`} panelId={id} source={source} scope={scope} workspaceId={workspaceId} visible={visibility.visible}
    location={id === "file-browser" ? location : undefined} onOpenFile={openFile} openers={actions?.openers}
    {...(!preview ? { onSystemAction: systemAction, availableSystemActions: systemActions } : {})}
    {...(actions ? { onAddContext: (entry: FsEntry) => actions.addContext({ path: entry.workspace && entry.workspace.workspaceId === workspaceId ? entry.workspace.relativePath : entry.path, label: entry.name }) } : {})} />}</PanelInstances>;
}
