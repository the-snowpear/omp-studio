import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { StudioAgentMessage } from "@omp-studio/studio-protocol";
import { previewSwarmMessages } from "../../preview/agentDeckPreview";

/**
 * Agent-to-agent messages (the Runtime's IRC bus) for the Comms view, the
 * orbit's chords and the Agent Hub's Messages tab.
 *
 * The bus itself keeps no history; `agent.messages.list` reads what each
 * recipient's session recorded (`irc:incoming`, and a parent's IRC steer). A
 * Runtime without that read, or no Runtime at all, reports `unavailable`.
 */
export type SwarmMessage = {
  readonly id: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly body: string;
  readonly at: number;
  readonly replyTo?: string;
  /** The main agent's message to everyone; `to` lists the legs that reached someone. */
  readonly broadcast?: boolean;
  /** An interim progress note on something the recipient asked. */
  readonly progress?: boolean;
};

export type SwarmComms =
  | { readonly status: "unavailable" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly messages: readonly SwarmMessage[]; readonly truncated?: boolean };

const UNAVAILABLE: SwarmComms = { status: "unavailable" };
const LOADING: SwarmComms = { status: "loading" };
/** Fallback refresh while a view is open; roster changes refresh sooner. */
const POLL_MS = 4000;
/** Legs of one broadcast are delivered one by one; they land within this window. */
const BROADCAST_WINDOW_MS = 10_000;

/**
 * One post per message: broadcast legs (one record per recipient) fold into a
 * single post, and replies to any leg point at that post.
 */
export function swarmMessages(records: readonly StudioAgentMessage[]): SwarmMessage[] {
  const posts: SwarmMessage[] = [];
  const alias = new Map<string, string>();
  const open = new Map<string, number>();
  const ids = new Set<string>();
  for (const record of records) {
    if (record.broadcast) {
      const key = `${record.from}\u0000${record.body}`;
      const index = open.get(key);
      const post = index === undefined ? undefined : posts[index];
      if (index !== undefined && post && Math.abs(record.at - post.at) <= BROADCAST_WINDOW_MS) {
        if (!post.to.includes(record.to)) posts[index] = { ...post, to: [...post.to, record.to] };
        alias.set(record.id, post.id);
        continue;
      }
      open.set(key, posts.length);
    }
    let id = record.id;
    for (let n = 2; ids.has(id); n += 1) id = `${record.id}~${n}`;
    ids.add(id);
    alias.set(record.id, id);
    posts.push({
      id, from: record.from, to: [record.to], body: record.body, at: record.at,
      ...(record.replyTo ? { replyTo: record.replyTo } : {}),
      ...(record.broadcast ? { broadcast: true } : {}),
      ...(record.progress ? { progress: true } : {}),
    });
  }
  return posts.map(post => post.replyTo === undefined ? post : { ...post, replyTo: alias.get(post.replyTo) ?? post.replyTo });
}

export type SwarmCommsSource = {
  readonly preview: boolean;
  readonly zh: boolean;
  /** A view showing the messages is open and following the live session. */
  readonly live: boolean;
  readonly client?: StudioClient | undefined;
  /** The live Runtime session the roster belongs to. */
  readonly sessionId?: string | undefined;
  /** Changes whenever the roster does; a delivery wakes or touches its recipient. */
  readonly rosterKey?: string | undefined;
  /** Off for a host that already reads the messages and passes them down. */
  readonly enabled?: boolean | undefined;
};

/** Preview replays the demo thread: earlier posts are already there, later ones arrive while the view is open. */
export function useSwarmComms({ preview, zh, live, client, sessionId, rosterKey, enabled = true }: SwarmCommsSource): SwarmComms {
  const script = useMemo(() => preview && enabled ? previewSwarmMessages(zh) : [], [preview, zh, enabled]);
  const [now, setNow] = useState(() => Date.now());
  const next = script.find(message => message.at > now)?.at;
  useEffect(() => {
    if (!preview || !live || next === undefined) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [preview, live, next]);

  const real = !preview && enabled && client !== undefined && sessionId !== undefined;
  const [read, setRead] = useState<{ key: string; comms: SwarmComms } | null>(null);
  const readKey = real ? sessionId : "";
  const latest = useRef(0);
  useEffect(() => {
    if (!real || !client || !sessionId) return;
    // A closed view keeps what it last read; an open one refreshes on roster changes and on a slow tick.
    if (!live && read?.key === sessionId) return;
    let alive = true;
    const load = () => {
      const ticket = ++latest.current;
      void client.query("agent.messages.list", { sessionId }).then(result => {
        if (!alive || ticket !== latest.current) return;
        setRead({ key: sessionId, comms: { status: "ready", messages: swarmMessages(result.messages), truncated: result.truncated } });
      }).catch(() => {
        if (!alive || ticket !== latest.current) return;
        // A transient failure keeps the last read; a Runtime that cannot answer at all is unavailable.
        setRead(current => current?.key === sessionId && current.comms.status === "ready" ? current : { key: sessionId, comms: UNAVAILABLE });
      });
    };
    load();
    const timer = live ? window.setInterval(load, POLL_MS) : undefined;
    return () => { alive = false; if (timer !== undefined) window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, client, sessionId, live, rosterKey]);

  return useMemo(() => {
    if (preview && enabled) return { status: "ready", messages: script.filter(message => message.at <= now) };
    if (!real) return UNAVAILABLE;
    return read?.key === readKey ? read.comms : LOADING;
  }, [preview, enabled, script, now, real, read, readKey]);
}

/** Roster signature for `rosterKey`: who is there, in what state, last touched when. */
export function rosterKeyOf(agents: readonly { readonly agentId: string; readonly status: string; readonly updatedAt: string }[]): string {
  return agents.map(agent => `${agent.agentId}:${agent.status}:${agent.updatedAt}`).join("|");
}
