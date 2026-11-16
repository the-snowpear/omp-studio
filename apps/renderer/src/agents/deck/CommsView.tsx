import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../icons";
import { AgentSigil } from "./AgentSigil";
import type { SwarmComms, SwarmMessage } from "./comms";
import type { DeckAgent } from "./deckModel";

/** Inline `code` spans: the only markup agents commonly put in a status line. */
function Body({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return <>{parts.map((part, index) => part.startsWith("`") && part.endsWith("`") && part.length > 2
    ? <code key={index}>{part.slice(1, -1)}</code>
    : <Fragment key={index}>{part}</Fragment>)}</>;
}

function relative(at: number, now: number, d: (key: string, params?: Record<string, string | number>) => string): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return d("time.justNow");
  if (seconds < 60) return d("time.secondsAgo", { count: seconds });
  if (seconds < 3600) return d("time.minutesAgo", { count: Math.floor(seconds / 60) });
  return d("time.hoursAgo", { count: Math.floor(seconds / 3600) });
}

export function CommsView({ comms, rows, now, replay, query, selectedId, onSelect, d }: {
  comms: SwarmComms;
  rows: readonly DeckAgent[];
  now: number;
  replay: number | null;
  query: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  d: (key: string, params?: Record<string, string | number>) => string;
}) {
  if (comms.status !== "ready") return <CommsUnavailable rows={rows} d={d} />;
  return <CommsBoard messages={comms.messages} rows={rows} now={now} replay={replay} query={query} selectedId={selectedId} onSelect={onSelect} d={d} />;
}

function CommsUnavailable({ rows, d }: { rows: readonly DeckAgent[]; d: (key: string, params?: Record<string, string | number>) => string }) {
  const pair = rows.filter(row => !row.main).slice(0, 2);
  const faces = pair.length === 2 ? pair : rows.slice(0, 2);
  return <div className="ad-comms-off" role="status">
    <div className="ad-comms-off-art" aria-hidden="true">
      {faces[0] ? <AgentSigil identity={{ id: faces[0].id, name: faces[0].name, hue: faces[0].hue, main: faces[0].main }} tone="idle" size={36} /> : <span className="ad-comms-off-ghost" />}
      <span className="ad-comms-off-wire"><i /><i /><i /></span>
      {faces[1] ? <AgentSigil identity={{ id: faces[1].id, name: faces[1].name, hue: faces[1].hue, main: faces[1].main }} tone="idle" size={36} /> : <span className="ad-comms-off-ghost" />}
    </div>
    <h3>{d("comms.unavailable")}</h3>
    <p>{d("comms.unavailableDetail")}</p>
  </div>;
}

function CommsBoard({ messages, rows, now, replay, query, selectedId, onSelect, d }: {
  messages: readonly SwarmMessage[]; rows: readonly DeckAgent[]; now: number; replay: number | null; query: string; selectedId: string | null;
  onSelect: (id: string) => void; d: (key: string, params?: Record<string, string | number>) => string;
}) {
  const byId = useMemo(() => new Map(rows.map(row => [row.id, row])), [rows]);
  const [focus, setFocus] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const cut = replay ?? Number.POSITIVE_INFINITY;
  const needle = query.trim().toLowerCase();
  const shown = messages.filter(message => message.at <= cut
    && (focus === null || message.from === focus || message.to.includes(focus))
    && (needle === "" || message.body.toLowerCase().includes(needle) || (byId.get(message.from)?.name.toLowerCase().includes(needle) ?? false)));
  const index = useMemo(() => new Map(messages.map((message, position) => [message.id, position + 1])), [messages]);
  const people = useMemo(() => {
    const counts = new Map<string, number>();
    for (const message of messages) for (const id of [message.from, ...(message.broadcast ? [] : message.to)]) counts.set(id, (counts.get(id) ?? 0) + 1);
    return rows.filter(row => counts.has(row.id)).map(row => ({ row, count: counts.get(row.id)! }));
  }, [messages, rows]);

  // Follow the newest post until the user scrolls away with a gesture; scrolling back to the end re-attaches.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const seen = useRef(shown.length);
  const [unseen, setUnseen] = useState(0);
  // Posts already there when the board opened do not animate in; later ones do.
  const initial = useRef<ReadonlySet<string> | null>(null);
  initial.current ??= new Set(messages.map(message => message.id));
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (pinned) { element.scrollTop = element.scrollHeight; seen.current = shown.length; setUnseen(0); }
    else if (shown.length > seen.current) setUnseen(shown.length - seen.current);
  }, [shown.length, pinned]);
  const unpin = () => { const element = scrollRef.current; if (element && element.scrollHeight - element.scrollTop - element.clientHeight > 24) setPinned(false); };
  const onScroll = () => {
    const element = scrollRef.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight <= 4) setPinned(true);
  };

  const name = (id: string) => byId.get(id)?.name ?? id;
  const identity = (id: string) => { const row = byId.get(id); return { id, name: row?.name ?? id, hue: row?.hue ?? 0, main: row?.main ?? false }; };
  return <div className="ad-comms">
    {people.length > 1 ? <div className="ad-comms-people" role="group" aria-label={d("comms.people")}>
      <button type="button" className="ad-person is-all" aria-pressed={focus === null} onClick={() => setFocus(null)}>{d("comms.showAll")}<span>{messages.length}</span></button>
      {people.map(({ row, count }) => <button key={row.id} type="button" className="ad-person" aria-pressed={focus === row.id}
        data-tip={d("comms.filterAgent", { name: row.name })} aria-label={d("comms.filterAgent", { name: row.name })}
        onClick={() => setFocus(current => current === row.id ? null : row.id)}>
        <AgentSigil identity={identity(row.id)} tone={row.tone} size={16} /><span>{row.name}</span><em>{count}</em>
      </button>)}
    </div> : null}
    <div className="ad-comms-scroll" ref={scrollRef} onScroll={onScroll} onWheel={event => { if (event.deltaY < 0) unpin(); }}
      onTouchMove={unpin} onKeyDown={event => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) unpin(); }} tabIndex={0}
      role="log" aria-label={d("views.comms")} aria-live="polite">
      {shown.length === 0 ? <div className="ad-empty is-inline"><Icon name="message" /><p>{d("comms.empty")}</p></div> : null}
      {shown.map(message => {
        const from = byId.get(message.from);
        const fresh = !initial.current!.has(message.id);
        const parent = message.replyTo === undefined ? undefined : messages.find(item => item.id === message.replyTo);
        const long = message.body.length > 180;
        const expanded = open.has(message.id);
        const recipients: ReactNode = message.broadcast
          ? <span className="ad-to is-all">@{d("comms.all")}</span>
          : message.to.map(to => <button key={to} type="button" className="ad-to" onClick={() => onSelect(to)} data-selected={selectedId === to || undefined}>
            <AgentSigil identity={identity(to)} tone={byId.get(to)?.tone ?? "idle"} size={14} />{name(to)}
          </button>);
        return <article key={message.id} className="ad-post" data-fresh={fresh || undefined} data-progress={message.progress || undefined}
          data-selected={selectedId !== null && (message.from === selectedId || message.to.includes(selectedId)) || undefined}>
          <button type="button" className="ad-post-face" onClick={() => onSelect(message.from)} aria-label={name(message.from)}>
            <AgentSigil identity={identity(message.from)} tone={from?.tone ?? "idle"} size={28} />
          </button>
          <div className="ad-post-main">
            <header>
              <button type="button" className="ad-post-from" onClick={() => onSelect(message.from)}>{name(message.from)}</button>
              <Icon name="arrow-r" extra="xs" />
              <span className="ad-post-to">{recipients}</span>
              {message.progress ? <span className="ad-post-tag">{d("comms.progress")}</span> : null}
              <span className="ad-post-meta"><span>#{index.get(message.id)}</span><time dateTime={new Date(message.at).toISOString()} title={new Date(message.at).toLocaleString()}>{relative(message.at, now, d)}</time></span>
            </header>
            {parent ? <blockquote className="ad-post-quote"><span>{d("comms.replyTo", { name: name(parent.from) })}</span><Body text={parent.body.length > 90 ? `${parent.body.slice(0, 89)}…` : parent.body} /></blockquote> : null}
            <p className="ad-post-body" data-clamped={long && !expanded || undefined}><Body text={message.body} /></p>
            {long ? <button type="button" className="ad-post-more" onClick={() => setOpen(current => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })}>
              {expanded ? d("comms.collapse") : d("comms.expand")}
            </button> : null}
          </div>
        </article>;
      })}
    </div>
    {!pinned ? <button type="button" className="ad-latest" onClick={() => setPinned(true)}>
      <Icon name="arrow-d" extra="sm" />{unseen > 0 ? d("comms.newCount", { count: unseen }) : d("comms.latest")}
    </button> : null}
  </div>;
}
