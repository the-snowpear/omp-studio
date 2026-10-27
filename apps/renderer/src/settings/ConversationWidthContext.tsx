import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_APP_SETTINGS } from "../preview/settingsPreview";
import {
  CONVERSATION_WIDTH_KEYS,
  normalizeConversationCustomWidth,
  useAppSettings,
  type ConversationWidthMode,
  type ConversationWidthPreferences,
} from "./appSettings";

export type { ConversationWidthMode, ConversationWidthPreferences } from "./appSettings";

export interface ConversationWidthValue {
  readonly mode: ConversationWidthMode;
  readonly customWidth: number;
  readonly preview: boolean;
  readonly update: (patch: Partial<ConversationWidthPreferences>) => void;
  readonly reset: () => void;
}

const ConversationWidthContext = createContext<ConversationWidthValue | null>(null);

function ConversationWidthState({ children }: { children: ReactNode }) {
  const { preview } = usePreviewMode();
  const real = useAppSettings();
  const [demo, setDemo] = useState<ConversationWidthPreferences>(() => ({
    conversationWidthMode: PREVIEW_APP_SETTINGS.conversationWidthMode,
    conversationCustomWidth: PREVIEW_APP_SETTINGS.conversationCustomWidth,
  }));
  const preferences = preview ? demo : real.settings;
  const update = useCallback((patch: Partial<ConversationWidthPreferences>) => {
    // Only these display preferences cross the shared boundary; demo never writes storage.
    const next: Partial<ConversationWidthPreferences> = {
      ...(patch.conversationWidthMode === undefined ? {} : { conversationWidthMode: patch.conversationWidthMode }),
      ...(patch.conversationCustomWidth === undefined ? {} : { conversationCustomWidth: normalizeConversationCustomWidth(patch.conversationCustomWidth) }),
    };
    if (next.conversationWidthMode === undefined && next.conversationCustomWidth === undefined) return;
    if (preview) setDemo(previous => ({ ...previous, ...next }));
    else real.update(next);
  }, [preview, real.update]);
  const reset = useCallback(() => {
    if (preview) {
      setDemo({
        conversationWidthMode: PREVIEW_APP_SETTINGS.conversationWidthMode,
        conversationCustomWidth: PREVIEW_APP_SETTINGS.conversationCustomWidth,
      });
    } else {
      real.reset(CONVERSATION_WIDTH_KEYS);
    }
  }, [preview, real.reset]);
  const value = useMemo<ConversationWidthValue>(() => ({
    mode: preferences.conversationWidthMode,
    customWidth: preferences.conversationCustomWidth,
    preview,
    update,
    reset,
  }), [preferences.conversationWidthMode, preferences.conversationCustomWidth, preview, update, reset]);

  return <ConversationWidthContext.Provider value={value}>{children}</ConversationWidthContext.Provider>;
}

/** Mount inside PreviewModeProvider. A standalone SettingsPage can reuse this boundary. */
export function ConversationWidthProvider({ children }: { children: ReactNode }) {
  const existing = useContext(ConversationWidthContext);
  return existing === null ? <ConversationWidthState>{children}</ConversationWidthState> : <>{children}</>;
}

export function useConversationWidth(): ConversationWidthValue {
  const value = useContext(ConversationWidthContext);
  if (value === null) throw new Error("useConversationWidth requires ConversationWidthProvider");
  return value;
}
