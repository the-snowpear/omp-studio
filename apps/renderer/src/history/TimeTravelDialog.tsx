import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import "./timeTravel.css";

export function TimeTravelDialog({
  title,
  description,
  busy = false,
  onClose,
  children,
  actions,
}: {
  title: string;
  description: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const { resolvedLanguage } = useI18n();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="tt-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-desc`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <header className="tt-dialog-head">
        <div>
          <span className="tt-eyebrow">
            <Icon name="history" extra="sm" /> Time Travel
          </span>
          <h2 id={`${id}-title`}>{title}</h2>
          <p id={`${id}-desc`}>{description}</p>
        </div>
        <button
          type="button"
          className="icon-btn"
          autoFocus
          aria-label={resolvedLanguage === "zh" ? "关闭" : "Close"}
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </header>
      <div className="tt-dialog-body">{children}</div>
      <footer className="tt-dialog-foot">{actions}</footer>
    </dialog>,
    document.body,
  );
}
