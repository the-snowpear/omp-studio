import { useConversationDom } from "../conversationWorkspace/Context";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "../icons";
import { MenuItem, useRowMenuAnchor } from "../menus";
import { useI18n } from "../i18n";
import { SHORTCUTS, formatShortcut } from "../keyboard/shortcuts";
import { fileManagerName } from "../platformCopy";
import { usePreviewMode } from "../preview/PreviewContext";
import { type Route, type ShellChrome } from "./types";

export type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";

export function execEditCommand(command: EditCommand): void {
  try {
    document.execCommand(command);
  } catch {
    /* Chromium may reject an unsupported edit command; the focused field is unchanged. */
  }
}

export function TitleMenu({ id, label, openId, onToggle, children }: {
  id: string;
  label: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  children: ReactNode;
}) {
  const { document } = useConversationDom();
  const open = openId === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setAnchor({ top: rect.bottom + 2, left: rect.left });
  }, [open]);

  return (
    <div className={`title-menu${open ? " open" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className="title-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onToggle(open ? null : id)}
      >
        {label}
      </button>
      {open
        ? createPortal(
            <div
              className="menu title-menu-popover"
              role="menu"
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => {
                if (!(event.target as Element).closest("input, textarea, [contenteditable]")) event.preventDefault();
                event.stopPropagation();
              }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** 左上应用菜单（ver1 sb-top 汉堡按钮）：本地命令入口聚合，各项复用既有表面，
 * 不引入新的 Host 能力；无后端的项按惯例禁用并给出原因。 */
export function AppMenu({ chrome, onRoute }: {
  chrome: ShellChrome;
  onRoute: (route: Route) => void;
}) {
  const { document, window } = useConversationDom();
  const { preview, marks } = usePreviewMode();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const run = (action?: () => void) => {
    setOpen(false);
    action?.();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menu = menuRef.current;
      const pad = 8;
      let left = rect.left;
      let top = rect.bottom + 6;
      if (menu) {
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        if (left + width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - width - pad);
        if (top + height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - height - pad);
      }
      setPos({ top, left });
    };
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 项目 shell 两项的禁用条件与顶栏面包屑菜单一致：无真实 workspace / 非桌面端 / 动作进行中。
  const shellItemProps = (kind: "editor" | "directory") => chrome.projectShellUnavailable !== undefined
    ? { disabled: true, title: chrome.projectShellUnavailable }
    : chrome.projectShellAction !== null
      ? { disabled: true, ...(chrome.projectShellAction === kind ? { title: t("common.opening") } : {}) }
      : {};

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn"
        data-tip={t("nav.menu")}
        aria-label={t("nav.menu")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="menu" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="menu app-menu-popover"
              role="menu"
              aria-label={t("nav.menu")}
              style={{ top: pos.top, left: pos.left }}
            >
              <div className="menu-label">{t("shell.globalActions")}</div>
              <MenuItem icon="plus" kbd={formatShortcut(SHORTCUTS.newChat)} onClick={() => run(chrome.onStartNewChat)}>{t("nav.newChat")}</MenuItem>
              <MenuItem
                icon="folder-open"
                {...(preview
                  ? { disabled: true, title: marks ? t("common.unavailableInPreview") : t("common.unavailable") }
                  : { onClick: () => run(chrome.onPickProject) })}
              >{t("nav.openProject")}</MenuItem>
              <MenuItem icon="branch" disabled title={t("common.notImplemented")}>{t("shell.cloneRepo")}</MenuItem>
              <MenuItem icon="flask" disabled title={t("common.notImplemented")}>{t("shell.tempWorkspace")}</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="plus" onClick={() => run(chrome.onCreateProject)}>{t("nav.createProject")}</MenuItem>
              <MenuItem icon="home" onClick={() => run(() => onRoute("home"))}>{t("nav.home")}</MenuItem>
              <MenuItem icon="history" onClick={() => run(() => onRoute("history"))}>{t("nav.history")}</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="search" kbd={formatShortcut(SHORTCUTS.commandPalette)} onClick={() => run(chrome.onOpenPalette)}>{t("nav.search")}</MenuItem>
              <MenuItem icon="terminal" kbd={formatShortcut(SHORTCUTS.toggleBottomPanel)} onClick={() => run(chrome.onOpenTerminalPanel)}>{t("nav.terminal")}</MenuItem>
              <MenuItem icon="external" {...shellItemProps("editor")} onClick={() => run(chrome.onOpenProjectInEditor)}>{t("shell.openInEditor")}</MenuItem>
              <MenuItem icon="folder" {...shellItemProps("directory")} onClick={() => run(chrome.onOpenProjectDirectory)}>{t("shell.openInExplorer", { fileManager: fileManagerName(t) })}</MenuItem>
              <MenuItem icon="server" hint={t("menu.modelConfigHint")} onClick={() => run(() => onRoute("model-config"))}>{t("nav.modelConfig")}</MenuItem>
              <MenuItem icon="image" onClick={() => run(() => onRoute("media"))}>{t("media.title")}</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="settings" onClick={() => run(() => onRoute("settings"))}>{t("nav.settings")}</MenuItem>
              <MenuItem icon="keyboard" onClick={() => run(() => chrome.onOpenDialog("shortcuts"))}>{t("nav.shortcuts")}</MenuItem>
              <MenuItem icon="info" onClick={() => run(() => chrome.onOpenDialog("about"))}>{t("nav.about")}</MenuItem>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function CrumbMenu({ id, openId, onToggle, tip, current, children, menu }: {
  id: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  tip: string;
  current?: boolean;
  children: ReactNode;
  menu: ReactNode;
}) {
  const open = openId === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const position = () => {
      const rect = buttonRef.current!.getBoundingClientRect();
      const width = menuRef.current?.offsetWidth ?? 240;
      setAnchor({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [open]);

  return (
    <div className="crumb-menu" onMouseDown={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className={`crumb-item${current ? " crumb-current" : ""}${open ? " open" : ""}`}
        data-tip={tip}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onToggle(open ? null : id)}
      >
        {children}
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="menu title-menu-popover crumb-popover"
              role="menu"
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {menu}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** 顶栏「对话选项」与侧栏会话行 ⋯ 菜单共用的会话动作项（归档项作用目标不同，由调用方各自追加）。
    live/busy/compacting 语义与顶栏一致，只是取值来源不同：顶栏看当前会话，行菜单看所在行。 */
export function ThreadActionMenuItems({ live, busy, compacting, compactPending, reason, onRename, onFork, onHandoff, onCompact, onExport, onHistory, onPin, pinned }: {
  live: boolean;
  busy: boolean;
  compacting: boolean;
  compactPending: boolean;
  /** 禁用时的悬停原因（无 Runtime / 加载中 / 预览不可用）。 */
  reason: string;
  onRename: () => void;
  onPin?: (() => void) | undefined;
  pinned?: boolean | undefined;
  onFork: () => void;
  onHandoff: () => void;
  onCompact: () => void;
  onExport: () => void;
  onHistory: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <MenuItem
        icon="pencil"
        disabled={!live}
        {...(live ? {} : { title: reason })}
        onClick={onRename}
      >{t("conversation.renameThread")}</MenuItem>
      {onPin ? <MenuItem icon="pin" disabled={!live} onClick={onPin}>{pinned ? "取消置顶 / Unpin" : "置顶 / Pin"}</MenuItem> : null}
      <MenuItem
        icon="fork"
        disabled={!live || busy}
        {...(live && !busy ? {} : { title: reason })}
        onClick={onFork}
      >{t("shell.forkThread")}</MenuItem>
      <MenuItem
        icon="handoff"
        disabled={!live || busy}
        {...(live && !busy ? {} : { title: reason })}
        onClick={onHandoff}
      >{t("shell.handoffThread")}</MenuItem>
      <div className="menu-sep" />
      <MenuItem
        icon="minimize"
        disabled={!live || compacting || compactPending}
        {...(live && !compacting && !compactPending ? {} : { title: live ? t("common.loading") : reason })}
        onClick={onCompact}
      >{t("shell.compactThread")}</MenuItem>
      <MenuItem
        icon="export"
        disabled={!live || busy}
        {...(live && !busy ? {} : { title: reason })}
        onClick={onExport}
      >{t("shell.exportThread")}</MenuItem>
      <div className="menu-sep" />
      <MenuItem icon="history" onClick={onHistory}>{t("nav.history")}</MenuItem>
    </>
  );
}

/** 侧栏会话行「⋯ 更多」菜单：顶栏「对话选项」同款动作，弹层稍窄（208px）。
    两种锚定：⋯ 按钮触发时右缘对齐按钮右缘向左展开；行右键触发时弹层左上角
    贴光标（Windows 上下文菜单惯例）。上下左右均按视口钳制。 */
export function ThreadRowMenu({ id, openId, onToggle, contextPoint, menu }: {
  id: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  /** 非 null = 本次打开来自行右键，弹层贴该光标点。 */
  contextPoint: { x: number; y: number } | null;
  menu: ReactNode;
}) {
  const { document, window } = useConversationDom();
  const { t } = useI18n();
  const open = openId === id;
  const { buttonRef, menuRef, anchor } = useRowMenuAnchor(open, contextPoint, window);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`icon-btn${open ? " open" : ""}`}
        data-tip={t("common.moreActions")}
        aria-label={t("common.moreActions")}
        aria-haspopup="menu"
        aria-expanded={open}
        // 拦下 mousedown：窗口级「点外部关闭」不会在 toggle 前先把菜单关掉。
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => onToggle(open ? null : id)}
      ><Icon name="more" extra="sm" /></button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="menu title-menu-popover thread-row-popover"
              role="menu"
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {menu}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function AnchoredPop({ id, openId, onToggle, tip, label, align = "start", triggerClassName, popoverClassName, children, panel }: {
  id: string;
  openId: string | null;
  onToggle: (id: string | null) => void;
  tip: string;
  label: string;
  align?: "start" | "end";
  triggerClassName: string;
  popoverClassName?: string;
  children: ReactNode;
  panel: ReactNode;
}) {
  const { document, window } = useConversationDom();
  const open = openId === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const button = buttonRef.current;
    const place = () => {
      const rect = button.getBoundingClientRect();
      const width = popRef.current?.offsetWidth ?? (align === "end" ? 360 : 240);
      const left = align === "end"
        ? Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
        : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      setAnchor({ top: rect.bottom + 4, left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [align, open]);

  return (
    <div className="anchored-pop" onMouseDown={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className={`${triggerClassName}${open ? " open" : ""}`}
        data-tip={tip}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onToggle(open ? null : id)}
      >
        {children}
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className={`menu title-menu-popover${popoverClassName ? ` ${popoverClassName}` : ""}`}
              role="dialog"
              aria-label={label}
              style={{ top: anchor.top, left: anchor.left, "--popover-top": `${anchor.top}px` } as CSSProperties}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
            >
              {panel}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
