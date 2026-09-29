/**
 * The macOS menu bar.
 *
 * macOS routes ⌘C / ⌘V / ⌘Z to text fields through the Edit menu's roles, so
 * a window without an application menu cannot even paste. The in-window title
 * menu stays; this menu adds the platform one. Custom items only send an
 * allowlisted command id to the renderer, which maps it onto an existing
 * action. The shortcuts listed here are owned by the menu on macOS: the
 * renderer skips them there so one key press never runs an action twice.
 * Packaged builds carry no Reload or DevTools items. ⌘Q goes through the same
 * busy-session confirmation as the tray's Quit.
 */
import type { MenuItemConstructorOptions } from "electron";

import type { AppMenuCommand } from "../app-menu-shared.js";

export interface AppMenuOptions {
  readonly isPackaged: boolean;
  /** `app.getLocale()`; zh* gets Chinese labels. */
  readonly locale: string;
  readonly appName?: string;
  readonly dispatch: (command: AppMenuCommand) => void;
  readonly openRepository: () => void;
  readonly requestQuit: () => void;
}

/** Shortcuts the macOS menu owns; the renderer must not handle these itself on macOS. */
export const APP_MENU_ACCELERATORS: Readonly<Record<AppMenuCommand, string | undefined>> = Object.freeze({
  "app.settings": "Command+,",
  "file.newChat": "Shift+Command+O",
  "file.openProject": "Command+O",
  "view.commandPalette": "Command+K",
  "view.toggleSidebar": "Command+B",
  "view.toggleBottomPanel": "Command+J",
  "view.toggleSkills": "Shift+Command+K",
  "help.shortcuts": undefined,
});

interface MenuStrings {
  readonly about: string;
  readonly settings: string;
  readonly services: string;
  readonly hide: string;
  readonly hideOthers: string;
  readonly showAll: string;
  readonly quit: string;
  readonly file: string;
  readonly newChat: string;
  readonly openProject: string;
  readonly closeWindow: string;
  readonly edit: string;
  readonly undo: string;
  readonly redo: string;
  readonly cut: string;
  readonly copy: string;
  readonly paste: string;
  readonly pasteAndMatchStyle: string;
  readonly delete: string;
  readonly selectAll: string;
  readonly view: string;
  readonly commandPalette: string;
  readonly toggleSidebar: string;
  readonly toggleBottomPanel: string;
  readonly skills: string;
  readonly actualSize: string;
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly fullScreen: string;
  readonly reload: string;
  readonly forceReload: string;
  readonly devTools: string;
  readonly window: string;
  readonly minimize: string;
  readonly zoom: string;
  readonly front: string;
  readonly help: string;
  readonly shortcuts: string;
  readonly repository: string;
}

export function appMenuStrings(locale: string, appName = "OMP Studio"): MenuStrings {
  if (locale.toLowerCase().startsWith("zh")) {
    return {
      about: `关于 ${appName}`, settings: "设置…", services: "服务", hide: `隐藏 ${appName}`, hideOthers: "隐藏其他",
      showAll: "全部显示", quit: `退出 ${appName}`, file: "文件", newChat: "新对话", openProject: "打开项目…",
      closeWindow: "关闭窗口", edit: "编辑", undo: "撤销", redo: "重做", cut: "剪切", copy: "拷贝", paste: "粘贴",
      pasteAndMatchStyle: "粘贴并匹配样式", delete: "删除", selectAll: "全选", view: "显示", commandPalette: "命令面板",
      toggleSidebar: "显示/隐藏侧栏", toggleBottomPanel: "显示/隐藏底部面板", skills: "Skills", actualSize: "实际大小",
      zoomIn: "放大", zoomOut: "缩小", fullScreen: "进入全屏幕", reload: "重新载入", forceReload: "强制重新载入",
      devTools: "开发者工具", window: "窗口", minimize: "最小化", zoom: "缩放", front: "前置全部窗口", help: "帮助",
      shortcuts: "键盘快捷键", repository: `GitHub 上的 ${appName}`,
    };
  }
  return {
    about: `About ${appName}`, settings: "Settings…", services: "Services", hide: `Hide ${appName}`, hideOthers: "Hide Others",
    showAll: "Show All", quit: `Quit ${appName}`, file: "File", newChat: "New Conversation", openProject: "Open Project…",
    closeWindow: "Close Window", edit: "Edit", undo: "Undo", redo: "Redo", cut: "Cut", copy: "Copy", paste: "Paste",
    pasteAndMatchStyle: "Paste and Match Style", delete: "Delete", selectAll: "Select All", view: "View",
    commandPalette: "Command Palette", toggleSidebar: "Toggle Sidebar", toggleBottomPanel: "Toggle Bottom Panel",
    skills: "Skills", actualSize: "Actual Size", zoomIn: "Zoom In", zoomOut: "Zoom Out", fullScreen: "Enter Full Screen",
    reload: "Reload", forceReload: "Force Reload", devTools: "Developer Tools", window: "Window", minimize: "Minimize",
    zoom: "Zoom", front: "Bring All to Front", help: "Help", shortcuts: "Keyboard Shortcuts",
    repository: `${appName} on GitHub`,
  };
}

export function buildApplicationMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] {
  const appName = options.appName ?? "OMP Studio";
  const s = appMenuStrings(options.locale, appName);
  const command = (label: string, id: AppMenuCommand): MenuItemConstructorOptions => {
    const accelerator = APP_MENU_ACCELERATORS[id];
    return { label, ...(accelerator === undefined ? {} : { accelerator }), click: () => options.dispatch(id) };
  };
  const separator: MenuItemConstructorOptions = { type: "separator" };
  return [
    {
      label: appName,
      submenu: [
        { role: "about", label: s.about },
        separator,
        command(s.settings, "app.settings"),
        separator,
        { role: "services", label: s.services },
        separator,
        { role: "hide", label: s.hide },
        { role: "hideOthers", label: s.hideOthers },
        { role: "unhide", label: s.showAll },
        separator,
        { label: s.quit, accelerator: "Command+Q", click: () => options.requestQuit() },
      ],
    },
    {
      label: s.file,
      submenu: [command(s.newChat, "file.newChat"), command(s.openProject, "file.openProject"), separator, { role: "close", label: s.closeWindow }],
    },
    {
      label: s.edit,
      submenu: [
        { role: "undo", label: s.undo },
        { role: "redo", label: s.redo },
        separator,
        { role: "cut", label: s.cut },
        { role: "copy", label: s.copy },
        { role: "paste", label: s.paste },
        { role: "pasteAndMatchStyle", label: s.pasteAndMatchStyle },
        { role: "delete", label: s.delete },
        { role: "selectAll", label: s.selectAll },
      ],
    },
    {
      label: s.view,
      submenu: [
        command(s.commandPalette, "view.commandPalette"),
        command(s.toggleSidebar, "view.toggleSidebar"),
        command(s.toggleBottomPanel, "view.toggleBottomPanel"),
        command(s.skills, "view.toggleSkills"),
        separator,
        { role: "resetZoom", label: s.actualSize },
        { role: "zoomIn", label: s.zoomIn },
        { role: "zoomOut", label: s.zoomOut },
        separator,
        { role: "togglefullscreen", label: s.fullScreen },
        ...(options.isPackaged
          ? []
          : [
              separator,
              { role: "reload", label: s.reload } as const,
              { role: "forceReload", label: s.forceReload } as const,
              { role: "toggleDevTools", label: s.devTools } as const,
            ]),
      ],
    },
    {
      label: s.window,
      role: "window",
      submenu: [{ role: "minimize", label: s.minimize }, { role: "zoom", label: s.zoom }, separator, { role: "front", label: s.front }],
    },
    {
      label: s.help,
      role: "help",
      submenu: [command(s.shortcuts, "help.shortcuts"), { label: s.repository, click: () => options.openRepository() }],
    },
  ];
}
