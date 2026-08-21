import { useI18n } from "../i18n";
import { useCallback, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { clampGitDiffHeight, GIT_DIFF_DEFAULT, GIT_DIFF_MIN, readGitDiffHeight, writeGitDiffHeight } from "./gitDiffMemory";

export function useGitDiffHeight(): readonly [number, (px: number) => void] {
  const [height, setHeight] = useState(readGitDiffHeight);
  const persist = useCallback((px: number) => {
    const next = clampGitDiffHeight(px);
    setHeight(next);
    writeGitDiffHeight(next);
  }, []);
  return [height, persist];
}

export function GitDiffResizer({
  height,
  onHeight,
}: {
  readonly height: number;
  readonly onHeight: (px: number) => void;
}) {
  const { t } = useI18n();
  const paneOf = (handle: HTMLElement) => handle.closest(".git-status-pane");
  const slotOf = (pane: Element | null) => pane?.querySelector(".git-diff-slot");
  const paneHeight = (pane: Element | null) => (pane instanceof HTMLElement ? pane.clientHeight : undefined);

  const apply = (handle: HTMLElement, px: number) => {
    const pane = paneOf(handle);
    const next = clampGitDiffHeight(px, paneHeight(pane));
    const slot = slotOf(pane);
    if (slot instanceof HTMLElement) slot.style.height = `${next}px`;
    handle.setAttribute("aria-valuenow", String(next));
    return next;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const handle = event.currentTarget;
    const pane = paneOf(handle);
    const slot = slotOf(pane);
    if (!(slot instanceof HTMLElement)) return;
    const startY = event.clientY;
    const startH = slot.getBoundingClientRect().height;
    handle.classList.add("dragging");
    handle.setPointerCapture(event.pointerId);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.classList.add("is-resizing");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    let latest = startH;
    const move = (next: PointerEvent) => {
      next.preventDefault();
      latest = apply(handle, startH - (next.clientY - startY));
    };
    const up = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("is-resizing");
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onHeight(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 60 : 20;
    const pane = paneOf(event.currentTarget);
    const current = height;
    let next: number | undefined;
    if (event.key === "ArrowUp") next = current + step;
    else if (event.key === "ArrowDown") next = current - step;
    else if (event.key === "Home") next = paneHeight(pane) ?? current;
    else if (event.key === "End") next = GIT_DIFF_MIN;
    else return;
    event.preventDefault();
    onHeight(apply(event.currentTarget, next));
  };

  return (
    <div
      className="ch-diff-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t("git.adjustDiffHeight")}
      aria-valuemin={GIT_DIFF_MIN}
      aria-valuenow={height}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={(event) => onHeight(apply(event.currentTarget, GIT_DIFF_DEFAULT))}
      onKeyDown={onKeyDown}
    />
  );
}
