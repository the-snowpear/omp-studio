import { useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../../icons";
import { MOTION_MS } from "../../motion";
import type { ReplaySpeed } from "./deckState";
import { useFrameLoop } from "./motionKit";

const SPEEDS: readonly ReplaySpeed[] = [1, 4, 16];
/** At 1× the whole recorded range replays in a minute; faster speeds divide it. */
const REPLAY_RANGE_MS = 60_000;

export type ReplayRange = { readonly start: number; readonly end: number };

export function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Advances the replay instant while playing. By time, the range plays at a
 * pace relative to its length; by event, the instant hops from one start, end
 * or stage change to the next. Reaching the present ends the replay.
 */
export function useReplayDriver({ playing, replay, range, speed, byEvent, events, anchor, onReplay, onStop }: {
  playing: boolean; replay: number | null; range: ReplayRange; speed: ReplaySpeed; byEvent: boolean; events: readonly number[];
  anchor: { current: Element | null }; onReplay: (at: number | null) => void; onStop: () => void;
}) {
  const clock = useRef({ last: 0, at: replay ?? range.start, hop: 0 });
  if (!playing) clock.current = { last: 0, at: replay ?? range.start, hop: 0 };
  useFrameLoop(playing, anchor, now => {
    const state = clock.current;
    const dt = state.last ? Math.min(100, now - state.last) : 0;
    state.last = now;
    if (byEvent) {
      state.hop += dt;
      if (state.hop < MOTION_MS.hero * 2 / Math.sqrt(speed)) return true;
      state.hop = 0;
      const next = events.find(instant => instant > state.at + 1);
      if (next === undefined || next >= range.end) { onReplay(null); onStop(); return false; }
      state.at = next;
    } else {
      state.at += dt * (range.end - range.start) / REPLAY_RANGE_MS * speed;
      if (state.at >= range.end) { onReplay(null); onStop(); return false; }
    }
    onReplay(state.at);
    return true;
  });
}

export function TimeScrubber({ range, replay, playing, speed, byEvent, events, onReplay, onPlaying, onSpeed, onByEvent, d, compact }: {
  range: ReplayRange;
  replay: number | null;
  playing: boolean;
  speed: ReplaySpeed;
  byEvent: boolean;
  events: readonly number[];
  onReplay: (at: number | null) => void;
  onPlaying: (playing: boolean) => void;
  onSpeed: (speed: ReplaySpeed) => void;
  onByEvent: (byEvent: boolean) => void;
  d: (key: string, params?: Record<string, string | number>) => string;
  compact?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = Math.max(1, range.end - range.start);
  const at = replay ?? range.end;
  const ratio = Math.max(0, Math.min(1, (at - range.start) / span));
  const seek = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const next = range.start + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * span;
    onReplay(next >= range.end - span * 0.005 ? null : next);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    onPlaying(false);
    seek(event.clientX);
  };
  const step = (direction: 1 | -1) => {
    onPlaying(false);
    const list = direction > 0 ? events.filter(instant => instant > at + 1) : events.filter(instant => instant < at - 1).reverse();
    const next = list[0];
    onReplay(next === undefined || next >= range.end ? (direction > 0 ? null : range.start) : next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const unit = span / 100;
    if (event.key === "ArrowLeft") onReplay(Math.max(range.start, at - unit * (event.shiftKey ? 10 : 1)));
    else if (event.key === "ArrowRight") { const next = at + unit * (event.shiftKey ? 10 : 1); onReplay(next >= range.end ? null : next); }
    else if (event.key === "Home") onReplay(range.start);
    else if (event.key === "End") onReplay(null);
    else return;
    event.preventDefault();
    onPlaying(false);
  };
  const live = replay === null;
  return <div className="ad-scrub" data-compact={compact || undefined} data-live={live || undefined}>
    <div className="ad-scrub-buttons">
      <button type="button" className="icon-btn small" aria-label={d("replay.back")} data-tip={d("replay.back")} onClick={() => step(-1)}><Icon name="rewind" extra="sm" /></button>
      <button type="button" className="ad-play" aria-label={playing ? d("replay.pause") : d("replay.play")} data-tip={playing ? d("replay.pause") : d("replay.play")}
        aria-pressed={playing} onClick={() => { if (!playing && live) onReplay(range.start); onPlaying(!playing); }}>
        <Icon name={playing ? "pause" : "play"} extra="sm" />
      </button>
      <button type="button" className="icon-btn small ad-flip-x" aria-label={d("replay.step")} data-tip={d("replay.step")} onClick={() => step(1)}><Icon name="rewind" extra="sm" /></button>
    </div>
    <div className="ad-scrub-track" ref={trackRef} role="slider" tabIndex={0} aria-label={d("replay.scrub")}
      aria-valuemin={range.start} aria-valuemax={range.end} aria-valuenow={Math.round(at)} aria-valuetext={live ? d("replay.live") : clockLabel(at)}
      onPointerDown={onPointerDown} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seek(event.clientX); }}
      onKeyDown={onKeyDown}>
      <span className="ad-scrub-rail" aria-hidden="true">
        {events.map(instant => <i key={instant} style={{ left: `${((instant - range.start) / span * 100).toFixed(2)}%` }} data-past={instant <= at || undefined} />)}
      </span>
      <span className="ad-scrub-fill" style={{ inlineSize: `${(ratio * 100).toFixed(2)}%` }} aria-hidden="true" />
      <span className="ad-scrub-thumb" style={{ left: `${(ratio * 100).toFixed(2)}%` }} aria-hidden="true" />
    </div>
    {live
      ? <span className="ad-scrub-live"><i aria-hidden="true" />{d("replay.live")}</span>
      : <button type="button" className="ad-scrub-time" data-tip={d("replay.exit")} aria-label={d("replay.exit")} onClick={() => { onPlaying(false); onReplay(null); }}>{clockLabel(at)}</button>}
    {compact ? null : <div className="ad-scrub-opts">
      <span className="seg ad-seg" role="group" aria-label={d("replay.speed")}>
        {SPEEDS.map(value => <button key={value} type="button" className={speed === value ? "active" : undefined} aria-pressed={speed === value} onClick={() => onSpeed(value)}>{value}×</button>)}
      </span>
      <button type="button" className="ad-toggle" aria-pressed={byEvent} data-tip={byEvent ? d("replay.byTime") : d("replay.byEvent")} onClick={() => onByEvent(!byEvent)}>{d("replay.byEvent")}</button>
    </div>}
  </div>;
}
