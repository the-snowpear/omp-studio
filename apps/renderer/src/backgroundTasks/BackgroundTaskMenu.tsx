import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { MenuItem, useRowMenuAnchor } from "../menus";
import { surfaceWindow, useSurfaceDocument } from "../dock/SurfaceContext";

/** Secondary process/log access without adding more controls to each compact row. */
export function BackgroundTaskMenu({ point, canOpenPage, onOpenPage, onProcess, onClose }: {
  point: { x: number; y: number }; canOpenPage: boolean;
  onOpenPage(): void; onProcess(): void; onClose(): void;
}) {
  const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const doc = useSurfaceDocument();
  const { menuRef, anchor } = useRowMenuAnchor(true, point, surfaceWindow(doc));
  useEffect(() => {
    const previous = doc.activeElement as HTMLElement | null;
    menuRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    const down = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key === "Tab") { onClose(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const index = buttons.indexOf(doc.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    doc.addEventListener("pointerdown", down); doc.addEventListener("keydown", key, true);
    return () => { doc.removeEventListener("pointerdown", down); doc.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [doc]);
  return createPortal(<div ref={menuRef} className="menu title-menu-popover bt-service-menu" role="menu" style={{ position: "fixed", top: anchor.top, left: anchor.left }} onContextMenu={event => event.preventDefault()}>
    <MenuItem icon="globe" disabled={!canOpenPage} title={!canOpenPage ? zh ? "Agent 尚未上报网页地址，或服务已经结束" : "No Agent-reported page address, or the service has ended" : undefined} onClick={onOpenPage}>{zh ? "打开网页" : "Open page"}</MenuItem>
    <MenuItem icon="console" onClick={onProcess}>{zh ? "查看启动过程" : "View process"}</MenuItem>
  </div>, doc.body);
}
