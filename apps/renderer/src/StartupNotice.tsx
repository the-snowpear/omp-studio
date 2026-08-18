import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Brand } from "./brands";
import { Icon } from "./icons";
import {
  PROJECT_GITHUB_HOST,
  PROJECT_GITHUB_URL,
  STARTUP_NOTICE_COPY,
  dismissStartupNoticeForever,
  shouldShowStartupNotice,
} from "./settings/startupNotice";

export function StartupNoticeDialog({
  onClose,
  onDontRemind,
}: {
  readonly onClose: () => void;
  readonly onDontRemind: () => void;
}): ReactNode {
  const copy = STARTUP_NOTICE_COPY;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const copyUrl = useCallback(async (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const clipboard = typeof navigator === "object" ? navigator.clipboard : undefined;
    if (!clipboard) return;
    try {
      await clipboard.writeText(PROJECT_GITHUB_URL);
      setCopied(true);
    } catch {
      /* 剪贴板被拒绝时地址仍可见，用户可手选复制。 */
    }
  }, []);
  const openGithub = useCallback((event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const openUrl = globalThis.ompStudioChrome?.openUrl;
    if (openUrl !== undefined) {
      void openUrl({ url: PROJECT_GITHUB_URL });
      return;
    }
    window.open(PROJECT_GITHUB_URL, "_blank", "noopener,noreferrer");
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return createPortal(
    <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal create-project-modal create-branch-modal startup-notice-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="startupNoticeTitle"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="create-project-head">
          <div>
            <span className="create-project-kicker">{copy.kicker}</span>
            <h2 id="startupNoticeTitle">{copy.title}</h2>
            <p className="create-branch-sub">{copy.body}</p>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭提示" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="create-project-body startup-notice-body">
          <p className="create-branch-hint">{copy.hint}</p>
          <div className="startup-notice-repo">
            <a
              className="startup-notice-repo-main"
              href={PROJECT_GITHUB_URL}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`${copy.repoLabel} ${PROJECT_GITHUB_URL}`}
              onClick={openGithub}
            >
              <span className="create-folder-icon" aria-hidden="true"><Brand id="github" extra="lg" /></span>
              <span className="create-folder-copy">
                <b>{copy.repoLabel}</b>
                <span className="mono">{PROJECT_GITHUB_HOST}</span>
              </span>
              <Icon name="external" extra="sm" />
            </a>
            <button
              type="button"
              className="icon-btn"
              aria-label={copied ? "已复制项目地址" : "复制项目地址"}
              data-tip={copied ? "已复制" : "复制"}
              onClick={(event) => { void copyUrl(event); }}
            >
              <Icon name={copied ? "check" : "copy"} extra="sm" />
            </button>
          </div>
        </div>
        <div className="create-project-foot startup-notice-foot">
          <p className="startup-notice-thanks">{copy.thanks}</p>
          <div className="startup-notice-actions">
            <button type="button" className="btn outline" onClick={onDontRemind}>不再提醒</button>
            <button type="button" className="btn primary" autoFocus onClick={onClose}>关闭</button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function StartupNotice(): ReactNode {
  const [open, setOpen] = useState(shouldShowStartupNotice);
  const close = useCallback(() => setOpen(false), []);
  const dontRemind = useCallback(() => {
    dismissStartupNoticeForever();
    setOpen(false);
  }, []);
  if (!open) return null;
  return <StartupNoticeDialog onClose={close} onDontRemind={dontRemind} />;
}
