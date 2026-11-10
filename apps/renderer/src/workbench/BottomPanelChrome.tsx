import { DockGroupRegion } from "../dock/DockRegions";
import { useRef } from "react";
import { useBottomPanelMotion } from "../layout/useBottomPanelMotion";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "../i18n";

/* 底栏高度：默认对齐 tokens.css --bottom-panel-h；夹取对齐 ver1 工作台 120–480。 */
export const BOTTOM_PANEL_DEFAULT = 240;

export const BOTTOM_PANEL_MIN = 120;

export const BOTTOM_PANEL_MAX = 480;

export function clampBottomHeight(px: number): number {
  if (!Number.isFinite(px)) return BOTTOM_PANEL_DEFAULT;
  return Math.min(BOTTOM_PANEL_MAX, Math.max(BOTTOM_PANEL_MIN, Math.round(px)));
}

/**
 * 底栏外壳。收起/展开时 `useBottomPanelMotion` 要在动画期间保留旧结构，
 * 这会同步重渲染一次；单独成组件，重渲染就只落在这一小块，不牵动整个工作台。
 */
export function BottomPanelChrome({ visible, expanded, resizing, height, onResizePointerDown, onResizeDoubleClick, onResizeKeyDown }: {
  visible: boolean;
  expanded: boolean;
  resizing: boolean;
  height: number;
  onResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeDoubleClick: () => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const shown = useBottomPanelMotion(panelRef, visible, expanded, resizing);
  return <div ref={panelRef} className={`bottom-panel${expanded ? "" : " collapsed"}${visible ? "" : " closed"}${resizing ? " resizing" : ""}`} id="bottomPanel" inert={!visible}>
    <div className="bp-resizer" id="bpResizer" role="separator" tabIndex={0} aria-orientation="horizontal" aria-label={t("shell.resizeBottomPanel")} aria-valuemin={BOTTOM_PANEL_MIN} aria-valuemax={BOTTOM_PANEL_MAX} aria-valuenow={height} onPointerDown={onResizePointerDown} onDoubleClick={onResizeDoubleClick} onKeyDown={onResizeKeyDown} />
    <DockGroupRegion region="bottom" visible={shown.visible} expanded={shown.expanded} />
  </div>;
}
