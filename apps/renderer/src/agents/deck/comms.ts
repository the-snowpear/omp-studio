import { useEffect, useMemo, useState } from "react";
import { previewSwarmMessages } from "../../preview/agentDeckPreview";

/**
 * Agent-to-agent messages (the Runtime's IRC bus) for the Comms view and the
 * orbit's chords.
 *
 * This is the one seam the Runtime will plug into. Today the bus delivers and
 * forgets: `irc/bus.ts` keeps no history, and Studio hides every `irc:*` record
 * from operator reads, so real mode reports `unavailable` and nothing is
 * invented. When a read model exists, only the real branch below changes:
 * - `irc:relay` details `{ from, to, body }` cover peer ↔ peer traffic,
 * - `irc:incoming` details `{ from, message, replyTo }` cover messages to an agent,
 * - the main agent's own sends are `write agent://<id>` tool rows (`agent_message`).
 */
export type SwarmMessage = {
  readonly id: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly body: string;
  readonly at: number;
  readonly replyTo?: string;
  /** One leg of an `all` broadcast. */
  readonly broadcast?: boolean;
  /** An interim progress note on something the recipient asked. */
  readonly progress?: boolean;
};

export type SwarmComms =
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly messages: readonly SwarmMessage[] };

const UNAVAILABLE: SwarmComms = { status: "unavailable" };

/** Preview replays the demo thread: earlier posts are already there, later ones arrive while the deck is open. */
export function useSwarmComms(preview: boolean, zh: boolean, live: boolean): SwarmComms {
  const script = useMemo(() => preview ? previewSwarmMessages(zh) : [], [preview, zh]);
  const [now, setNow] = useState(() => Date.now());
  const next = script.find(message => message.at > now)?.at;
  useEffect(() => {
    if (!preview || !live || next === undefined) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [preview, live, next]);
  return useMemo(() => preview ? { status: "ready", messages: script.filter(message => message.at <= now) } : UNAVAILABLE, [preview, script, now]);
}
