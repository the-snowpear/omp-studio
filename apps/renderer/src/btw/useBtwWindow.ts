import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampCapsule,
  clampRect,
  defaultCapsulePos,
  defaultRect,
  exceedsDragThreshold,
  rectAtPointer,
  resizeRect,
  resolveDropTarget,
  type BtwDropTarget,
  type BtwPoint,
  type BtwRect,
  type BtwResizeEdge,
  type BtwViewport,
} from "./btwGeometry";

export type BtwPlacement = "float" | "docked";

/** Persisted slice of the window's geometry; the rest is derived per session. */
export interface BtwWindowMemory {
  readonly open?: boolean;
  readonly placement: BtwPlacement;
  readonly minimized: boolean;
  readonly rect: BtwRect;
  readonly capsulePos: BtwPoint;
}

export interface BtwWindowState {
  readonly open: boolean;
  readonly placement: BtwPlacement;
  /** Only meaningful while floating; a docked panel has no capsule form. */
  readonly minimized: boolean;
  readonly rect: BtwRect;
  readonly capsulePos: BtwPoint;
  /** Live drop target during a drag, for side-panel highlight; null when idle. */
  readonly dropTarget: BtwDropTarget | null;
}

export interface BtwWindowApi extends BtwWindowState {
  show(): void;
  hide(): void;
  minimize(): void;
  restore(): void;
  dock(): void;
  undock(pointer?: BtwPoint): void;
  /** Title-bar / capsule drag. Resolves to the drop target that was applied. */
  beginMove(event: BtwPointerLike, mode: "window" | "capsule"): void;
  beginResize(event: BtwPointerLike, edge: BtwResizeEdge): void;
  /** Tab-button drag-out: undocks once the pointer leaves the tab strip. */
  beginUndockDrag(event: BtwPointerLike, onClick: () => void): void;
  /** Apply persisted layout memory, which arrives in an effect after mount. */
  restoreMemory(memory: Partial<BtwWindowMemory>): void;
}

/** The subset of React's pointer event this hook needs, so tests can call it directly. */
export interface BtwPointerLike {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly currentTarget: HTMLElement;
  /** 0 = primary; absent in tests. Non-primary buttons must not start a drag. */
  readonly button?: number;
  preventDefault(): void;
}

export interface BtwWindowOptions {
  readonly sideOpen: boolean;
  /** Live tab-strip box, for the "drop on the tab strip to dock" affordance. */
  readonly sideHeadRect: () => BtwRect | undefined;
  /** Called when a drag or the dock button parks BTW in the side panel. */
  readonly onDock?: () => void;
}

function viewport(): BtwViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function DRAG_CLASS(): string {
  return "is-btw-dragging";
}

function isPrimaryButton(event: BtwPointerLike): boolean {
  return event.button === undefined || event.button === 0;
}

/** jsdom has no pointer capture; the drag still works through plain listeners. */
function capture(node: HTMLElement, pointerId: number, acquire: boolean): void {
  try {
    if (acquire) node.setPointerCapture(pointerId);
    else node.releasePointerCapture(pointerId);
  } catch {
    /* unsupported or already released */
  }
}

/**
 * Geometry and placement state machine for the BTW window.
 *
 * Drag and resize write directly to the DOM node and only commit to React state
 * on `pointerup`; a per-frame `setState` makes the window lag the cursor and
 * re-renders the whole panel body for nothing. This mirrors how the workbench's
 * existing panel/bottom resizers work.
 */
export function useBtwWindow(options: BtwWindowOptions): BtwWindowApi {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<BtwPlacement>("float");
  const [minimized, setMinimized] = useState(false);
  const [rect, setRect] = useState<BtwRect>(() => defaultRect(viewport()));
  const [capsulePos, setCapsulePos] = useState<BtwPoint>(() => defaultCapsulePos(viewport()));
  const [dropTarget, setDropTarget] = useState<BtwDropTarget | null>(null);

  const onDockRef = useRef(options.onDock);
  onDockRef.current = options.onDock;
  const sideOpenRef = useRef(options.sideOpen);
  sideOpenRef.current = options.sideOpen;
  const sideHeadRef = useRef(options.sideHeadRect);
  sideHeadRef.current = options.sideHeadRect;
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Geometry mirrors so a drag that starts before React commits the previous
  // one still reads the value the operator can see on screen.
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const capsuleRef = useRef(capsulePos);
  capsuleRef.current = capsulePos;

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, []);

  const commit = useCallback((next: Partial<BtwWindowMemory>) => {
    if (next.open !== undefined) setOpen(next.open);
    if (next.placement !== undefined) setPlacement(next.placement);
    if (next.minimized !== undefined) setMinimized(next.minimized);
    if (next.rect !== undefined) {
      rectRef.current = next.rect;
      setRect(next.rect);
    }
    if (next.capsulePos !== undefined) {
      capsuleRef.current = next.capsulePos;
      setCapsulePos(next.capsulePos);
    }
  }, []);

  const restoreMemory = useCallback(
    (memory: Partial<BtwWindowMemory>) => {
      const view = viewport();
      commit({
        ...(memory.open === undefined ? {} : { open: memory.open }),
        ...(memory.placement === undefined ? {} : { placement: memory.placement }),
        ...(memory.minimized === undefined ? {} : { minimized: memory.minimized }),
        ...(memory.rect === undefined ? {} : { rect: clampRect(memory.rect, view) }),
        ...(memory.capsulePos === undefined ? {} : { capsulePos: clampCapsule(memory.capsulePos, view) }),
      });
    },
    [commit],
  );

  // A viewport that shrank under a floating window would leave it unreachable.
  useEffect(() => {
    const onResize = () => {
      const view = viewport();
      const nextRect = clampRect(rectRef.current, view);
      const nextCapsule = clampCapsule(capsuleRef.current, view);
      const rectMoved =
        nextRect.x !== rectRef.current.x ||
        nextRect.y !== rectRef.current.y ||
        nextRect.width !== rectRef.current.width ||
        nextRect.height !== rectRef.current.height;
      const capsuleMoved = nextCapsule.x !== capsuleRef.current.x || nextCapsule.y !== capsuleRef.current.y;
      if (!rectMoved && !capsuleMoved) return;
      commit({
        ...(rectMoved ? { rect: nextRect } : {}),
        ...(capsuleMoved ? { capsulePos: nextCapsule } : {}),
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [commit]);

  const placementRef = useRef(placement);
  placementRef.current = placement;
  const show = useCallback(() => {
    setOpen(true);
    setMinimized(false);
    // A docked BTW has no floating form: revealing it means opening the panel.
    if (placementRef.current === "docked") onDockRef.current?.();
  }, []);
  const hide = useCallback(() => setOpen(false), []);
  const minimize = useCallback(() => commit({ minimized: true }), [commit]);
  const restore = useCallback(() => commit({ minimized: false }), [commit]);
  const dock = useCallback(() => {
    commit({ placement: "docked", minimized: false });
    onDockRef.current?.();
  }, [commit]);
  const undock = useCallback(
    (pointer?: BtwPoint) => {
      const view = viewport();
      const nextRect =
        pointer === undefined ? clampRect(rectRef.current, view) : rectAtPointer(pointer, rectRef.current, view);
      commit({ placement: "float", minimized: false, rect: nextRect });
    },
    [commit],
  );

  const dropAt = useCallback((pointer: BtwPoint): BtwDropTarget => {
    const head = sideHeadRef.current();
    return resolveDropTarget({
      pointer,
      sideOpen: sideOpenRef.current,
      ...(head === undefined ? {} : { sideHeadRect: head }),
      viewportWidth: window.innerWidth,
    });
  }, []);

  /**
   * Shared pointer plumbing for both drag flavours: capture, suppress text
   * selection, write to the DOM per move, commit once on release.
   *
   * Listeners sit on `window` so a failed pointer capture (jsdom, or the
   * pointer leaving the node) still sees moves and the matching up/cancel.
   * Unmount aborts the drag without committing a drop.
   */
  const runDrag = useCallback(
    (
      event: BtwPointerLike,
      handlers: {
        readonly onMove: (pointer: BtwPoint, delta: BtwPoint, node: HTMLElement) => void;
        readonly onDrop: (pointer: BtwPoint, delta: BtwPoint, node: HTMLElement, moved: boolean) => void;
        readonly trackDropTarget?: boolean;
      },
    ) => {
      if (!isPrimaryButton(event)) return;
      dragCleanupRef.current?.();
      const node = event.currentTarget;
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      capture(node, event.pointerId, true);
      document.body.classList.add(DRAG_CLASS());
      const start: BtwPoint = { x: event.clientX, y: event.clientY };
      let latestPointer = start;
      let moved = false;
      let cleaned = false;
      const move = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        next.preventDefault();
        latestPointer = { x: next.clientX, y: next.clientY };
        const delta = { x: latestPointer.x - start.x, y: latestPointer.y - start.y };
        if (!moved && exceedsDragThreshold(start, latestPointer)) moved = true;
        if (moved) handlers.onMove(latestPointer, delta, node);
        if (handlers.trackDropTarget === true && moved) setDropTarget(dropAt(latestPointer));
      };
      const finish = (commitDrop: boolean) => {
        if (cleaned) return;
        cleaned = true;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        capture(node, event.pointerId, false);
        document.body.classList.remove(DRAG_CLASS());
        setDropTarget(null);
        if (dragCleanupRef.current === abort) dragCleanupRef.current = null;
        if (commitDrop) {
          handlers.onDrop(latestPointer, { x: latestPointer.x - start.x, y: latestPointer.y - start.y }, node, moved);
        }
      };
      const up = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        finish(true);
      };
      const abort = () => finish(false);
      dragCleanupRef.current = abort;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [dropAt],
  );

  const beginMove = useCallback(
    (event: BtwPointerLike, mode: "window" | "capsule") => {
      const startRect = rectRef.current;
      const startCapsule = capsuleRef.current;
      runDrag(event, {
        trackDropTarget: true,
        onMove: (_pointer, delta, node) => {
          const surface = node.closest(".btw-window, .btw-capsule");
          if (!(surface instanceof HTMLElement)) return;
          if (mode === "window") {
            const next = clampRect({ ...startRect, x: startRect.x + delta.x, y: startRect.y + delta.y }, viewport());
            surface.style.left = `${next.x}px`;
            surface.style.top = `${next.y}px`;
          } else {
            const next = clampCapsule({ x: startCapsule.x + delta.x, y: startCapsule.y + delta.y }, viewport());
            surface.style.left = `${next.x}px`;
            surface.style.top = `${next.y}px`;
          }
        },
        onDrop: (pointer, delta, _node, moved) => {
          if (!moved) {
            // Capsule click-to-expand: a press that never travelled is a click.
            if (mode === "capsule") restore();
            return;
          }
          const view = viewport();
          if (dropAt(pointer) === "dock") {
            // Keep the pre-drag geometry so undocking restores the same box.
            commit({ placement: "docked", minimized: false, rect: startRect, capsulePos: startCapsule });
            onDockRef.current?.();
            return;
          }
          if (mode === "window") {
            commit({ rect: clampRect({ ...startRect, x: startRect.x + delta.x, y: startRect.y + delta.y }, view) });
          } else {
            commit({ capsulePos: clampCapsule({ x: startCapsule.x + delta.x, y: startCapsule.y + delta.y }, view) });
          }
        },
      });
    },
    [commit, dropAt, restore, runDrag],
  );

  const beginResize = useCallback(
    (event: BtwPointerLike, edge: BtwResizeEdge) => {
      const startRect = rectRef.current;
      runDrag(event, {
        onMove: (_pointer, delta, node) => {
          const surface = node.closest(".btw-window");
          if (!(surface instanceof HTMLElement)) return;
          const next = resizeRect(startRect, edge, delta, viewport());
          surface.style.left = `${next.x}px`;
          surface.style.top = `${next.y}px`;
          surface.style.width = `${next.width}px`;
          surface.style.height = `${next.height}px`;
        },
        onDrop: (_pointer, delta, _node, moved) => {
          if (!moved) return;
          commit({ rect: resizeRect(startRect, edge, delta, viewport()) });
        },
      });
    },
    [commit, runDrag],
  );

  const beginUndockDrag = useCallback(
    (event: BtwPointerLike, onClick: () => void) => {
      const startRect = rectRef.current;
      runDrag(event, {
        onMove: () => {
          // The docked panel has no floating node to move yet; the undock lands
          // on release so the tab strip does not flicker mid-drag.
        },
        onDrop: (pointer, _delta, _node, moved) => {
          if (!moved) {
            onClick();
            return;
          }
          const view = viewport();
          if (dropAt(pointer) === "dock") return;
          commit({ placement: "float", minimized: false, rect: rectAtPointer(pointer, startRect, view) });
        },
      });
    },
    [commit, dropAt, runDrag],
  );

  return {
    open,
    placement,
    minimized,
    rect,
    capsulePos,
    dropTarget,
    show,
    hide,
    minimize,
    restore,
    dock,
    undock,
    beginMove,
    beginResize,
    beginUndockDrag,
    restoreMemory,
  };
}
