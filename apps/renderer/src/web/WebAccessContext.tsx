import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { usePreviewMode } from "../preview/PreviewContext";
import { useAppSettings, type WebControlPosition } from "../settings/appSettings";

type WebAccessUi = {
  open: boolean;
  setOpen: (open: boolean) => void;
  visible: boolean;
  setVisible: (visible: boolean) => void;
  position: WebControlPosition | null;
  setPosition: (position: WebControlPosition | null) => void;
};

const WebAccessContext = createContext<WebAccessUi>({
  open: false,
  setOpen: () => {},
  visible: false,
  setVisible: () => {},
  position: null,
  setPosition: () => {},
});

export function WebAccessProvider({ children }: { children: ReactNode }) {
  const { preview } = usePreviewMode();
  const { settings, update } = useAppSettings();
  const [open, setOpen] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewPosition, setPreviewPosition] = useState<WebControlPosition | null>(null);
  const setPosition = useCallback((position: WebControlPosition | null) => {
    if (preview) setPreviewPosition(position);
    else update({ webAccessPosition: position });
  }, [preview, update]);
  return <WebAccessContext.Provider value={{
    open,
    setOpen,
    visible: preview ? previewVisible : settings.webAccessVisible,
    setVisible: visible => preview ? setPreviewVisible(visible) : update({ webAccessVisible: visible }),
    position: preview ? previewPosition : settings.webAccessPosition,
    setPosition,
  }}>{children}</WebAccessContext.Provider>;
}

export function useWebAccessUi(): WebAccessUi {
  return useContext(WebAccessContext);
}
