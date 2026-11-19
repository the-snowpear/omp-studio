import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { isSystemFilePath } from "@omp-studio/client-contract";
import { useConversationView } from "../conversationWorkspace/Context";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewFile, previewFileBlob } from "../preview/filesPreview";
import { useOpenFileBrowser } from "../fileBrowser/fileBrowserLinks";
import { hasKnownFileExtension, parseFileReference, relativeFileReference, type FileReference } from "./fileTypes";
import { resolvePathOnOpen, useFilePathKind } from "./pathResolution";

export interface FileOpenIntent extends FileReference { source?: "system"; workspaceId?: string; ownerId?: string; targetId?: string | null }
type Opener = (intent: FileOpenIntent) => void;
const openers = new Map<string, Opener>();
export function registerFileOpener(owner: string, open: Opener) { openers.set(owner, open); return () => { if (openers.get(owner) === open) openers.delete(owner); }; }
export const FileDocumentContext = createContext<{ targetId: string | null; workspaceId: string; basePath: string; preview: boolean; source?: "system" } | null>(null);
export function useOpenFile() {
  const view = useConversationView();
  return (intent: FileOpenIntent) => {
    const owner = intent.ownerId ?? view?.document.id ?? "standalone";
    const open = openers.get(owner);
    if (open) { open(intent); return true; }
    return false;
  };
}
export function FileLink({ href, children, inline = false }: { href: string; children: ReactNode; inline?: boolean }) {
  const document = useContext(FileDocumentContext), open = useOpenFile(), openBrowser = useOpenFileBrowser();
  const view = useConversationView(), mode = usePreviewMode();
  const preview = document?.preview ?? mode.preview;
  const reference = parseFileReference(href, !inline);
  const path = reference && (document ? relativeFileReference(document.basePath, reference.path) : reference.path);
  const system = document?.source === "system" || (path !== null && isSystemFilePath(path));
  const owner = view?.document.id ?? "standalone";
  const targetId = document ? document.targetId : view?.document.ref.targetId ?? null;
  const workspaceId = system ? "" : document?.workspaceId ?? view?.document.ref.workspaceId;
  const target = { targetId, workspaceId: workspaceId ?? "" };
  // Network references stay clickable and skip the automatic query.
  const probe = !preview && (system || workspaceId !== undefined) && path !== null && !isNetworkPath(path);
  const { kind, resolvable } = useFilePathKind(probe ? path : undefined, target);
  if (!reference || path === null || kind === "missing") return <>{children}</>;
  if (probe && resolvable && kind === undefined && inline && !system && !hasKnownFileExtension(path)) return <>{children}</>;
  return <a href={href} className={kind === "directory" ? "file-reference is-directory" : "file-reference"} onClick={async event => {
    event.preventDefault();
    const resolved = kind ?? (preview ? undefined : await resolvePathOnOpen(owner, path, target));
    if (resolved === "directory") {
      openBrowser({ path, ...(workspaceId ? { workspaceId } : {}), targetId });
      return;
    }
    open({ ...reference, path, ...(workspaceId === undefined ? {} : { workspaceId }), targetId, ...(system ? { source: "system" } : {}) });
  }}>{children}</a>;
}

const isNetworkPath = (path: string) => /^[\\/]{2}/.test(path);

export function LocalFileImage({ src, alt }: { src: string; alt: string }) {
  const context = useContext(FileDocumentContext), view = useConversationView(), mode = usePreviewMode();
  const [url, setUrl] = useState<string>();
  const targetId = context ? context.targetId : view?.document.ref.targetId ?? null;
  const workspaceId = context?.workspaceId ?? view?.document.ref.workspaceId;
  const preview = context?.preview ?? mode.preview;
  const reference = parseFileReference(src, true)?.path ?? src;
  const path = context ? relativeFileReference(context.basePath, reference) : reference;
  const network = isNetworkPath(path);
  const isSystem = context?.source === "system" || Boolean(context && isSystemFilePath(reference));
  useEffect(() => {
    setUrl(undefined);
    let active = true, id: string | undefined, blob: string | undefined;
    if (preview) {
      void previewFileBlob(previewFile(path, workspaceId ?? "preview")).then(value => { if (value && active) { blob = URL.createObjectURL(value); setUrl(blob); } });
      return () => { active = false; if (blob) URL.revokeObjectURL(blob); };
    }
    const api = globalThis.ompStudioChrome?.files;
    if (network || !api || !workspaceId && !isSystem) return;
    void api.open({ targetId, workspaceId: isSystem ? "" : (workspaceId ?? ""), path, ...(isSystem ? { source: "system" } : {}) }).then(resource => { id = resource.id; if (active) setUrl(resource.url); else void api.release(id); }).catch(() => { if (active) setUrl(undefined); });
    return () => { active = false; if (id) void api.release(id); };
  }, [path, network, isSystem, preview, targetId, workspaceId]);
  if (!preview && network) return <FileLink href={src}>{alt || src}</FileLink>;
  return url ? <img src={url} alt={alt} decoding="async" /> : <span className="file-muted">{alt || src}</span>;
}
