import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { PREVIEW_MODE_SWITCH_ENABLED, readStoredPreviewMode, writeStoredPreviewMode } from "./mode";

export type PreviewModeValue = {
  readonly enabled: boolean;
  readonly preview: boolean;
  readonly setPreview: (next: boolean) => void;
};

const PreviewModeContext = createContext<PreviewModeValue>({
  enabled: false,
  preview: false,
  setPreview: () => undefined,
});

export function PreviewModeProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState(() => (PREVIEW_MODE_SWITCH_ENABLED ? readStoredPreviewMode() : false));
  const preview = PREVIEW_MODE_SWITCH_ENABLED ? stored : false;

  useEffect(() => {
    document.documentElement.setAttribute("data-preview", preview ? "on" : "off");
  }, [preview]);

  const setPreview = useCallback((next: boolean) => {
    if (!PREVIEW_MODE_SWITCH_ENABLED) return;
    setStored(next);
    writeStoredPreviewMode(next);
  }, []);

  const value = useMemo<PreviewModeValue>(
    () => ({ enabled: PREVIEW_MODE_SWITCH_ENABLED, preview, setPreview }),
    [preview, setPreview],
  );

  return <PreviewModeContext.Provider value={value}>{children}</PreviewModeContext.Provider>;
}

export function usePreviewMode(): PreviewModeValue {
  return useContext(PreviewModeContext);
}
