import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  PREVIEW_MODE_SWITCH_ENABLED,
  previewMarksHidden,
  readStoredPreviewMode,
  writeStoredPreviewMode,
} from "./mode";

export type PreviewModeValue = {
  readonly enabled: boolean;
  readonly preview: boolean;
  /**
   * 是否显示「演示 / 预览」提示。`false` 只出现在带 `?marks=off` 的预览数据
   * 启动（启动预览版.cmd）里：读的是 fixture，但页面按真实产品呈现。
   */
  readonly marks: boolean;
  readonly setPreview: (next: boolean) => void;
};

const PreviewModeContext = createContext<PreviewModeValue>({
  enabled: false,
  preview: false,
  marks: true,
  setPreview: () => undefined,
});

function previewForcedByQuery(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("preview") === "1";
  } catch {
    return false;
  }
}

export function PreviewModeProvider({
  children,
  switchEnabled = PREVIEW_MODE_SWITCH_ENABLED,
}: {
  children: ReactNode;
  /** Tests keep the switch so fixture surfaces stay exercisable after ship. */
  switchEnabled?: boolean;
}) {
  const forced = previewForcedByQuery();
  const [stored, setStored] = useState(() => (forced ? true : (switchEnabled ? readStoredPreviewMode() : false)));
  const preview = forced || (switchEnabled ? stored : false);
  const marks = !previewMarksHidden();

  useEffect(() => {
    document.documentElement.setAttribute("data-preview", preview ? "on" : "off");
    document.documentElement.setAttribute("data-preview-marks", marks ? "on" : "off");
  }, [marks, preview]);

  const setPreview = useCallback((next: boolean) => {
    if (!switchEnabled) return;
    setStored(next);
    writeStoredPreviewMode(next);
  }, [switchEnabled]);

  const value = useMemo<PreviewModeValue>(
    () => ({ enabled: switchEnabled, preview, marks, setPreview }),
    [marks, preview, setPreview, switchEnabled],
  );

  return <PreviewModeContext.Provider value={value}>{children}</PreviewModeContext.Provider>;
}

export function usePreviewMode(): PreviewModeValue {
  return useContext(PreviewModeContext);
}

/** Parked workspaces keep their own data source while the global switch changes. */
export function PreviewSurface({ preview, children }: { preview: boolean; children: ReactNode }) {
  const mode = usePreviewMode();
  const value = useMemo(() => ({ ...mode, preview }), [mode, preview]);
  return <PreviewModeContext.Provider value={value}>{children}</PreviewModeContext.Provider>;
}
