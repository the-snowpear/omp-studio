import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { DictationSession, dictationDesktopApi, type DictationSessionOptions } from "./dictationSession";
import { useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";

export function useDictation(options: DictationSessionOptions) {
  const document = useSurfaceDocument(), window = surfaceWindow(document);
  const api = useRef(window.ompStudioChrome);
  const [session] = useState(() => new DictationSession(options, { api: () => dictationDesktopApi(api.current) }));
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useLayoutEffect(() => { session.setOptions(options); });
  useEffect(() => { api.current = window.ompStudioChrome; session.connect(); return () => session.disconnect(); }, [session, window]);
  useEffect(() => { void session.inspect(); }, [session, options.client, options.sessionId, options.available, options.remote]);
  useEffect(() => {
    const hide = () => { if (document.hidden) void session.interrupt(); else void session.refreshRecovery(); };
    const blur = () => {
      if (["recording", "transcribing"].includes(session.getSnapshot().phase)) void session.interrupt();
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("blur", blur);
    return () => { document.removeEventListener("visibilitychange", hide); window.removeEventListener("blur", blur); };
  }, [session, document, window]);
  return { session, view };
}
