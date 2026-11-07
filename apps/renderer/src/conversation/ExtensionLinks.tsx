import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import { BrowserLink } from "../browser/browserLinks";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_EXTENSION_SCHEMES } from "../preview/runtimeViewsPreview";
import { waitReceipt } from "../hostError";

interface LinkOwner { schemes: readonly string[]; activate?: ((url: string) => Promise<void>) | undefined }
const Context = createContext<LinkOwner>({ schemes: [] });

export function ExtensionLinksProvider({ client, actions, sessionId, sourceSessionId, agentId, enabled, children }: {
  client?: Pick<StudioClient, "query"> | null | undefined; actions?: Pick<StudioClient, "command" | "subscribe"> | null | undefined; sessionId?: string | undefined; sourceSessionId?: string | undefined;
  agentId?: string | undefined; enabled?: boolean | undefined; children: ReactNode;
}) {
  const { preview } = usePreviewMode();
  const [schemes, setSchemes] = useState<readonly string[]>([]);
  const target = useMemo(() => ({ sessionId: sessionId ?? "", ...(sourceSessionId ? { sourceSessionId } : {}), ...(agentId ? { agentId } : {}) }), [sessionId, sourceSessionId, agentId]);
  useEffect(() => {
    setSchemes([]);
    if (preview || enabled === false || !client || !sessionId) return;
    let alive = true;
    void client.query("extensions.links.list", target).then(result => { if (alive) setSchemes(result.schemes); }).catch(() => {});
    return () => { alive = false; };
  }, [client, target, preview, enabled, sessionId]);
  const value = useMemo<LinkOwner>(() => ({
    schemes: preview ? PREVIEW_EXTENSION_SCHEMES : schemes,
    activate: preview || actions ? async url => {
      if (preview || !actions || !sessionId || enabled === false) return;
      const command = await actions.command("extensions.links.activate", { ...target, url });
      const receipt = await waitReceipt<{ result: { handled: boolean } }>(actions, command.requestId, 30000);
      if (!receipt.result.handled) throw new Error("The extension no longer owns this link.");
    } : undefined,
  }), [preview, schemes, client, actions, sessionId, target, enabled]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function ExtensionAwareLink({ href, safe, children }: { href: string; safe: boolean; children: ReactNode }) {
  const owner = useContext(Context), { preview, marks } = usePreviewMode();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const colon = href.indexOf(":"), registered = colon > 0 && owner.schemes.includes(href.slice(0, colon).toLowerCase());
  if (!registered) return safe ? <BrowserLink href={href}>{children}</BrowserLink> : <span>{children}</span>;
  return <><button type="button" className="md-extension-link" disabled={busy || !owner.activate} title={preview && marks ? "演示扩展链接" : undefined} onClick={() => {
    setBusy(true); setError("");
    void owner.activate?.(href).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
  }}>{children}</button>{error ? <span role="alert" className="tc-note">{error}</span> : null}</>;
}
