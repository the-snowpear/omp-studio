import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import { capsFor, type CapsSubject } from "../hub/capabilities";
import { hubStatus } from "../hub/projection";
import type { Caps } from "../hub/types";
import { hostErrorMessage, waitReceipt } from "../../hostError";
import type { DeckAgent } from "./deckModel";

export type DeckNotice = {
  readonly kind: "ok" | "warn" | "err";
  readonly key: "commandPreview" | "stopRequested" | "reviveRequested" | "actionFailed";
  readonly params?: Record<string, string | number>;
  readonly detail?: string;
  readonly agentId: string;
};

export type DeckCommandContext = {
  readonly client?: StudioClient | undefined;
  readonly capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
  readonly preview: boolean;
  readonly marks?: boolean | undefined;
  /** The roster is the live session (not history, not the last state before a disconnect). */
  readonly viewingLive: boolean;
  readonly online: boolean;
  /** The live Runtime session the roster belongs to; its agent messages are read under it. */
  readonly sessionId?: string | undefined;
};

function subject(row: DeckAgent): CapsSubject {
  return {
    kind: row.agent.kind,
    status: hubStatus(row.agent.status),
    rawStatus: row.agent.status,
    readOnly: row.agent.readOnly === true,
    ...(row.agent.isolated === undefined ? {} : { isolated: row.agent.isolated }),
    ...(row.agent.canRevive === undefined ? {} : { canRevive: row.agent.canRevive }),
  };
}

/**
 * Stop and revive, gated exactly as Agent Hub gates them (`capsFor`) and sent
 * the way Agent Hub sends them: one command with the generation the user saw,
 * then the receipt. Preview never reaches the Host; it answers with a notice.
 */
export function useDeckCommands(context: DeckCommandContext, zh: boolean) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<DeckNotice | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  const zhRef = useRef(zh);
  zhRef.current = zh;

  useEffect(() => {
    if (notice === null || notice.kind === "err") return;
    const timer = window.setTimeout(() => setNotice(current => current === notice ? null : current), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const caps = useCallback((row: DeckAgent): Caps => {
    const { capabilities, online, preview, marks = true, viewingLive, client } = contextRef.current;
    return capsFor(subject(row), online, capabilities, client !== undefined, preview, viewingLive, zhRef.current, marks);
  }, []);

  const run = useCallback(async (kind: "kill" | "revive", row: DeckAgent): Promise<boolean> => {
    const { client, preview, marks = true } = contextRef.current;
    if (preview) {
      if (marks) setNotice({ kind: "warn", agentId: row.id, key: "commandPreview" });
      return false;
    }
    if (!client) return false;
    setBusy(row.id);
    try {
      const input = { agentId: row.agent.agentId, expectedGeneration: row.agent.generation };
      const handle = kind === "kill" ? await client.command("agent.kill", input) : await client.command("agent.revive", input);
      await waitReceipt(client, handle.requestId);
      setNotice({ kind: "ok", agentId: row.id, key: kind === "kill" ? "stopRequested" : "reviveRequested", params: { name: row.name } });
      return true;
    } catch (error) {
      setNotice({ kind: "err", agentId: row.id, key: "actionFailed", detail: hostErrorMessage(error, "") });
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  return { caps, run, busy, notice, dismiss: () => setNotice(null) };
}
