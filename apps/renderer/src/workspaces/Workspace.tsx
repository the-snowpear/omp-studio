import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SlidingTabs, type SlidingTabItem } from "../SlidingTabs";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import "./workspace.css";

export function WorkspaceTabs<T extends string>({
  id,
  label,
  value,
  items,
  onChange,
  actions,
}: {
  id: string;
  label: string;
  value: T;
  items: ReadonlyArray<
    Pick<SlidingTabItem<T>, "id" | "icon" | "label" | "badge">
  >;
  onChange(value: T): void;
  actions?: ReactNode;
}) {
  return (
    <div className="workspace-tabbar">
      <SlidingTabs
        id={id}
        ariaLabel={label}
        orientation="horizontal"
        value={value}
        onChange={onChange}
        syncKey={items.map((item) => item.label).join("|")}
        items={items.map((item) => ({
          ...item,
          buttonId: `${id}-${item.id}`,
          panelId: `${id}-${item.id}-panel`,
        }))}
      />
      {actions ? <div className="workspace-tab-actions">{actions}</div> : null}
    </div>
  );
}

export function WorkspacePanel({
  id,
  name,
  active,
  children,
}: {
  id: string;
  name: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={`${id}-${name}-panel`}
      role="tabpanel"
      aria-labelledby={`${id}-${name}`}
      hidden={!active}
      className="workspace-panel"
    >
      {children}
    </section>
  );
}

/** A full workspace and a collapsible legacy entry share the same body. */
export function WorkspaceSection({
  standalone = false,
  className,
  title,
  description,
  actions,
  onOpenChange,
  children,
}: {
  standalone?: boolean;
  className: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  return standalone ? (
    <section className={`${className} workspace-section`}>
      <header className="workspace-section-heading">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? (
          <div className="workspace-section-actions">{actions}</div>
        ) : null}
      </header>
      {children}
    </section>
  ) : (
    <details
      className={className}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary>{title}</summary>
      {children}
    </details>
  );
}

const STATE_LABELS: Record<string, [string, string]> = {
  unavailable: ["不可用", "Unavailable"],
  inactive: ["未运行", "Inactive"],
  scheduled: ["等待保温", "Scheduled"],
  refreshing: ["保温中", "Refreshing"],
  complete: ["已完成", "Completed"],
  pending: ["待处理", "Pending"],
  unknown: ["未知", "Unknown"],
  aborted: ["已中止", "Aborted"],
  disconnected: ["未连接", "Disconnected"],
  working: ["处理中", "Working"],
  recording: ["录制中", "Recording"],
  saving: ["保存中", "Saving"],
  saved: ["已保存", "Saved"],
  ready: ["就绪", "Ready"],
  stopped: ["已停止", "Stopped"],
  restarting: ["重启中", "Restarting"],
  stopping: ["停止中", "Stopping"],
  cancelling: ["取消中", "Cancelling"],
  parked: ["已停驻", "Parked"],
  queued: ["排队中", "Queued"],
  running: ["运行中", "Running"],
  waiting: ["等待中", "Waiting"],
  paused: ["已暂停", "Paused"],
  completed: ["已完成", "Completed"],
  cancelled: ["已取消", "Cancelled"],
  failed: ["失败", "Failed"],
  interrupted: ["已中断", "Interrupted"],
  off: ["未开始", "Off"],
  prepared: ["已就绪", "Ready"],
  connecting: ["连接中", "Connecting"],
  listening: ["聆听中", "Listening"],
  speaking: ["播放中", "Speaking"],
  muted: ["已静音", "Muted"],
  error: ["错误", "Error"],
  exited: ["已退出", "Exited"],
  idle: ["空闲", "Idle"],
  starting: ["启动中", "Starting"],
};

export function workspaceStateLabel(state: string, language: string): string {
  return STATE_LABELS[state]?.[language === "zh" ? 0 : 1] ?? state;
}

export function WorkspaceStatus({ state }: { state: string }) {
  const { resolvedLanguage } = useI18n();
  const label = workspaceStateLabel(state, resolvedLanguage);
  const tone = ["failed", "error", "interrupted"].includes(state)
    ? "error"
    : ["completed", "complete", "prepared", "saved"].includes(state)
      ? "success"
      : [
            "running",
            "connecting",
            "listening",
            "speaking",
            "starting",
            "recording",
            "saving",
          ].includes(state)
        ? "active"
        : "neutral";
  return (
    <span className={`workspace-status workspace-status-${tone}`}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

export function WorkspaceEmpty({
  title,
  children,
  icon = "folder",
}: {
  title: string;
  children?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="workspace-empty">
      <Icon name={icon} />
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function WorkspaceDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const { resolvedLanguage } = useI18n();
  const element = useRef<HTMLElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    element.current
      ?.querySelector<HTMLElement>(".workspace-dialog-close")
      ?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const choices = Array.from(
        element.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]',
        ) ?? [],
      ).filter((node) => node.getClientRects().length > 0);
      const first = choices[0],
        last = choices.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !element.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !element.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      className="modal-backdrop workspace-dialog-backdrop"
      onMouseDown={() => onClose()}
    >
      <section
        ref={element}
        className="modal workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-dialog-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-btn workspace-dialog-close"
            onClick={onClose}
            aria-label={
              resolvedLanguage === "zh" ? "关闭详情" : "Close details"
            }
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="workspace-dialog-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
