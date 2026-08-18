import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { BtwPanel } from "./BtwPanel";
import { BtwStatusLine } from "./BtwStatusLine";
import type { BtwResizeEdge } from "./btwGeometry";
import type { BtwSessionApi } from "./useBtwSession";
import type { BtwWindowApi } from "./useBtwWindow";

const EDGES: readonly BtwResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const EDGE_LABEL: Readonly<Record<BtwResizeEdge, string>> = {
  n: "上边缘",
  s: "下边缘",
  e: "右边缘",
  w: "左边缘",
  ne: "右上角",
  nw: "左上角",
  se: "右下角",
  sw: "左下角",
};

/**
 * Expanded BTW window.
 *
 * Deliberately not a modal: no backdrop, no `aria-modal`, no focus trap, and
 * Escape does not close it. The whole point of the side channel is that the
 * composer, transcript, and panels stay usable while an answer streams in, so
 * anything that captures focus or input would defeat it.
 */
export function BtwWindow({
  window: win,
  session,
  demo,
  onDemoNext,
}: {
  window: BtwWindowApi;
  session: BtwSessionApi;
  demo?: boolean;
  onDemoNext?: () => void;
}) {
  const { rect } = win;
  return createPortal(
    <section
      className="btw-window"
      role="dialog"
      aria-modal="false"
      aria-labelledby="btwWindowTitle"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <header className="btw-head" onPointerDown={(event: ReactPointerEvent<HTMLElement>) => win.beginMove(event, "window")}>
        <span className="btw-grip" aria-hidden="true"><Icon name="grip" extra="sm" /></span>
        <span className="btw-title" id="btwWindowTitle">BTW</span>
        <BtwStatusLine snapshot={session.snapshot} startedAt={session.startedAt} />
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn small"
          data-tip="侧栏"
          aria-label="收进右侧栏"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={win.dock}
        >
          <Icon name="panel" extra="sm" />
        </button>
        <button
          type="button"
          className="icon-btn small"
          data-tip="胶囊"
          aria-label="收成胶囊"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={win.minimize}
        >
          <Icon name="minimize" extra="sm" />
        </button>
        <button
          type="button"
          className="icon-btn small"
          data-tip="关闭"
          aria-label="关闭 BTW"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={win.hide}
        >
          <Icon name="x" extra="sm" />
        </button>
      </header>
      <BtwPanel
        session={session}
        {...(demo === true ? { demo: true } : {})}
        {...(onDemoNext === undefined ? {} : { onDemoNext })}
      />
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={`btw-resize ${edge}`}
          role="separator"
          aria-label={`调整 BTW 窗口${EDGE_LABEL[edge]}`}
          onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => win.beginResize(event, edge)}
        />
      ))}
    </section>,
    document.body,
  );
}
