/**
 * 共享菜单原语：`MenuItem`（自 App.tsx 迁出，供顶栏 / 会话行 / Explorer 文件行
 * 复用）与 Explorer 文件行「更多操作」菜单。菜单内容与弹层拆开：真实树
 * （App.tsx RealFileTree）与预览树（preview/surfaces.tsx）渲染同一份
 * FileMenuContent / FileRowMenu，预览态用 desktopActionsReason 禁用桌面依赖项。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./icons";
import { useI18n } from "./i18n";

export function MenuItem({ icon, children, hint, kbd, disabled, title, current, onClick }: {
  icon?: string;
  children: ReactNode;
  hint?: string;
  /** 右侧快捷键徽标；只标注当前真实存在的快捷键（aria-hidden 避免读屏重复播报）。 */
  kbd?: string;
  disabled?: boolean;
  title?: string | undefined;
  current?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="menu-item"
      role="menuitem"
      disabled={disabled}
      data-tip={title}
      aria-current={current ? "true" : undefined}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} extra="sm" /> : null}
      <span>{children}</span>
      {hint ? <span className="hint">{hint}</span> : null}
      {kbd ? <span className="kbd" aria-hidden="true">{kbd}</span> : null}
    </button>
  );
}

export type FileMenuTarget = {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "dir";
};

/** 「打开」对文件 = 系统默认程序（Main shell.openPath）；对目录 = 树内展开/收起（caller 本地执行）。 */
export type FileMenuAction =
  | { readonly type: "open" }
  | { readonly type: "openWith"; readonly openerId: string }
  | { readonly type: "reveal" }
  | { readonly type: "copyAbsolute" }
  | { readonly type: "copyRelative" }
  | { readonly type: "addContext" };

export interface FileOpenerOption {
  readonly id: string;
  readonly name: string;
}

/** 行「⋯ 更多」菜单的下发束：状态与回调打包，递归树（真实与预览）只钻一个 prop。 */
export interface FileMenuController {
  openId: string | null;
  /** 非 null = 当前弹层由行右键打开，贴该光标点。 */
  point: { x: number; y: number } | null;
  openers: ReadonlyArray<FileOpenerOption>;
  /** undefined = 桌面动作可用；否则为禁用原因（预览演示树 / 非桌面端）。 */
  desktopReason: string | undefined;
  onToggle: (id: string | null) => void;
  onContext: (event: { clientX: number; clientY: number; preventDefault(): void }, path: string) => void;
  onAction: (action: FileMenuAction, target: FileMenuTarget) => void;
}

/** 悬停展开的「打开方式」子菜单（cmp-flyout 模式：宽限关闭 + 左右翻叠）。 */
function OpenWithZone({ openers, disabled, reason, onPick }: {
  openers: ReadonlyArray<FileOpenerOption>;
  disabled: boolean;
  reason?: string | undefined;
  onPick: (openerId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"right" | "left">("right");
  const zoneRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  useEffect(() => cancelClose, []);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = zoneRef.current?.getBoundingClientRect();
    if (rect !== undefined) {
      setSide(rect.right + 216 <= window.innerWidth - 8 ? "right" : "left");
    }
  }, [open]);

  if (disabled) {
    return <MenuItem icon="external" disabled title={reason}>{t("shell.fileOpenWith")}</MenuItem>;
  }
  return (
    <div
      ref={zoneRef}
      className="explorer-openwith-zone"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={() => {
        cancelClose();
        closeTimerRef.current = window.setTimeout(() => setOpen(false), 160);
      }}
    >
      <button
        type="button"
        className="menu-item"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="external" extra="sm" />
        <span>{t("shell.fileOpenWith")}</span>
        <Icon name={side === "right" ? "chevron-r" : "chevron-l"} extra="sm" />
      </button>
      {open
        ? (
          <div className={`menu explorer-openwith-flyout side-${side}`} role="menu">
            {openers.map((opener) => (
              <MenuItem key={opener.id} onClick={() => onPick(opener.id)}>{opener.name}</MenuItem>
            ))}
            {openers.length > 0 ? <div className="menu-sep" /> : null}
            <MenuItem onClick={() => onPick("choose")}>{t("shell.fileOpenWithChoose")}</MenuItem>
          </div>
        )
        : null}
    </div>
  );
}

export function FileMenuContent({ target, openers, onRun, desktopActionsReason }: {
  target: FileMenuTarget;
  openers: ReadonlyArray<FileOpenerOption>;
  onRun: (action: FileMenuAction) => void;
  /** 非 undefined 时（预览演示树 / 非桌面端）桌面依赖项禁用并以 tip 说明原因。 */
  desktopActionsReason?: string | undefined;
}) {
  const { t } = useI18n();
  const desktopOnly = desktopActionsReason === undefined
    ? {}
    : { disabled: true, title: desktopActionsReason };
  return (
    <>
      <MenuItem
        icon={target.kind === "dir" ? "folder-open" : "external"}
        onClick={() => onRun({ type: "open" })}
        // 目录的「打开」是树内展开/收起，纯本地，不受桌面能力限制。
        {...(target.kind === "file" ? desktopOnly : {})}
      >
        {t("shell.fileOpen")}
      </MenuItem>
      <OpenWithZone
        openers={openers}
        disabled={desktopActionsReason !== undefined}
        reason={desktopActionsReason}
        onPick={(openerId) => onRun({ type: "openWith", openerId })}
      />
      <div className="menu-sep" />
      <MenuItem icon="folder-open" onClick={() => onRun({ type: "reveal" })} {...desktopOnly}>
        {t("shell.fileRevealInExplorer")}
      </MenuItem>
      <MenuItem icon="copy" onClick={() => onRun({ type: "copyAbsolute" })} {...desktopOnly}>
        {t("shell.copyAbsolutePath")}
      </MenuItem>
      <MenuItem icon="copy" onClick={() => onRun({ type: "copyRelative" })}>
        {t("shell.copyRelativePath")}
      </MenuItem>
      <div className="menu-sep" />
      <MenuItem icon="at" onClick={() => onRun({ type: "addContext" })}>
        {t("shell.addContext")}
      </MenuItem>
    </>
  );
}

/** Explorer 文件/目录行「⋯ 更多」菜单：锚定 / 钳制 / 翻叠与 ThreadRowMenu 同款。
    ⋯ 按钮触发时右缘对齐按钮、下方 4px；行右键触发时弹层左上角贴光标。 */
export function FileRowMenu({ id, openId, onToggle, contextPoint, target, openers, onAction, desktopActionsReason }: {
  id: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  /** 非 null = 本次打开来自行右键，弹层贴该光标点。 */
  contextPoint: { x: number; y: number } | null;
  target: FileMenuTarget;
  openers: ReadonlyArray<FileOpenerOption>;
  onAction: (action: FileMenuAction, target: FileMenuTarget) => void;
  desktopActionsReason?: string | undefined;
}) {
  const { t } = useI18n();
  const open = openId === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const pad = 8;
      const width = menuRef.current?.offsetWidth ?? 208;
      const height = menuRef.current?.offsetHeight ?? 0;
      let left: number;
      let top: number;
      if (contextPoint !== null) {
        left = contextPoint.x;
        top = contextPoint.y;
      } else {
        const rect = buttonRef.current?.getBoundingClientRect();
        if (!rect) return;
        left = rect.right - width;
        top = rect.bottom + 4;
      }
      left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));
      if (height > 0 && top + height > window.innerHeight - pad) {
        top = Math.max(pad, window.innerHeight - height - pad);
      }
      setAnchor({ top, left });
    };
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [contextPoint, open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`icon-btn${open ? " open" : ""}`}
        data-tip={t("common.more")}
        aria-label={`${t("common.moreActions")} ${target.path}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onToggle(open ? null : id);
        }}
      ><Icon name="more" extra="sm" /></button>
      {open
        ? createPortal(
          <div
            ref={menuRef}
            className="menu title-menu-popover explorer-file-popover"
            role="menu"
            style={{ top: anchor.top, left: anchor.left }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            // portal 事件沿 React 树冒泡：不拦下会触发行 div 的 onClick（选中/展开）。
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
          >
            <FileMenuContent
              target={target}
              openers={openers}
              desktopActionsReason={desktopActionsReason}
              onRun={(action) => {
                onToggle(null);
                onAction(action, target);
              }}
            />
          </div>,
          document.body,
        )
        : null}
    </>
  );
}
