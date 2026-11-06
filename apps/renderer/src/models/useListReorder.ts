import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type DragRow = {
  id: string;
  el: HTMLElement;
  relTop: number;
  height: number;
};

function siblingShift(index: number, origin: number, over: number, slot: number): number {
  if (origin < over && index > origin && index <= over) return -slot;
  if (origin > over && index >= over && index < origin) return slot;
  return 0;
}

function insertionIndex(items: ReadonlyArray<DragRow>, visualCenterRel: number): number {
  if (items.length === 0) return 0;
  for (let index = 0; index < items.length - 1; index++) {
    const current = items[index];
    const next = items[index + 1];
    if (!current || !next) continue;
    const boundary = (current.relTop + current.height / 2 + next.relTop + next.height / 2) / 2;
    if (visualCenterRel < boundary) return index;
  }
  return items.length - 1;
}

function destinationTranslateY(items: ReadonlyArray<DragRow>, originIndex: number, overIndex: number, gap: number): number {
  const dragged = items[originIndex];
  if (!dragged) return 0;
  const visible = items.map((item) => item.id);
  const nextVisible = visible.slice();
  const [moved] = nextVisible.splice(originIndex, 1);
  if (!moved) return 0;
  nextVisible.splice(overIndex, 0, moved);
  const heightById = new Map(items.map((item) => [item.id, item.height]));
  let top = items[0]?.relTop ?? 0;
  for (const id of nextVisible) {
    if (id === dragged.id) break;
    top += (heightById.get(id) ?? 0) + gap;
  }
  return top - dragged.relTop;
}

/** Shared pointer mechanics; each list retains its own ordering and persistence policy. */
export function useListReorder({ order, selector, gap, sortingClass, onReorder }: {
  order: readonly string[];
  selector: string;
  gap: number;
  sortingClass: string;
  onReorder: (from: number, to: number, visible: readonly string[]) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragLockRef = useRef(false);
  const settleGenRef = useRef(0);
  const clearDragStylesRef = useRef(false);
  const drop = useRef(onReorder);
  drop.current = onReorder;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragPhase, setDragPhase] = useState<"dragging" | "settling">("dragging");

  useLayoutEffect(() => {
    if (!clearDragStylesRef.current) return;
    clearDragStylesRef.current = false;
    const root = listRef.current;
    if (!root) return;
    const rows = root.querySelectorAll<HTMLElement>(selector);
    for (const el of rows) {
      el.style.transition = "transform 0s";
      el.style.transform = "";
    }
    void root.offsetHeight;
    for (const el of rows) {
      el.style.removeProperty("transition");
      el.style.removeProperty("transform");
    }
  }, [draggingId, order, selector]);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    if (dragLockRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const root = listRef.current;
    if (!root) return;
    const listRect = root.getBoundingClientRect();
    const items: DragRow[] = [...root.querySelectorAll<HTMLElement>(selector)].flatMap((el) => {
      const rowId = el.dataset.id;
      if (!rowId) return [];
      const rect = el.getBoundingClientRect();
      return [{ id: rowId, el, relTop: rect.top - listRect.top, height: rect.height }];
    });
    const originIndex = items.findIndex((item) => item.id === id);
    const dragged = items[originIndex];
    if (originIndex < 0 || !dragged) return;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    dragLockRef.current = true;
    settleGenRef.current += 1;
    setDragPhase("dragging");
    setDraggingId(id);
    document.body.classList.add(sortingClass);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    const startY = event.clientY;
    const slot = dragged.height + gap;
    let overIndex = originIndex;

    const applyShifts = (over: number) => {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (!item || index === originIndex) continue;
        const shift = siblingShift(index, originIndex, over, slot);
        item.el.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : "";
      }
    };

    const stopCursor = () => {
      document.body.classList.remove(sortingClass);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
    };

    const movePointer = (next: PointerEvent) => {
      next.preventDefault();
      const dy = next.clientY - startY;
      dragged.el.style.transform = `translate3d(0, ${dy}px, 0)`;
      const nextOver = insertionIndex(items, dragged.relTop + dragged.height / 2 + dy);
      if (nextOver === overIndex) return;
      overIndex = nextOver;
      applyShifts(overIndex);
    };

    const up = () => {
      handle.removeEventListener("pointermove", movePointer);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      stopCursor();
      const destY = destinationTranslateY(items, originIndex, overIndex, gap);
      const gen = ++settleGenRef.current;
      setDragPhase("settling");
      dragged.el.style.transition = "transform var(--dur-slow) var(--ease-ios), scale var(--dur-slow) var(--ease-ios)";
      requestAnimationFrame(() => {
        if (gen !== settleGenRef.current) return;
        dragged.el.style.transform = `translate3d(0, ${destY}px, 0)`;
      });

      const finish = () => {
        if (gen !== settleGenRef.current) return;
        dragLockRef.current = false;
        clearDragStylesRef.current = true;
        setDraggingId(null);
        setDragPhase("dragging");
        if (overIndex === originIndex) return;
        drop.current(originIndex, overIndex, items.map(item => item.id));
      };

      window.setTimeout(finish, 250);
    };

    handle.addEventListener("pointermove", movePointer);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  return { listRef, draggingId, dragPhase, onPointerDown };
}
