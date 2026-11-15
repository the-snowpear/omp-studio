import { useLayoutEffect, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FsEntry } from "./model";

/** Small folders keep their natural flow; large lists/columns mount only the visible rows. */
export function VirtualFileRows({ entries, selected, children }: { entries: readonly FsEntry[]; selected?: string | undefined; children(entry: FsEntry): ReactNode }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const virtual = entries.length > 80;
  const rowStyle = element?.ownerDocument.defaultView?.getComputedStyle(element);
  const rowHeight = parseFloat(rowStyle?.getPropertyValue("--fb-row") ?? "") || 28;
  const gap = parseFloat(rowStyle?.rowGap ?? "") || 0;
  const scroll = element?.parentElement ?? null;
  const rows = useVirtualizer({ count: entries.length, getScrollElement: () => scroll, estimateSize: () => rowHeight + gap,
    getItemKey: index => entries[index]!.path, overscan: 8, enabled: virtual,
  });
  const items = rows.getVirtualItems();
  useLayoutEffect(() => {
    if (!virtual || !selected) return;
    const index = entries.findIndex(entry => entry.path === selected);
    if (index >= 0) rows.scrollToIndex(index, { align: "auto" });
  }, [virtual, selected, entries, rows]);
  useLayoutEffect(() => {
    if (!virtual || !selected || !scroll?.contains(element?.ownerDocument.activeElement ?? null)) return;
    const row = [...(element?.querySelectorAll<HTMLElement>("[data-path]") ?? [])].find(row => row.dataset.path === selected);
    row?.focus({ preventScroll: true });
  }, [virtual, selected, items[0]?.index, items[items.length - 1]?.index, element, scroll]);
  return <div ref={setElement} className="fb-rows" style={virtual ? { height: rows.getTotalSize(), position: "relative" } : undefined}>
    {virtual ? items.map(item => <div key={item.key} style={{ position: "absolute", top: item.start, left: 0, width: "100%", height: rowHeight }}>{children(entries[item.index]!)}</div>) : entries.map(children)}
  </div>;
}
