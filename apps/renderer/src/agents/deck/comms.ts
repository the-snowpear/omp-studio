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
/** Minimum gap between roster-change refreshes so bursty transitions coalesce. */
const ROSTER_THROTTLE_MS = 300;
/** Legs of one broadcast are delivered one by one; they land within this window. */
const BROADCAST_WINDOW_MS = 10_000;

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || (!document.hidden && document.visibilityState === "visible");
}

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
  const liveRef = useRef(live);
  liveRef.current = live;
  const controllerRef = useRef<{
    trigger: (throttled: boolean) => void;
    stopTimer: () => void;
  } | null>(null);

  useEffect(() => {
    if (!real || !client || !sessionId) {
      controllerRef.current = null;
      return;
    }
    let alive = true;
    let running = false;
    let pending = false;
    let loadedOnce = false;
    let lastStartAt = 0;
    let timer: number | undefined;

    const stopTimer = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };

    const schedule = (delayMs: number) => {
      stopTimer();
      if (!alive || !liveRef.current || !isDocumentVisible()) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        trigger(false);
      }, delayMs);
    };

    const run = () => {
      if (!alive || running || !liveRef.current) return;
      if (!isDocumentVisible()) {
        pending = true;
        stopTimer();
        return;
      }
      stopTimer();
      running = true;
      pending = false;
      lastStartAt = Date.now();
      void client.query("agent.messages.list", { sessionId }).then(result => {
        if (!alive) return;
        loadedOnce = true;
        setRead({ key: sessionId, comms: { status: "ready", messages: swarmMessages(result.messages), truncated: result.truncated } });
      }).catch(() => {
        if (!alive) return;
        loadedOnce = true;
        // A transient failure keeps the last read; a Runtime that cannot answer at all is unavailable.
        setRead(current => current?.key === sessionId && current.comms.status === "ready" ? current : { key: sessionId, comms: UNAVAILABLE });
      }).finally(() => {
        running = false;
        if (!alive || !liveRef.current || !isDocumentVisible()) return;
        if (pending) {
          const elapsed = Date.now() - lastStartAt;
          schedule(Math.max(0, ROSTER_THROTTLE_MS - elapsed));
        } else {
          schedule(POLL_MS);
        }
      });
    };

    const trigger = (throttled: boolean) => {
      if (!alive || !liveRef.current) return;
      if (!isDocumentVisible()) {
        pending = true;
        stopTimer();
        return;
      }
      if (running) {
        pending = true;
        return;
      }
      if (throttled && loadedOnce) {
        const elapsed = Date.now() - lastStartAt;
        if (elapsed < ROSTER_THROTTLE_MS) {
          schedule(ROSTER_THROTTLE_MS - elapsed);
          return;
        }
      }
      run();
    };

    const onVisibility = () => {
      if (!isDocumentVisible()) {
        stopTimer();
      } else if (liveRef.current) {
        trigger(false);
      }
    };

    controllerRef.current = { trigger, stopTimer };
    document.addEventListener("visibilitychange", onVisibility);
    if (liveRef.current) trigger(false);

    return () => {
      alive = false;
      stopTimer();
      controllerRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [real, client, sessionId]);

  const prevLiveRef = useRef(live);
  const prevRosterKeyRef = useRef(rosterKey);
  useEffect(() => {
    const controller = controllerRef.current;
    const wasLive = prevLiveRef.current;
    const rosterChanged = prevRosterKeyRef.current !== rosterKey;
    prevLiveRef.current = live;
    prevRosterKeyRef.current = rosterKey;
    if (!controller) return;
    if (!live) {
      controller.stopTimer();
      return;
    }
    if (!wasLive) {
      controller.trigger(false);
    } else if (rosterChanged) {
      controller.trigger(true);
    }
  }, [live, rosterKey]);

  return useMemo(() => {
    if (preview && enabled) return { status: "ready", messages: script.filter(message => message.at <= now) };
    if (!real) return UNAVAILABLE;
    return read?.key === readKey ? read.comms : LOADING;
  }, [preview, enabled, script, now, real, read, readKey]);
}

/** Roster signature for `rosterKey`: who is there and in what lifecycle state (excluding high-frequency `updatedAt`). */
export function rosterKeyOf(agents: readonly { readonly agentId: string; readonly status: string; readonly unreadCount?: number }[]): string {
  return agents.map(agent => `${agent.agentId}:${agent.status}${agent.unreadCount ? `:${agent.unreadCount}` : ""}`).join("|");
}
