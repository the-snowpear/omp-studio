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

  useEffect(() => {
    document.documentElement.setAttribute("data-preview", preview ? "on" : "off");
  }, [preview]);

  const setPreview = useCallback((next: boolean) => {
    if (!switchEnabled) return;
    setStored(next);
    writeStoredPreviewMode(next);
  }, [switchEnabled]);

  const value = useMemo<PreviewModeValue>(
    () => ({ enabled: switchEnabled, preview, setPreview }),
    [preview, setPreview, switchEnabled],
  );

  return <PreviewModeContext.Provider value={value}>{children}</PreviewModeContext.Provider>;
}

export function usePreviewMode(): PreviewModeValue {
  return useContext(PreviewModeContext);
}
