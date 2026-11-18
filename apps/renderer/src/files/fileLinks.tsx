import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useConversationView } from "../conversationWorkspace/Context";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewFile, previewFileBlob } from "../preview/filesPreview";
import { useOpenFileBrowser } from "../fileBrowser/fileBrowserLinks";
import { hasKnownFileExtension, isAbsoluteFileReference, parseFileReference, relativeFileReference, type FileReference } from "./fileTypes";
import { useFilePathKind } from "./pathResolution";

export interface FileOpenIntent extends FileReference { source?: "system"; workspaceId?: string; ownerId?: string; targetId?: string | null }
type Opener = (intent: FileOpenIntent) => void;
const openers = new Map<string, Opener>();
export function registerFileOpener(owner: string, open: Opener) { openers.set(owner, open); return () => { if (openers.get(owner) === open) openers.delete(owner); }; }
export const FileReferenceContext = createContext<((reference: FileReference) => void) | null>(null);
export const FileImageContext = createContext<{ targetId: string | null; workspaceId: string; basePath: string; preview: boolean; source?: "system" } | null>(null);
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
  const contextual = useContext(FileReferenceContext), open = useOpenFile(), openBrowser = useOpenFileBrowser();
  const view = useConversationView(), preview = usePreviewMode().preview;
  const reference = parseFileReference(href, !inline);
  const workspaceId = view?.document.ref.workspaceId, targetId = view?.document.ref.targetId ?? null;
  const { kind, resolvable } = useFilePathKind(preview ? undefined : reference?.path);
  if (!reference) return <>{children}</>;
  // A recognised extension is confident enough to link while the verdict is in flight;
  // ambiguous text such as `RSA/ECB/PKCS1Padding` waits for the Host instead of lying.
  // Preview never asks the Host, so fixture paths keep the syntax-only rule that predates resolution.
  const classified = preview ? true : kind !== undefined ? kind !== "missing" : !resolvable || hasKnownFileExtension(reference.path);
  if (!classified) return <>{children}</>;
  const directory = kind === "directory", absolute = isAbsoluteFileReference(reference.path);
  return <a href={href} className={directory ? "file-reference is-directory" : "file-reference"} onClick={event => {
    event.preventDefault();
    if (!absolute && directory && !contextual && workspaceId !== undefined && openBrowser({ path: reference.path, workspaceId: String(workspaceId), targetId })) return;
    if (contextual) contextual(reference);
    // Absolute references belong to the system file service, not the workspace one.
    else if (absolute) open({ ...reference, workspaceId: "", targetId, source: "system" });
    else open(reference);
  }}>{children}</a>;
}
export function LocalFileImage({ src, alt }: { src: string; alt: string }) {
  const context = useContext(FileImageContext), view = useConversationView(), mode = usePreviewMode();
  const [url, setUrl] = useState<string>();
  const targetId = context ? context.targetId : view?.document.ref.targetId ?? null;
  const workspaceId = context?.workspaceId ?? view?.document.ref.workspaceId;
  const preview = context?.preview ?? mode.preview;
  useEffect(() => {
    setUrl(undefined);
    const reference = parseFileReference(src, true)?.path ?? src;
    const path = context ? relativeFileReference(context.basePath, reference) : reference;
    let active = true, id: string | undefined, blob: string | undefined;
    if (preview) {
      void previewFileBlob(previewFile(path, workspaceId ?? "preview")).then(value => { if (value && active) { blob = URL.createObjectURL(value); setUrl(blob); } });
      return () => { active = false; if (blob) URL.revokeObjectURL(blob); };
    }
    const api = globalThis.ompStudioChrome?.files;
    const isSystem = context?.source === "system" || Boolean(context && isAbsoluteFileReference(reference));
    if (!api || !workspaceId && !isSystem) return;
    void api.open({ targetId, workspaceId: isSystem ? "" : (workspaceId ?? ""), path, ...(isSystem ? { source: "system" } : {}) }).then(resource => { id = resource.id; if (active) setUrl(resource.url); else void api.release(id); }).catch(() => { if (active) setUrl(undefined); });
    return () => { active = false; if (id) void api.release(id); };
  }, [src, context?.basePath, context?.source, preview, targetId, workspaceId]);
  return url ? <img src={url} alt={alt} decoding="async" /> : <span className="file-muted">{alt || src}</span>;
}
