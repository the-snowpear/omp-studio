import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { isSystemFilePath } from "@omp-studio/client-contract";
import { useConversationView } from "../conversationWorkspace/Context";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewFile, previewFileBlob, previewPathKind } from "../preview/filesPreview";
import { useOpenFileBrowser } from "../fileBrowser/fileBrowserLinks";
import { useI18n } from "../i18n";
import { parseFileReference, relativeFileReference, type FileReference } from "./fileTypes";
import { resolvePathOnOpen, useFilePathKind } from "./pathResolution";

/** `rect`: open a new file window floating there (workbench coordinates), e.g. where an Explorer row was dropped. */
export interface FileOpenIntent extends FileReference { source?: "system"; workspaceId?: string; ownerId?: string; targetId?: string | null; onOpened?: () => void; rect?: { x: number; y: number; width: number; height: number } }
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
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [opening, setOpening] = useState(false), [failure, setFailure] = useState<"missing" | "unavailable">();
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
  const { kind: reported, refresh } = useFilePathKind(probe ? path : undefined, target);
  const kind = path === null ? undefined : preview ? previewPathKind(path) : isNetworkPath(path) ? "deferred" : reported;
  useEffect(() => { setFailure(undefined); }, [path, targetId, workspaceId, preview]);
  useEffect(() => { if (kind === "file" || kind === "directory") setFailure(undefined); }, [kind]);
  if (!reference || path === null) return <>{children}</>;
  const message = failure === "missing" ? (zh ? "路径不存在" : "Path does not exist")
    : failure === "unavailable" ? (zh ? "暂时无法确认此路径，请重试" : "Unable to resolve this path right now. Try again.") : undefined;
  const clickable = kind === "file" || kind === "directory" || kind === "deferred";
  return <span className="file-path-reference" onMouseEnter={preview ? undefined : refresh}>
    {clickable ? <a href={href} className={`file-reference${kind === "directory" ? " is-directory" : kind === "deferred" ? " is-deferred" : ""}`}
      aria-busy={opening || undefined} data-tip={opening ? (zh ? "正在确认路径…" : "Checking path…") : kind === "deferred" ? (zh ? "点击确认并打开此路径" : "Check and open this path") : undefined}
      onFocus={preview ? undefined : refresh} onClick={async event => {
        event.preventDefault();
        if (opening) return;
        setOpening(true); setFailure(undefined);
        try {
          const resolved = preview ? kind : await resolvePathOnOpen(owner, path, target);
          if (resolved === "directory") openBrowser({ path, ...(workspaceId ? { workspaceId } : {}), targetId });
          else if (resolved === "file") {
            if (!open({ ...reference, path, ...(workspaceId === undefined ? {} : { workspaceId }), targetId, ...(system ? { source: "system" } : {}) })) setFailure("unavailable");
          } else setFailure(resolved === "missing" ? "missing" : "unavailable");
        } finally { setOpening(false); }
      }}>{children}</a> : children}
    {message ? <span className="file-path-notice" role="status">{message}</span> : null}
  </span>;
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
  const isSystem = context?.source === "system" || isSystemFilePath(path);
  useEffect(() => {
    setUrl(undefined);
    let active = true, id: string | undefined, blob: string | undefined;
    if (preview) {
      void previewFileBlob(previewFile(path, workspaceId ?? "preview")).then(value => { if (value && active) { blob = URL.createObjectURL(value); setUrl(blob); } });
      return () => { active = false; if (blob) URL.revokeObjectURL(blob); };
    }
    const api = globalThis.ompStudioChrome?.files;
    if (globalThis.OMP_STUDIO_WEB_ENTRY && !network && (isSystem || workspaceId)) {
      setUrl(`/api/web/file?${new URLSearchParams({ workspaceId: workspaceId ?? "", path, ...(isSystem ? { source: "system" } : {}) })}`);
      return;
    }
    if (network || !api || !workspaceId && !isSystem) return;
    void api.open({ targetId, workspaceId: isSystem ? "" : (workspaceId ?? ""), path, ...(isSystem ? { source: "system" } : {}) }).then(resource => { id = resource.id; if (active) setUrl(resource.url); else void api.release(id); }).catch(() => { if (active) setUrl(undefined); });
    return () => { active = false; if (id) void api.release(id); };
  }, [path, network, isSystem, preview, targetId, workspaceId]);
  if (!preview && network) return <FileLink href={src}>{alt || src}</FileLink>;
  return url ? <img src={url} alt={alt} decoding="async" /> : <span className="file-muted">{alt || src}</span>;
}
