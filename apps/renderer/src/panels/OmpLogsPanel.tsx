import { useEffect, useLayoutEffect, useRef, useState, type UIEvent } from "react";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { useAppSettings } from "../settings/appSettings";
import type { ShellEventLogEntry } from "../shellMemory";
import "./panels.css";

/** Column-header height, shared with `.dock-ledger-head` in panels.css. */
const HEAD_HEIGHT = 22;
/** Base row height at the default 14px output font; scales with the output ramp. */
const BASE_ROW_HEIGHT = 26;
/** Rows rendered outside the viewport so fast wheel scrolling never shows a gap. */
const OVERSCAN = 6;

const clockCache = new Map<string, string>();
const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/**
 * `MM-DD HH:MM:SS.mmm` in local time. A ledger row can belong to any day, so
 * the date stays in the cell instead of becoming a separator row that a
 * virtualized list would have to account for. Unparseable stamps fall back to
 * the raw contract string rather than inventing a time.
 */
function ledgerClock(iso: string, withMillis: boolean): string {
  const cached = clockCache.get(iso);
  if (cached !== undefined) return cached;
  let text = iso;
  const parsed = Date.parse(iso);
  if (Number.isFinite(parsed)) {
    const at = new Date(parsed);
    const day = `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
    text = withMillis ? `${day} ${time}.${pad(at.getMilliseconds(), 3)}` : `${day} ${time}`;
  }
  if (clockCache.size > 512) clockCache.clear();
  clockCache.set(iso, text);
  return text;
}

/** `command.receipt` → domain `command.` + leaf `receipt`, so the taxonomy reads at a glance. */
function splitKind(kind: string): { readonly domain: string; readonly leaf: string } {
  const dot = kind.indexOf(".");
  return dot < 0 ? { domain: "", leaf: kind } : { domain: kind.slice(0, dot + 1), leaf: kind.slice(dot + 1) };
}

/**
 * Severity is a property of the event kind, not of the payload: the transcript
 * only carries identity, so the dot marks the three kinds an operator acts on
 * and stays quiet for the rest.
 */
function kindTone(kind: string): "alert" | "warn" | "live" | "quiet" {
  if (kind === "resync.required") return "alert";
  if (kind === "interaction.required") return "warn";
  if (kind === "runtime.changed" || kind === "snapshot") return "live";
  return "quiet";
}

function EventRow({ event, top, height }: { event: ShellEventLogEntry; top: number; height: number }) {
  const { domain, leaf } = splitKind(event.kind);
  return (
    <div className="dock-row" role="row" style={{ position: "absolute", insetInline: 0, top, height }}>
      <span className="dock-cell dock-cell-time" role="cell" data-tip={event.occurredAt}>{ledgerClock(event.occurredAt, true)}</span>
      <span className="dock-cell dock-cell-seq" role="cell">{event.cursor}</span>
      <span className="dock-cell dock-cell-kind" role="cell">
        <span className="dock-tone" data-tone={kindTone(event.kind)} aria-hidden="true" />
        <span className="dock-kind">
          <span className="dock-kind-domain">{domain}</span>
          <span className="dock-kind-name">{leaf}</span>
        </span>
      </span>
    </div>
  );
}

/**
 * OMP Logs: a tail of the semantic client events the shell records.
 *
 * The host element is a fixed-size dock body, so the panel owns its own
 * geometry — masthead on top, one scrollport below — instead of inheriting a
 * document page that no longer exists. Rows are windowed against the measured
 * scrollport because the transcript keeps streaming while the panel is open.
 */
export function OmpLogsPanel({ events, preview = false }: { events: readonly ShellEventLogEntry[]; preview?: boolean }) {
  const { t } = useI18n();
  const { marks } = usePreviewMode();
  const { settings } = useAppSettings();
  const rowHeight = Math.max(BASE_ROW_HEIGHT - 2, Math.ceil(BASE_ROW_HEIGHT * settings.outputFontSize / 14));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const previousLength = useRef(events.length);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(240);
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const read = () => setViewportHeight(node.clientHeight);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // New events flash the count once; nothing else in the panel animates.
  useEffect(() => {
    if (events.length > previousLength.current) setTick(value => value + 1);
    previousLength.current = events.length;
  }, [events.length]);

  // A log tail follows the newest line while the operator is at the bottom and
  // stays put the moment they scroll up to read something.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
    setScrollTop(node.scrollTop);
  }, [events.length, rowHeight, viewportHeight]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    setScrollTop(node.scrollTop);
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 6;
  };

  const total = events.length;
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop - HEAD_HEIGHT) / rowHeight) - OVERSCAN);
  const last = Math.min(total, first + Math.ceil(Math.max(0, viewportHeight - HEAD_HEIGHT) / rowHeight) + OVERSCAN * 2);
  const rows = [];
  for (let index = first; index < last; index += 1) {
    const event = events[index];
    if (event) rows.push(<EventRow key={`${event.cursor}-${index}`} event={event} top={index * rowHeight} height={rowHeight} />);
  }

  const title = t("shell.logsTitle");
  return (
    <div className="dock-doc">
      <header className="dock-doc-mast">
        <h2 className="dock-doc-title">{title}</h2>
        <span className="dock-doc-rule" aria-hidden="true" />
        <p className="dock-doc-sub">{t("shell.ompLogsVirtualDesc")}</p>
        {preview && marks ? <span className="dock-badge-demo">{t("common.demo")}</span> : null}
        <span key={tick} className={`dock-metric${tick ? " is-tick" : ""}`}>
          <b>{total}</b>{t("shell.eventsUnit")}
        </span>
      </header>
      <div className="dock-doc-scroll" ref={scrollRef} onScroll={onScroll}>
        {total ? (
          <div className="dock-ledger dock-ledger--events" role="table" aria-label={title}>
            <div className="dock-ledger-head" role="row">
              <span className="dock-cell dock-cell-time" role="columnheader">{t("shell.ledgerTime")}</span>
              <span className="dock-cell dock-cell-seq" role="columnheader">{t("shell.ledgerSeq")}</span>
              <span className="dock-cell" role="columnheader">{t("shell.ledgerEvent")}</span>
            </div>
            <div role="rowgroup" style={{ position: "relative", height: total * rowHeight }}>
              {rows}
            </div>
          </div>
        ) : (
          <div className="dock-doc-fill">
            <div className="dock-empty">
              <Icon name="book" />
              <strong>{t("shell.logsEmptyTitle")}</strong>
              <span>{t("shell.logsEmptyDetail")}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
