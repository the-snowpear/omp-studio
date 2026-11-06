import type { DockRect } from "./types";

export function workbenchBounds(surface: Document = document): DockRect | null {
  const shell = surface.querySelector<HTMLElement>("[data-dock-workbench]");
  if (shell) {
    const box = shell.getBoundingClientRect();
    const navigation = shell.querySelector<HTMLElement>(".cw-navigation-slot")?.getBoundingClientRect();
    const left = navigation?.width ? navigation.right : box.left;
    if (box.width && box.height) return { x: left, y: box.top, width: box.right - left, height: box.height };
  }
  const root = surface.querySelector<HTMLElement>(".adaptive-workbench") ?? surface.querySelector<HTMLElement>(".app-shell");
  const box = root?.getBoundingClientRect();
  return box?.width && box.height ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
}

export function floatTitle(tool: string, conversation?: string): string {
  return conversation ? `${tool} · ${conversation}` : tool;
}
