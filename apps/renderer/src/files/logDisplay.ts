/** Read-only log presentation. Positions refer to the visible text, not the raw bytes. */
export type LogStyle = { foreground?: string | undefined; background?: string | undefined; bold?: boolean };
export type LogMark = { from: number; to: number; style: string };
export type LogDisplay = { text: string; marks: readonly LogMark[]; endStyle: LogStyle };

const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;
const SGR = /^\x1b\[([0-9;:]*)m$/;
const PALETTE = [
  "var(--text-2)", "var(--red)", "var(--green)", "var(--amber)",
  "var(--blue)", "var(--purple)", "var(--tint-cyan)", "var(--text)",
] as const;
const CUBE = [0, 95, 135, 175, 215, 255] as const;
const LEVEL = /^[ \t]*(?:(?:\[\d[^\]\n]*\]|(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)[ \t]+)?(\[?(?:trace|debug|info|notice|warning|warn|error|fatal|failed|fail|passed|pass|success|ok)\]?)(?=[ \t:]|$)/gim;
const LEVEL_COLOR: Record<string, string> = {
  trace: "text-faint", debug: "text-faint",
  info: "blue", notice: "blue",
  warn: "amber", warning: "amber",
  error: "red", fatal: "red", fail: "red", failed: "red",
  pass: "green", passed: "green", success: "green", ok: "green",
};

function indexedColor(index: number): string | undefined {
  if (index < 8) return PALETTE[index];
  if (index === 8) return "var(--text-faint)";
  if (index < 16) return "color-mix(in srgb, " + PALETTE[index - 8] + " 78%, var(--text))";
  if (index < 232) {
    const cube = index - 16;
    return "rgb(" + [CUBE[Math.floor(cube / 36)], CUBE[Math.floor(cube / 6) % 6], CUBE[cube % 6]].join(" ") + ")";
  }
  if (index < 256) {
    const gray = 8 + (index - 232) * 10;
    return "rgb(" + [gray, gray, gray].join(" ") + ")";
  }
}

function extendedColor(mode: number, channels: string[]): string | undefined {
  const values = channels.map(Number);
  if (channels.some(channel => channel === "") || !values.every(value => value <= 255)) return;
  if (mode === 5 && values.length === 1) return indexedColor(values[0]!);
  if (mode === 2 && values.length === 3) return "rgb(" + values.join(" ") + ")";
}

function applySgr(initial: LogStyle, parameters: string): LogStyle {
  let style = { ...initial };
  const parts = parameters.split(";");
  for (let index = 0; index < parts.length; index++) {
    const [parameter, ...inline] = parts[index]!.split(":");
    const code = Number(parameter);
    if (code === 38 || code === 48 || code === 58) {
      const mode = Number(inline.length ? inline[0] : parts[++index]);
      const count = mode === 2 ? 3 : mode === 5 ? 1 : 0;
      // Colon RGB has an optional color-space field before its three channels.
      const channels = inline.length
        ? inline.slice(mode === 2 && inline.length >= 5 ? 2 : 1).slice(0, count)
        : parts.slice(index + 1, index + 1 + count);
      if (!inline.length) index += count;
      const color = extendedColor(mode, channels);
      if (color !== undefined && code !== 58) style[code === 38 ? "foreground" : "background"] = color;
    } else if (code === 0) style = {};
    else if (code === 1) style.bold = true;
    else if (code === 22) style.bold = false;
    else if (code === 39) style.foreground = undefined;
    else if (code === 49) style.background = undefined;
    else if (code >= 30 && code <= 37) style.foreground = indexedColor(code - 30);
    else if (code >= 90 && code <= 97) style.foreground = indexedColor(code - 82);
    else if (code >= 40 && code <= 47) style.background = indexedColor(code - 40);
    else if (code >= 100 && code <= 107) style.background = indexedColor(code - 92);
  }
  return style;
}

export function displayLog(raw: string, initialStyle: LogStyle = {}): LogDisplay {
  const input = raw.replace(/\r\n?/g, "\n");
  const marks: LogMark[] = [];
  let text = "", start = 0, style = initialStyle;
  function append(segment: string) {
    if (!segment) return;
    const from = text.length;
    text += segment;
    const css = [
      style.foreground && "color: " + style.foreground,
      style.background && "background-color: " + style.background,
      style.bold && "font-weight: var(--fw-semibold)",
    ].filter(Boolean).join("; ");
    if (!css) return;
    const last = marks.at(-1);
    if (last?.to === from && last.style === css) last.to = text.length;
    else marks.push({ from, to: text.length, style: css });
  }

  for (const match of input.matchAll(ANSI_ESCAPE)) {
    append(input.slice(start, match.index));
    const sgr = SGR.exec(match[0]);
    if (sgr) style = applySgr(style, sgr[1]!);
    start = match.index + match[0].length;
  }
  append(input.slice(start));

  // Explicit ANSI wins. For plain log levels, color just the level token.
  const levels: LogMark[] = [];
  let index = 0;
  for (const match of text.matchAll(LEVEL)) {
    const label = match[1]!;
    const to = match.index + match[0].length, from = to - label.length;
    while (marks[index] && marks[index]!.to <= from) index++;
    if (marks[index] && marks[index]!.from < to) continue;
    const color = LEVEL_COLOR[label.replace(/[\[\]]/g, "").toLowerCase()];
    levels.push({ from, to, style: "color: var(--" + color + "); font-weight: var(--fw-semibold)" });
  }
  return { text, marks: [...marks, ...levels], endStyle: style };
}
