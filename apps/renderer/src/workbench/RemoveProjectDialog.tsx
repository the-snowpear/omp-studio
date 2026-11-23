import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import "../history/sessionDeletion.css";

export function RemoveProjectDialog({ name, busy, error, onConfirm, onCancel }: {
  name: string;
  busy: boolean;
  error?: string | undefined;
  onConfirm: (deleteSessions: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const doc = useSurfaceDocument();
  const id = useId();
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [choice, setChoice] = useState<"keep" | "delete">("keep");
  const deleting = choice === "delete";

  useLayoutEffect(() => {
    const previous = doc.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [doc]);

  useLayoutEffect(() => {
    if (busy) dialog.current?.focus();
    else if (doc.activeElement === dialog.current) cancel.current?.focus();
  }, [busy, doc]);

  return createPortal(
    <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={busy ? undefined : onCancel}>
      <section
        ref={dialog}
        tabIndex={-1}
        className="modal create-project-modal create-branch-modal session-delete-dialog project-removal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-summary`}
        aria-busy={busy}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onCancel();
          }
          if (event.key === "Tab") {
            const controls = event.currentTarget.querySelectorAll<HTMLElement>("button:enabled, input:enabled:checked");
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (!first || !last) event.preventDefault();
            else if (event.shiftKey && doc.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && doc.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="create-project-head">
          <div>
            <h2 id={`${id}-title`}>{t("shell.removeProjectConfirmTitle")}</h2>
            <p className="create-branch-sub" id={`${id}-summary`}>{t("shell.removeProjectConfirmDesc", { name })}</p>
          </div>
          <button type="button" className="icon-btn" aria-label={t("common.close")} disabled={busy} onClick={onCancel}><Icon name="x" /></button>
        </div>
        <div className="create-project-body">
          <fieldset className="project-removal-options" disabled={busy}>
            <legend>{t("shell.removeProjectSessions")}</legend>
            <label className="project-removal-option">
              <input type="radio" name={id} checked={!deleting} onChange={() => setChoice("keep")} aria-labelledby={`${id}-keep-title`} aria-describedby={`${id}-keep`} />
              <span className="project-removal-option-icon"><Icon name="archive" /></span>
              <span><strong id={`${id}-keep-title`}>{t("shell.keepProjectSessions")}</strong><small id={`${id}-keep`}>{t("shell.keepProjectSessionsDesc")}</small></span>
            </label>
            <label className="project-removal-option danger">
              <input type="radio" name={id} checked={deleting} onChange={() => setChoice("delete")} aria-labelledby={`${id}-delete-title`} aria-describedby={`${id}-delete`} />
              <span className="project-removal-option-icon"><Icon name="trash" /></span>
              <span><strong id={`${id}-delete-title`}>{t("shell.removeSessions")}</strong><small id={`${id}-delete`}>{t("shell.removeSessionsDesc")}</small></span>
            </label>
          </fieldset>
          {error === undefined ? null : <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{error}</div>}
        </div>
        <div className="create-project-foot">
          <button ref={cancel} type="button" className="btn outline" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className={`btn solid${deleting ? " danger" : " primary"}`} disabled={busy} onClick={() => onConfirm(deleting)}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name={deleting ? "trash" : "folder"} extra="sm" />}
            {busy ? t("shell.removingProject") : t(deleting ? "shell.removeProjectAndSessions" : "shell.removeProject")}
          </button>
        </div>
      </section>
    </div>,
    doc.body,
  );
}
