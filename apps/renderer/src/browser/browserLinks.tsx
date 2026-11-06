import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { useI18n } from "../i18n";

export interface BrowserLinkIntent { url: string; handled: boolean; }
export function isLocalDevelopmentUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  return url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "[::1]" || url.hostname === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname) || (!!url.port && /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/u.test(url.hostname));
}
export function routeBrowserLink(url: string, internal = false): boolean {
  if (!/^https?:\/\//iu.test(url) || (!internal && !isLocalDevelopmentUrl(url))) return false;
  const parsed = new URL(url);
  if (parsed.hostname === "0.0.0.0") parsed.hostname = "127.0.0.1";
  const intent: BrowserLinkIntent = { url: parsed.href, handled: false };
  window.dispatchEvent(new CustomEvent("omp:browser-link", { detail: intent }));
  return intent.handled;
}
export function openBrowserLink(url: string): void { if (!routeBrowserLink(url)) window.open(url, "_blank", "noopener,noreferrer"); }

export function BrowserLinkMenu({ url, point, onClose }: { url: string; point: { x: number; y: number }; onClose: () => void }) {
  const document = useSurfaceDocument();
  const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", key); };
  }, [document, onClose]);
  return createPortal(<div ref={ref} className="dropdown-menu browser-link-menu" role="menu" data-dock-modal="browser-link" style={{ position: "fixed", zIndex: 10000, left: Math.max(4, Math.min(point.x, (document.defaultView?.innerWidth ?? 600) - 240)), top: Math.max(4, Math.min(point.y, (document.defaultView?.innerHeight ?? 600) - 140)), width: 230 }}>
    <button type="button" className="menu-item" role="menuitem" onClick={() => { if (routeBrowserLink(url, true)) onClose(); else setError(zh ? "当前连接不支持内置浏览器" : "Managed browser unavailable for this connection"); }}>{zh ? "在内置浏览器打开" : "Open in managed browser"}</button>
    <button type="button" className="menu-item" role="menuitem" onClick={() => { window.open(url, "_blank", "noopener,noreferrer"); onClose(); }}>{zh ? "在系统浏览器打开" : "Open in system browser"}</button>
    <button type="button" className="menu-item" role="menuitem" onClick={() => { void document.defaultView?.navigator.clipboard.writeText(url); onClose(); }}>{zh ? "复制链接" : "Copy link"}</button>
    {error ? <p role="status" className="browser-error">{error}</p> : null}
  </div>, document.body);
}
export function BrowserLink({ href, children }: { href: string; children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  return <><a href={href} target="_blank" rel="noreferrer noopener" onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && routeBrowserLink(href)) event.preventDefault(); }} onContextMenu={event => { if (!/^https?:\/\//iu.test(href)) return; event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}>{children}</a>{menu ? <BrowserLinkMenu url={href} point={menu} onClose={() => setMenu(undefined)} /> : null}</>;
}
