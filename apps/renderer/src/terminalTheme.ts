import type { Terminal } from "@xterm/xterm";

export function readCssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value.length > 0 ? value : fallback;
}

export function readXtermTheme(): {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
} {
  return {
    background: readCssVar("--surface", "#ffffff"),
    foreground: readCssVar("--text", "#1d2129"),
    cursor: readCssVar("--text", "#1d2129"),
    cursorAccent: readCssVar("--surface", "#ffffff"),
    selectionBackground: readCssVar(
      "--accent-soft",
      "rgba(110, 86, 207, 0.18)",
    ),
    selectionForeground: readCssVar("--text", "#1d2129"),
  };
}

export function readTerminalTypography(): { fontFamily: string; fontSize: number } {
  return {
    fontFamily: readCssVar("--font-terminal", "Menlo, Consolas, monospace"),
    fontSize: Number.parseFloat(readCssVar("--terminal-font-size", "12px")),
  };
}

export function applyTheme(term: Terminal): void {
  term.options.theme = readXtermTheme();
  const typography = readTerminalTypography();
  term.options.fontFamily = typography.fontFamily;
  term.options.fontSize = typography.fontSize;
}
