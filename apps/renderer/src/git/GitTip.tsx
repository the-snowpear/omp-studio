import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Page-style hover tip that paints in a portal. CSS `[data-tip]::after` is
 * clipped by `.ch-list` / `.git-status-pane` overflow; this keeps the same
 * look without native `title`.
 */
export function GitTip({ text, children }: { readonly text: string; readonly children: ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState({ top: 0, left: 0 });

  const place = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setBox({ top: rect.top + rect.height / 2, left: rect.left });
  };

  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) setBox({ top: rect.top + rect.height / 2, left: rect.left });
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, text]);

  useEffect(() => {
    if (!open) return;
    const sync = () => place();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [open]);

  return (
    <span
      ref={anchorRef}
      className="git-tip"
      onPointerEnter={show}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={show}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {children}
      {open
        ? createPortal(
            <span className="git-tip-bubble" role="tooltip" style={{ top: box.top, left: box.left }}>
              {text}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
