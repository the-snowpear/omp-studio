import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useConversationView } from "../conversationWorkspace/Context";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewFile, previewFileBlob } from "../preview/filesPreview";
import { parseFileReference, relativeFileReference, type FileReference } from "./fileTypes";

export interface FileOpenIntent extends FileReference { workspaceId?: string; ownerId?: string; targetId?: string | null }
type Opener = (intent: FileOpenIntent) => void;
const openers = new Map<string, Opener>();
export function registerFileOpener(owner: string, open: Opener) { openers.set(owner, open); return () => { if (openers.get(owner) === open) openers.delete(owner); }; }
export const FileReferenceContext = createContext<((reference: FileReference) => void) | null>(null);
export const FileImageContext = createContext<{ targetId: string | null; workspaceId: string; basePath: string; preview: boolean } | null>(null);
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
  const contextual = useContext(FileReferenceContext), open = useOpenFile();
  const reference = parseFileReference(href, !inline);
  if (!reference) return <>{children}</>;
  return <a href={href} className="file-reference" onClick={event => { event.preventDefault(); if (contextual) contextual(reference); else open(reference); }}>{children}</a>;
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
    if (!api || !workspaceId) return;
    void api.open({ targetId, workspaceId, path }).then(resource => { id = resource.id; if (active) setUrl(resource.url); else void api.release(id); }).catch(() => { if (active) setUrl(undefined); });
    return () => { active = false; if (id) void api.release(id); };
  }, [src, context?.basePath, preview, targetId, workspaceId]);
  return url ? <img src={url} alt={alt} loading="lazy" /> : <span className="file-muted">{alt || src}</span>;
}
