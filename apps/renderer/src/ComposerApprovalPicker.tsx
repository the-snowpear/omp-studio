/**
 * Composer 输入栏权限档位：Review / Workspace / Full Access。
 *
 * 预览开：纯本地演示，不调 Host。预览关：跟 snapshot，切换走 permissions.mode.set。
 * 正在看历史会话（Runtime 还没切过来）时胶囊仍可点：父级先 resume 再 set。
 * 流式 / 压缩中：胶囊仍可点，Runtime 把选择记到下一轮用户对话，本轮工具仍用原档。
 */

import { useState, type MouseEvent as ReactMouseEvent } from "react";

import type { ApprovalMode } from "@omp-studio/studio-protocol";

import { Icon } from "./icons";
import { useI18n } from "./i18n";

export function approvalPickerDisabled(input: {
  readonly preview: boolean;
  readonly executionMatches: boolean;
  readonly runtimeConnected: boolean;
  readonly snapshotReady: boolean;
  readonly canSet: boolean;
  readonly resyncRequired: boolean;
  readonly selectedSessionId?: string;
  readonly selectedThreadId?: string;
}): boolean {
  if (input.preview) return false;
  if (input.resyncRequired) return true;
  if (input.executionMatches) {
    return !input.runtimeConnected || !input.snapshotReady || !input.canSet;
  }
  return input.selectedSessionId === undefined || input.selectedThreadId === undefined;
}

/** Permission pill options (plan §5.1): Review → always-ask, Workspace → write, Full Access → yolo. */
export const APPROVAL_MODE_OPTIONS: ReadonlyArray<{
  readonly mode: ApprovalMode;
  readonly label: string;
  readonly descriptionKey: "composer.permissionReviewDesc" | "composer.permissionWorkspaceDesc" | "composer.permissionFullAccessDesc";
}> = [
  { mode: "always-ask", label: "Review", descriptionKey: "composer.permissionReviewDesc" },
  { mode: "write", label: "Workspace", descriptionKey: "composer.permissionWorkspaceDesc" },
  { mode: "yolo", label: "Full Access", descriptionKey: "composer.permissionFullAccessDesc" },
];

export const APPROVAL_MODE_LABELS: Readonly<Record<ApprovalMode, string>> = {
  "always-ask": "Review",
  write: "Workspace",
  yolo: "Full Access",
};

/** Keep composer :focus-within while clicking menu items (same as ComposerModePicker). */
function retainComposerFocus(event: ReactMouseEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest("input:not([type='checkbox']):not([type='radio']), select, textarea")) return;
  event.preventDefault();
}

export function ComposerApprovalPicker({
  preview,
  mode,
  indeterminate = false,
  disabled,
  nextTurnOnly = false,
  onChange,
  onInteract,
}: {
  preview: boolean;
  mode: ApprovalMode;
  /** Viewing a history session whose live snapshot is not this thread — no option is current. */
  indeterminate?: boolean;
  disabled: boolean;
  /** Live turn still uses the previous trust level. */
  nextTurnOnly?: boolean;
  onChange: (mode: ApprovalMode) => void;
  onInteract?: () => void;
}) {
  const { t, resolvedLanguage } = useI18n();
  const [open, setOpen] = useState(false);
  const label = APPROVAL_MODE_LABELS[mode];

  const select = (next: ApprovalMode) => {
    onInteract?.();
    setOpen(false);
    if (!indeterminate && next === mode) return;
    onChange(next);
  };

  return (
    <span className="approval-pill-wrap">
      <button
        type="button"
        className={`pill-btn${mode === "yolo" ? " danger" : ""}`}
        disabled={disabled}
        onClick={() => {
          onInteract?.();
          setOpen((value) => !value);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t("composer.permissionMode")}${resolvedLanguage === "zh" ? "：" : ": "}${label}`}
        data-tip={disabled ? t("composer.cannotSwitchPermission") : t("composer.permissionPillTip")}
      >
        <Icon name="shield" extra="sm" />
        <span>{label}</span>
      </button>
      {open ? (
        <>
          <div className="approval-menu-backdrop" onClick={() => setOpen(false)} />
          <div
            className="approval-menu"
            role="menu"
            aria-label={t("composer.permissionMode")}
            onMouseDown={retainComposerFocus}
          >
            {preview ? (
              <p className="cmp-menu-note">
                <span className="chip gray xs">{t("common.demo")}</span>{t("composer.previewModelNote")}
              </p>
            ) : null}
            {nextTurnOnly ? <p className="cmp-menu-note">{t("composer.permissionNoteNextTurn")}</p> : null}
            {APPROVAL_MODE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.mode}
                role="menuitemradio"
                aria-checked={indeterminate ? false : mode === option.mode}
                className={`approval-menu-item${!indeterminate && mode === option.mode ? " selected" : ""}${option.mode === "yolo" ? " danger" : ""}`}
                onClick={() => select(option.mode)}
              >
                <span className="am-label">{option.label}</span>
                <span className="am-desc">{t(option.descriptionKey)}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </span>
  );
}
