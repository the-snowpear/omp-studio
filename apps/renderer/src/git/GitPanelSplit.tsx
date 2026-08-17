import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { Icon } from "../icons";

export function GitPanelSplit({
  top,
  graphOpen,
  splitRatio,
  onToggle,
  onResizeSplit,
  meta,
  preview,
  children,
}: {
  readonly top: ReactNode;
  readonly graphOpen: boolean;
  readonly splitRatio: number;
  readonly onToggle: () => void;
  readonly onResizeSplit: (ratio: number) => void;
  readonly meta?: ReactNode;
  readonly preview?: boolean;
  readonly children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const topShare = graphOpen ? `${(splitRatio * 100).toFixed(3)}%` : "100%";
  const graphShare = graphOpen ? `${((1 - splitRatio) * 100).toFixed(3)}%` : "0%";

  const onSplitPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!graphOpen) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const handle = event.currentTarget;
    const root = rootRef.current;
    const status = root?.querySelector(".git-status-pane");
    const graph = root?.querySelector(".git-graph-pane");
    if (!(root instanceof HTMLElement) || !(status instanceof HTMLElement) || !(graph instanceof HTMLElement)) return;
    const top = status.getBoundingClientRect().top;
    const span = graph.getBoundingClientRect().bottom - top;
    if (span <= 0) return;
    handle.classList.add("dragging");
    root.classList.add("git-splitting");
    handle.setPointerCapture(event.pointerId);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.classList.add("is-resizing");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    let latest = splitRatio;
    const apply = (ratio: number) => {
      latest = ratio;
      status.style.flex = `1 1 ${(ratio * 100).toFixed(3)}%`;
      graph.style.flex = `1 1 ${((1 - ratio) * 100).toFixed(3)}%`;
      handle.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    };
    const move = (next: PointerEvent) => {
      next.preventDefault();
      apply(Math.min(0.85, Math.max(0.15, (next.clientY - top) / span)));
    };
    const up = () => {
      handle.classList.remove("dragging");
      root.classList.remove("git-splitting");
      document.body.classList.remove("is-resizing");
      status.style.flex = "";
      graph.style.flex = "";
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onResizeSplit(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  return (
    <div ref={rootRef} className={`git-panel${graphOpen ? "" : " graph-collapsed"}`}>
      <div className="git-status-pane" style={{ ["--git-status-basis" as string]: topShare }}>{top}</div>
      {graphOpen ? (
        <div
          className="git-graph-divider"
          role="separator"
          aria-orientation="horizontal"
          aria-valuemin={15}
          aria-valuemax={85}
          aria-valuenow={Math.round(splitRatio * 100)}
          tabIndex={0}
          onPointerDown={onSplitPointerDown}
          onDoubleClick={() => onResizeSplit(0.5)}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") { event.preventDefault(); onResizeSplit(Math.max(0.15, splitRatio - 0.05)); }
            if (event.key === "ArrowDown") { event.preventDefault(); onResizeSplit(Math.min(0.85, splitRatio + 0.05)); }
          }}
        />
      ) : null}
      <section className={`git-graph-pane${graphOpen ? "" : " collapse"}`} style={{ ["--git-graph-basis" as string]: graphShare }} aria-labelledby="gitGraphTitle">
        <div className="git-graph-head">
          <h2 id="gitGraphTitle">提交历史</h2>
          {preview ? <span className="chip gray xs">演示</span> : null}
          {meta}
          <span className="spacer" />
          <button
            type="button"
            className={`icon-btn sb-collapse-btn${graphOpen ? "" : " is-collapsed"}`}
            data-tip={graphOpen ? "收起提交历史" : "展开提交历史"}
            aria-label={graphOpen ? "收起提交历史" : "展开提交历史"}
            aria-expanded={graphOpen}
            onClick={onToggle}
          >
            <Icon name={graphOpen ? "chevron-d" : "chevron-u"} extra="sm" />
          </button>
        </div>
        <div className="git-graph-body">{children}</div>
      </section>
    </div>
  );
}
