import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { BtwStatusLine, btwStatusLabel } from "./BtwStatusLine";
import type { BtwSessionApi } from "./useBtwSession";
import type { BtwWindowApi } from "./useBtwWindow";

/**
 * Minimized BTW.
 *
 * Drag it anywhere over the conversation, side panel, or bottom panel; a press
 * that never travels past the drag threshold counts as a click and expands the
 * window back (`beginMove` decides which of the two happened).
 */
export function BtwCapsule({
  window: win,
  session,
}: {
  window: BtwWindowApi;
  session: BtwSessionApi;
}) {
  const running = session.snapshot?.status === "running";
  return createPortal(
    <div
      className={`btw-capsule${running ? " is-running" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`BTW · ${btwStatusLabel(session.snapshot)}`}
      style={{ left: win.capsulePos.x, top: win.capsulePos.y }}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => win.beginMove(event, "capsule")}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        win.restore();
      }}
    >
      <span className="btw-cap-orb" aria-hidden="true"><Icon name="sparkles" extra="sm" /></span>
      <span className="btw-cap-main">
        <span className="btw-cap-title">BTW</span>
        <BtwStatusLine snapshot={session.snapshot} startedAt={session.startedAt} compact />
      </span>
    </div>,
    document.body,
  );
}
