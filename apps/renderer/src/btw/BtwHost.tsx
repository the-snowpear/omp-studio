import { createPortal } from "react-dom";
import { BTW_EDGE_DOCK_BAND, type BtwRect } from "./btwGeometry";
import { BtwCapsule } from "./BtwCapsule";
import { BtwWindow } from "./BtwWindow";
import type { BtwSessionApi } from "./useBtwSession";
import type { BtwWindowApi } from "./useBtwWindow";

/**
 * Where a dock would land, drawn only while a drag is hovering that target.
 *
 * With the side panel open the target is its tab strip, which is exactly where
 * the docked BTW tab appears; collapsed, the panel is off-screen and the
 * window's right edge stands in for it.
 */
function DropHint({ sideOpen, sideHeadRect }: { sideOpen: boolean; sideHeadRect?: BtwRect }) {
  const rect: BtwRect =
    sideOpen && sideHeadRect !== undefined
      ? sideHeadRect
      : {
          x: window.innerWidth - BTW_EDGE_DOCK_BAND,
          y: 0,
          width: BTW_EDGE_DOCK_BAND,
          height: window.innerHeight,
        };
  return createPortal(
    <div
      className="btw-drop-hint"
      aria-hidden="true"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    />,
    document.body,
  );
}

/**
 * Renders whichever floating form BTW is currently in. A docked BTW renders
 * nothing here — the side panel owns that surface — so the panel body and the
 * floating window never exist at the same time.
 */
export function BtwHost({
  window: win,
  session,
  sideOpen,
  sideHeadRect,
  demo,
  onDemoNext,
}: {
  window: BtwWindowApi;
  session: BtwSessionApi;
  sideOpen: boolean;
  sideHeadRect: () => BtwRect | undefined;
  demo?: boolean;
  onDemoNext?: () => void;
}) {
  if (!win.open) return null;
  const head = win.dropTarget === "dock" ? sideHeadRect() : undefined;
  return (
    <>
      {win.dropTarget === "dock" ? (
        <DropHint sideOpen={sideOpen} {...(head === undefined ? {} : { sideHeadRect: head })} />
      ) : null}
      {win.placement === "docked" ? null : win.minimized ? (
        <BtwCapsule window={win} session={session} />
      ) : (
        <BtwWindow
          window={win}
          session={session}
          {...(demo === true ? { demo: true } : {})}
          {...(onDemoNext === undefined ? {} : { onDemoNext })}
        />
      )}
    </>
  );
}
