/**
 * Primary-modifier shortcuts, per platform.
 *
 * macOS uses ⌘ and leaves Ctrl to text editing (⌃K, ⌃A …) and the terminal;
 * elsewhere Ctrl (or Meta, as before) is the primary modifier. Labels keep the
 * existing Windows spelling ("Ctrl ⇧ O", "Ctrl+Shift+O") and use the macOS
 * symbols there ("⇧⌘O").
 */
import { PLATFORM, type RendererPlatform } from "../platform";

export interface ShortcutSpec {
  /** Key as printed: "K", "Enter", "1" … */
  readonly key: string;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** A different combination on macOS, e.g. redo is ⇧⌘Z there. */
  readonly mac?: Omit<ShortcutSpec, "mac">;
}

/** "kbd" is the menu style ("Ctrl ⇧ K"); "hint" is the inline style ("Ctrl+Shift+K"). */
export type ShortcutStyle = "kbd" | "hint";

export function isPrimaryModifier(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">,
  platform: RendererPlatform = PLATFORM,
): boolean {
  return platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey || event.metaKey;
}

const MAC_KEYS: Readonly<Record<string, string>> = { Enter: "↩", Backspace: "⌫", Escape: "⎋", Tab: "⇥" };

export function formatShortcut(spec: ShortcutSpec, style: ShortcutStyle = "kbd", platform: RendererPlatform = PLATFORM): string {
  if (platform === "darwin") {
    const mac = { ...spec, ...spec.mac };
    return `${mac.alt ? "⌥" : ""}${mac.shift ? "⇧" : ""}⌘${MAC_KEYS[mac.key] ?? mac.key}`;
  }
  if (style === "kbd") return ["Ctrl", spec.shift ? "⇧" : undefined, spec.alt ? "Alt" : undefined, spec.key].filter(Boolean).join(" ");
  return ["Ctrl", spec.shift ? "Shift" : undefined, spec.alt ? "Alt" : undefined, spec.key].filter(Boolean).join("+");
}

/** Both platforms' spellings, so palette search finds "ctrl k" and "⌘K" alike. */
export function shortcutSearchText(spec: ShortcutSpec): string {
  return `${formatShortcut(spec, "hint", "win32")} ${formatShortcut(spec, "kbd", "darwin")} cmd`;
}

/** The shortcuts the shell advertises, one spec each. */
export const SHORTCUTS = Object.freeze({
  newChat: { key: "O", shift: true },
  commandPalette: { key: "K" },
  toggleSidebar: { key: "B" },
  toggleBottomPanel: { key: "J" },
  skills: { key: "K", shift: true },
  followUp: { key: "Enter" },
  undo: { key: "Z" },
  redo: { key: "Y", mac: { key: "Z", shift: true } },
  cut: { key: "X" },
  copy: { key: "C" },
  paste: { key: "V" },
  selectAll: { key: "A" },
} satisfies Record<string, ShortcutSpec>);
