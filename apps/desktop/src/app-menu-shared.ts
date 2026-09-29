/**
 * Commands the native macOS menu bar sends to the renderer. Shared by Main and
 * the sandboxed preload; no Electron Main APIs. The renderer maps each id onto
 * an action its own title menu and command palette already expose.
 */
export const APP_MENU_COMMAND_CHANNEL = "omp-studio:desktop:menu-command";

export const APP_MENU_COMMANDS = Object.freeze([
  "app.settings",
  "file.newChat",
  "file.openProject",
  "view.commandPalette",
  "view.toggleSidebar",
  "view.toggleBottomPanel",
  "view.toggleSkills",
  "help.shortcuts",
] as const);

export type AppMenuCommand = (typeof APP_MENU_COMMANDS)[number];

export function isAppMenuCommand(value: unknown): value is AppMenuCommand {
  return typeof value === "string" && (APP_MENU_COMMANDS as readonly string[]).includes(value);
}
