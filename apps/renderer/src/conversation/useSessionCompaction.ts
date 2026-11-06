import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionId, StudioClient, ThreadId } from "@omp-studio/client-contract";
import { parseSessionCompactionInput, type SessionCompactionRead, type SessionCompactionState } from "@omp-studio/studio-protocol";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { ensureSelectedSessionActive } from "../sessionLifecycle";
import { previewSessionCompaction } from "../preview/contextCardPreview";

export type CompactionControlState = SessionCompactionRead & Partial<Omit<SessionCompactionState, keyof SessionCompactionRead>>;

export function useSessionCompaction({ client, sessionId, threadId, liveSessionId, enabled, visible, preview, contextWindow, refreshKey }: {
  client: StudioClient; sessionId: string | undefined; threadId: ThreadId | undefined; liveSessionId: string | undefined;
  enabled: boolean; visible: boolean; preview: boolean; contextWindow: number | undefined; refreshKey?: string | undefined;
}) {
  const [state, setState] = useState<CompactionControlState>();
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const identity = useRef({ client, sessionId, preview });
  identity.current = { client, sessionId, preview };
  const matches = useCallback((owner: typeof identity.current) => owner.client === identity.current.client && owner.sessionId === identity.current.sessionId && owner.preview === identity.current.preview, []);
  const invoke = useCallback(async (kind: "session.compaction.get" | "session.compaction.set", id: string, input = "") => {
    const handle = kind === "session.compaction.get" ? await client.command(kind, { sessionId: id })
      : await client.command(kind, { sessionId: id, input });
    return (await waitReceipt<{ result: SessionCompactionState }>(client, handle.requestId)).result;
  }, [client]);

  useEffect(() => { setState(undefined); setError(""); setSaving(false); }, [client, sessionId, preview]);
  useEffect(() => {
    if (!visible || !sessionId || saving || !enabled && !preview) { setLoading(false); return; }
    if (preview) { setState(previewSessionCompaction(sessionId, contextWindow ?? 0)); return; }
    let cancelled = false;
    setLoading(true); setError("");
    const read = sessionId === liveSessionId ? invoke("session.compaction.get", sessionId)
      : client.query("session.compaction.read", { sessionId: sessionId as SessionId });
    void read.then(value => { if (!cancelled) setState(value); })
      .catch(cause => { if (!cancelled) setError(hostErrorMessage(cause, "无法读取会话阈值 / Could not read session threshold")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, sessionId, liveSessionId, preview, enabled, visible, contextWindow, refreshKey, saving, invoke]);

  const save = async (input: string): Promise<boolean> => {
    if (!sessionId || saving || !enabled && !preview) return false;
    const owner = identity.current;
    setSaving(true); setError("");
    try {
      let value: SessionCompactionState;
      if (preview) value = previewSessionCompaction(sessionId, contextWindow ?? 0, parseSessionCompactionInput(input));
      else {
        await ensureSelectedSessionActive(client, {
          ...(liveSessionId ? { activeSessionId: liveSessionId as SessionId } : {}),
          selectedSessionId: sessionId as SessionId,
          ...(threadId ? { selectedThreadId: threadId } : {}),
        });
        if (!matches(owner)) return false;
        value = await invoke("session.compaction.set", sessionId, input);
      }
      if (!matches(owner)) return false;
      setState(value);
      return true;
    } catch (cause) {
      if (matches(owner)) setError(hostErrorMessage(cause, "保存失败，请重试 / Could not save threshold"));
      return false;
    } finally { if (matches(owner)) setSaving(false); }
  };
  return { state: state?.sessionId === sessionId ? state : undefined, loading, saving, error, save };
}
