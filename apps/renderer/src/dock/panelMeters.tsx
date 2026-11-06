import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PanelId } from "./types";

export type PanelMeterSegment = { id: string; percent: number; color: string; label: string };
export type PanelStatusCount = { id: string; count: number; color: string; label: string };
type MeterLabels = { tone: "normal" | "warning" | "danger"; label: string; detail?: string };
export type PanelStatusMeter = MeterLabels & { kind: "status"; total: number; counts: readonly PanelStatusCount[]; emptyLabel: string; note?: string; stale: boolean };
export type PanelMeter = (MeterLabels & { kind?: "usage"; percent: number | null; segments?: readonly PanelMeterSegment[] }) | PanelStatusMeter;
type Entry = { value: PanelMeter | null; listeners: Set<() => void> };

/** Transient presentation only. Bodies and dock chrome share one source, even before a body opens. */
class PanelMeters {
  private entries = new Map<PanelId, Entry>();
  get(id: PanelId): Entry {
    let entry = this.entries.get(id);
    if (!entry) { entry = { value: null, listeners: new Set() }; this.entries.set(id, entry); }
    return entry;
  }
  publish(id: PanelId, value: PanelMeter | null) {
    const entry = this.get(id);
    if (entry.value === value) return;
    entry.value = value;
    for (const listener of entry.listeners) listener();
  }
}
const Context = createContext<PanelMeters | null>(null);
export function DockMetersProvider({ children }: { children: ReactNode }) {
  const [meters] = useState(() => new PanelMeters());
  return <Context.Provider value={meters}>{children}</Context.Provider>;
}
export function DockPanelMeter({ id, value }: { id: PanelId; value: PanelMeter }) {
  const meters = useContext(Context)!;
  useLayoutEffect(() => { meters.publish(id, value); }, [meters, id, value]);
  useLayoutEffect(() => () => meters.publish(id, null), [meters, id]);
  return null;
}
export function usePanelMeter(id: PanelId) {
  const entry = useContext(Context)!.get(id);
  return useSyncExternalStore(listener => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; }, () => entry.value);
}

export function DockMeterSummary({ meter }: { meter: PanelMeter | null }) {
  if (meter?.kind === "status") return <span className="dock-status-summary" data-stale={meter.stale || undefined} aria-label={meter.label}>
    {meter.note ? <span className="dock-status-note">{meter.note}</span> : null}
    {meter.counts.length ? meter.counts.map(item => <span className="dock-status-count" key={item.id} data-status={item.id} style={{ color: item.color }}>
      <i aria-hidden="true" /><b>{item.count}</b><span>{item.label}</span>
    </span>) : <span className="dock-status-note">{meter.emptyLabel}</span>}
  </span>;
  const percent = meter?.percent;
  return <span className="dock-meter-summary" data-tone={meter?.tone ?? "normal"} aria-label={meter?.label}>
    <span className="dock-meter-value">{percent == null ? "—" : `${Math.round(percent)}%`}</span>
    <span className="dock-meter-track" aria-hidden="true"><i style={{ width: `${Math.min(100, percent ?? 0)}%` }} /></span>
  </span>;
}
export function DockMeterRing({ meter }: { meter: PanelMeter | null }) {
  let offset = 0;
  const segments = meter?.kind === "status" ? meter.counts.map(item => ({ ...item, percent: item.count / meter.total * 100 })) : meter?.segments;
  return <svg className="dock-meter-ring" viewBox="0 0 36 36" data-tone={meter?.tone ?? "normal"} data-stale={meter?.kind === "status" && meter.stale || undefined} aria-hidden="true">
    <circle className="dock-meter-ring-track" cx="18" cy="18" r="16.5" />
    {segments ? segments.map(segment => {
      const start = offset;
      const length = Math.min(segment.percent, 100 - offset);
      offset += length;
      return length > 0 ? <circle key={segment.id} className="dock-meter-ring-value is-segment" data-category={segment.id}
        cx="18" cy="18" r="16.5" pathLength="100" strokeDasharray={`${length} 100`} strokeDashoffset={-start}
        style={{ stroke: segment.color }} transform="rotate(-90 18 18)"><title>{segment.label}</title></circle> : null;
    }) : meter?.kind !== "status" && meter?.percent != null ? <circle className="dock-meter-ring-value" cx="18" cy="18" r="16.5" pathLength="100" strokeDasharray={`${Math.min(100, meter.percent)} 100`} transform="rotate(-90 18 18)" /> : null}
  </svg>;
}

export function DockMeterBadge({ meter }: { meter: PanelMeter | null }) {
  return meter?.kind === "status" && meter.total > 0
    ? <span className="dock-meter-badge" aria-hidden="true">{meter.total > 99 ? "99+" : meter.total}</span> : null;
}
