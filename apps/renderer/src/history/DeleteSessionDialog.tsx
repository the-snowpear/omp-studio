import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import "./sessionDeletion.css";

type DeleteTarget =
  | { readonly title: string; readonly stopping?: boolean | undefined }
  | { readonly count: number; readonly processed: number };

export function DeleteSessionDialog({
  target, busy, error, onConfirm, onCancel,
}: {
  target: DeleteTarget;
  busy: boolean;
  error?: string | undefined;
  onConfirm: (deleteManagedArtifacts: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const { preview, marks } = usePreviewMode();
  const doc = useSurfaceDocument();
  const headingId = useId();
  const descriptionId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const artifacts = useRef<HTMLInputElement>(null);
  const batch = "count" in target;
  const action = batch ? t("history.deleteSelected") : target.stopping ? t("history.stopAndDelete") : t("history.deleteSession");

  useLayoutEffect(() => {
    const lastFocused = doc.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => { if (lastFocused?.isConnected) lastFocused.focus(); };
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
        className="modal create-project-modal create-branch-modal session-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onCancel();
          }
          if (event.key === "Tab") {
            const controls = event.currentTarget.querySelectorAll<HTMLElement>("button:enabled, input:enabled");
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (!first || !last) {
              event.preventDefault();
            } else if (event.shiftKey && doc.activeElement === first) {
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
            <h2 id={headingId}>{t(batch ? "history.deleteArchivedTitle" : "history.deleteConfirmTitle")}</h2>
            <p className="create-branch-sub" id={descriptionId}>
              {batch ? t("history.deleteArchivedDesc", { count: target.count }) : t("history.deleteConfirmDesc", { title: target.title })}
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label={t("common.close")} disabled={busy} onClick={onCancel}><Icon name="x" /></button>
        </div>
        <div className="create-project-body">
          {!batch && target.stopping ? (
            <p className="session-delete-warning"><Icon name="alert" extra="sm" />{t("history.deleteStopsTurn")}</p>
          ) : null}
          {preview && marks ? <p className="create-branch-hint">{t("history.deleteConfirmDemo")}</p> : null}
          {!batch && (
            <label className="history-checkbox-label">
              <input ref={artifacts} className="history-checkbox" type="checkbox" disabled={busy} />
              {t("history.deleteManagedArtifacts")}
            </label>
          )}
          <p className="small muted">{t(batch ? "history.batchRetainArtifacts" : "history.retainManagedArtifacts")}</p>
          {busy && batch ? (
            <div className="session-delete-progress" role="status">
              <progress value={target.processed} max={target.count} aria-label={t("history.deleting")} />
              <span>{t("history.deleteProgress", { done: target.processed, count: target.count })}</span>
            </div>
          ) : null}
          {error !== undefined ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{error}</div> : null}
        </div>
        <div className="create-project-foot">
          <button ref={cancel} type="button" className="btn outline" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn danger solid" disabled={busy} onClick={() => onConfirm(artifacts.current?.checked ?? false)}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="trash" extra="sm" />}
            {busy ? t("history.deleting") : action}
          </button>
        </div>
      </section>
    </div>,
    doc.body,
  );
}
