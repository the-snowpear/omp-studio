import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Brand } from "./brands";
import { Icon } from "./icons";
import { useI18n } from "./i18n";
import { PLATFORM } from "./platform";

/** macOS swaps the app bundle itself: there is no installer to download or launch. */
const UPDATE_COPY = PLATFORM === "darwin"
  ? { packageSize: "appUpdate.packageSizeMac", downloading: "appUpdate.downloadingMac" }
  : { packageSize: "appUpdate.packageSize", downloading: "appUpdate.downloading" };

export interface AppUpdateDialogProps {
  readonly update: {
    readonly component?: "app" | "runtime";
    readonly currentVersion: string;
    readonly version?: string | undefined;
    readonly name?: string | undefined;
    readonly releaseNotes?: string | undefined;
    readonly publishedAt?: string | undefined;
    readonly htmlUrl?: string | undefined;
    readonly downloadUrl?: string | undefined;
    readonly assetName?: string | undefined;
    readonly assetSize?: number | undefined;
    readonly plan?: "none" | "hot" | "full";
    readonly reason?: string | undefined;
    readonly blockedReason?: string | undefined;
  };
  readonly preview?: boolean;
  readonly isDownloading?: boolean;
  readonly isApplying?: boolean;
  readonly checkError?: string | null;
  readonly downloadError?: string | null;
  readonly applyError?: string | null;
  readonly applyNotice?: string | null;
  readonly cancelError?: string | null;
  readonly receivedBytes?: number | undefined;
  readonly totalBytes?: number | undefined;
  readonly readyToApply?: boolean;
  readonly onClose: () => void;
  readonly onDownloadAndInstall?: () => Promise<boolean | void>;
  readonly onApply?: () => Promise<boolean>;
  readonly onSkip?: () => Promise<void>;
  readonly onCancel?: () => Promise<void>;
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
  isApplying = false,
  checkError = null,
  downloadError = null,
  applyError = null,
  applyNotice = null,
  cancelError = null,
  receivedBytes,
  totalBytes,
  readyToApply = false,
  onClose,
  onDownloadAndInstall,
  onApply,
  onSkip,
  onCancel,
}: AppUpdateDialogProps): ReactNode {
  const { t } = useI18n();
  const [operation, setOperation] = useState<"download" | "apply" | null>(null);
  const downloading = isDownloading || operation === "download";
  const applying = isApplying || operation === "apply";
  const busy = downloading || applying;
  const [simulatedProgress, setSimulatedProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const ready = preview ? previewReady : readyToApply;

  const progressPct = preview
    ? simulatedProgress
    : totalBytes && totalBytes > 0 && receivedBytes !== undefined
      ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
      : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const previewTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      for (const id of previewTimersRef.current) clearTimeout(id);
      previewTimersRef.current = [];
    };
  }, []);

  const handleDownload = useCallback(async () => {
    if (busy || update.blockedReason) return;
    setStatusMessage(null);
    if (preview) {
      if (previewReady) {
        setOperation("apply");
        previewTimersRef.current.push(setTimeout(() => {
          setOperation(null);
          setPreviewReady(false);
          setStatusMessage(t("appUpdate.demoApplied"));
        }, 600));
        return;
      }
      setOperation("download");
      setSimulatedProgress(20);
      const timers = previewTimersRef.current;
      timers.length = 0;
      timers.push(setTimeout(() => setSimulatedProgress(60), 600));
      timers.push(setTimeout(() => setSimulatedProgress(100), 1200));
      timers.push(setTimeout(() => {
        setOperation(null);
        setPreviewReady(true);
        setStatusMessage(t("updates.readyToApply") + " " + t("appUpdate.demoUpdate"));
      }, 1600));
      return;
    }
    const action = ready ? onApply : onDownloadAndInstall;
    if (action) {
      setOperation(ready ? "apply" : "download");
      try {
        const ok = await action();
        if (ok) {
          setStatusMessage(t(ready ? "appUpdate.restarting" : "updates.readyToApply"));
        }
      } finally {
        setOperation(null);
      }
    }
  }, [busy, preview, previewReady, ready, onApply, onDownloadAndInstall, t, update.blockedReason]);

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
    <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <section
        className="modal create-project-modal create-branch-modal app-update-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="appUpdateTitle"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="create-project-head">
          <div>
            <span className="create-project-kicker">
              {t("appUpdate.dialogTitle")} {preview ? t("appUpdate.demoUpdate") : ""}
            </span>
            <h2 id="appUpdateTitle">
              {update.name || (update.version ? `OMP Studio v${update.version}` : "OMP Studio")}
            </h2>
            <p className="create-branch-sub" style={{ marginTop: 4, display: "flex", gap: 12, alignItems: "center" }}>
              <span>
                <b>{t("appUpdate.currentVersion")}</b>: <span className="mono">{update.currentVersion ? `v${update.currentVersion}` : "—"}</span>
              </span>
              <span>→</span>
              <span>
                <b>{t("appUpdate.latestVersion")}</b>: <span className="mono" style={{ color: "var(--accent)" }}>{update.version ? `v${update.version}` : "—"}</span>
              </span>
            </p>
          </div>
          {!busy && (
            <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={onClose}>
              <Icon name="x" />
            </button>
          )}
        </div>

        <div className="create-project-body app-update-body" style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          {update.plan === "full" && update.reason !== "restart-update" ? <p>{t("updates.fullInstallerRequired")}{update.reason ? ` · ${update.reason}` : ""}</p> : null}
          {ready && !applying ? <p>{t("updates.readyToApply")}</p> : null}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", opacity: 0.8 }}>
            <span>{t("appUpdate.releaseDate")}: {formatDate(update.publishedAt)}</span>
            {update.assetSize ? <span>{t(UPDATE_COPY.packageSize)}: {formatBytes(update.assetSize)}</span> : null}
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

          {([
            ["appUpdate.checkFailed", checkError],
            ["appUpdate.downloadFailed", downloadError],
            ["appUpdate.applyFailed", applyError],
            ["appUpdate.cancelFailed", cancelError],
          ] as const).map(([label, message]) => message ? (
            <div key={label} className="alert-box error" role="alert" style={{ color: "var(--red)", fontSize: "0.85rem", display: "flex", gap: 6, alignItems: "center" }}>
              <Icon name="alert" extra="sm" />
              <span>{t(label)}: {message}</span>
            </div>
          ) : null)}

          {update.blockedReason ? <p role="status">{update.blockedReason}</p> : null}
          {applyNotice && applyNotice !== update.blockedReason ? <p className="small muted" role="status">{applyNotice}</p> : null}
          {applying ? <p role="status">{t("appUpdate.restarting")}</p> : null}

          {statusMessage ? (
            <div className="alert-box success" style={{ color: "var(--green)", fontSize: "0.85rem", display: "flex", gap: 6, alignItems: "center" }}>
              <Icon name="check" extra="sm" />
              <span>{statusMessage}</span>
            </div>
          ) : null}

          {downloading ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", marginBottom: 4 }}>
                <span>{t(UPDATE_COPY.downloading)}</span>
                {progressPct !== null ? <span>{progressPct}%</span> : null}
              </div>
              <div style={{ height: 6, borderRadius: 3, background: "var(--bg-subtle, rgba(0,0,0,0.1))", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    background: "var(--accent)",
                    width: progressPct !== null ? `${progressPct}%` : "100%",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="create-project-foot app-update-foot">
          {update.htmlUrl ? (
            <a
              className="icon-btn lg"
              href={update.htmlUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t("appUpdate.viewOnGithub")}
              data-tip={t("appUpdate.viewOnGithub")}
              onClick={openGithub}
            >
              <Brand id="github" />
            </a>
          ) : null}

          <div className="app-update-actions">
            {downloading && onCancel ? <button type="button" className="btn outline" onClick={() => void onCancel()}>{t("common.cancel")}</button> : null}
            {onSkip && !ready && update.component !== "runtime" ? <button type="button" className="btn outline" disabled={busy} onClick={() => void onSkip()}>{t("updates.skipVersion")}</button> : null}
            <button type="button" className="btn outline" disabled={busy} onClick={onClose}>
              {t("appUpdate.remindLater")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || Boolean(update.blockedReason) || (!preview && !(ready ? onApply : onDownloadAndInstall))}
              autoFocus
              onClick={handleDownload}
            >
              {applying ? t("appUpdate.restarting") : downloading ? t("updates.downloading") : ready ? t("updates.applyAndRestart") : t("appUpdate.downloadAndInstall")}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
