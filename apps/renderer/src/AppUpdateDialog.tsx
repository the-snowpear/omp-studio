import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Brand } from "./brands";
import { Icon } from "./icons";
import { useI18n } from "./i18n";

export interface AppUpdateDialogProps {
  readonly update: {
    readonly currentVersion: string;
    readonly version?: string | undefined;
    readonly name?: string | undefined;
    readonly releaseNotes?: string | undefined;
    readonly publishedAt?: string | undefined;
    readonly htmlUrl?: string | undefined;
    readonly downloadUrl?: string | undefined;
    readonly assetName?: string | undefined;
    readonly assetSize?: number | undefined;
  };
  readonly preview?: boolean;
  readonly isDownloading?: boolean;
  readonly downloadError?: string | null;
  readonly onClose: () => void;
  readonly onDownloadAndInstall?: () => Promise<boolean | void>;
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatDate(isoStr?: string): string {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return isoStr;
  }
}

export function AppUpdateDialog({
  update,
  preview = false,
  isDownloading = false,
  downloadError = null,
  onClose,
  onDownloadAndInstall,
}: AppUpdateDialogProps): ReactNode {
  const { t } = useI18n();
  const [downloading, setDownloading] = useState(isDownloading);
  const [simulatedProgress, setSimulatedProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    setDownloading(isDownloading);
  }, [isDownloading]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || downloading) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, downloading]);

  const handleDownload = useCallback(async () => {
    if (downloading) return;
    if (preview) {
      setDownloading(true);
      setSimulatedProgress(20);
      setTimeout(() => setSimulatedProgress(60), 600);
      setTimeout(() => setSimulatedProgress(100), 1200);
      setTimeout(() => {
        setDownloading(false);
        setStatusMessage(t("appUpdate.downloadSuccess") + " " + t("appUpdate.demoUpdate"));
      }, 1600);
      return;
    }
    if (onDownloadAndInstall) {
      setDownloading(true);
      setStatusMessage(null);
      try {
        const ok = await onDownloadAndInstall();
        if (ok) {
          setStatusMessage(t("appUpdate.downloadSuccess"));
        }
      } finally {
        setDownloading(false);
      }
    }
  }, [downloading, preview, onDownloadAndInstall, t]);

  const openGithub = useCallback((event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const url = update.htmlUrl ?? "https://github.com/the-snowpear/omp-studio/releases";
    const openUrl = globalThis.ompStudioChrome?.openUrl;
    if (openUrl !== undefined) {
      void openUrl({ url });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, [update.htmlUrl]);

  return createPortal(
    <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={downloading ? undefined : onClose}>
      <section
        className="modal create-project-modal create-branch-modal app-update-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="appUpdateTitle"
        onMouseDown={(event) => event.stopPropagation()}
        style={{ maxWidth: 520 }}
      >
        <div className="create-project-head">
          <div>
            <span className="create-project-kicker">
              {t("appUpdate.dialogTitle")} {preview ? t("appUpdate.demoUpdate") : ""}
            </span>
            <h2 id="appUpdateTitle">
              {update.name || `OMP Studio v${update.version}`}
            </h2>
            <p className="create-branch-sub" style={{ marginTop: 4, display: "flex", gap: 12, alignItems: "center" }}>
              <span>
                <b>{t("appUpdate.currentVersion")}</b>: <span className="mono">v{update.currentVersion}</span>
              </span>
              <span>→</span>
              <span>
                <b>{t("appUpdate.latestVersion")}</b>: <span className="mono" style={{ color: "var(--accent)" }}>v{update.version}</span>
              </span>
            </p>
          </div>
          {!downloading && (
            <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={onClose}>
              <Icon name="x" />
            </button>
          )}
        </div>

        <div className="create-project-body app-update-body" style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", opacity: 0.8 }}>
            <span>{t("appUpdate.releaseDate")}: {formatDate(update.publishedAt)}</span>
            {update.assetSize ? <span>{t("appUpdate.packageSize")}: {formatBytes(update.assetSize)}</span> : null}
          </div>

          <div style={{ marginTop: 4 }}>
            <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: 6 }}>
              {t("appUpdate.releaseNotes")}
            </div>
            <div
              className="app-update-notes"
              style={{
                background: "var(--bg-subtle, rgba(0,0,0,0.03))",
                padding: "10px 12px",
                borderRadius: 6,
                fontSize: "0.88rem",
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                border: "1px solid var(--border-subtle, rgba(0,0,0,0.06))",
              }}
            >
              {update.releaseNotes?.trim() || t("appUpdate.noReleaseNotes")}
            </div>
          </div>

          {downloadError ? (
            <div className="alert-box error" style={{ color: "var(--red)", fontSize: "0.85rem", display: "flex", gap: 6, alignItems: "center" }}>
              <Icon name="alert" extra="sm" />
              <span>{t("appUpdate.downloadFailed")}: {downloadError}</span>
            </div>
          ) : null}

          {statusMessage ? (
            <div className="alert-box success" style={{ color: "var(--green)", fontSize: "0.85rem", display: "flex", gap: 6, alignItems: "center" }}>
              <Icon name="check" extra="sm" />
              <span>{statusMessage}</span>
            </div>
          ) : null}

          {downloading ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", marginBottom: 4 }}>
                <span>{t("appUpdate.downloading")}</span>
                {preview ? <span>{simulatedProgress}%</span> : null}
              </div>
              <div style={{ height: 6, borderRadius: 3, background: "var(--bg-subtle, rgba(0,0,0,0.1))", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    background: "var(--accent)",
                    width: preview ? `${simulatedProgress}%` : "100%",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="create-project-foot app-update-foot" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            {update.htmlUrl ? (
              <a
                href={update.htmlUrl}
                target="_blank"
                rel="noreferrer noopener"
                onClick={openGithub}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.85rem", color: "var(--text-muted)" }}
              >
                <Brand id="github" extra="sm" />
                <span>{t("appUpdate.viewOnGithub")}</span>
                <Icon name="external" extra="sm" />
              </a>
            ) : null}
          </div>

          <div className="app-update-actions" style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn outline" disabled={downloading} onClick={onClose}>
              {t("appUpdate.remindLater")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={downloading || (!update.downloadUrl && !preview)}
              autoFocus
              onClick={handleDownload}
            >
              {downloading ? t("appUpdate.downloading") : t("appUpdate.downloadAndInstall")}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
