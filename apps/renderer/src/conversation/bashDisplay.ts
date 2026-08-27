/** CSI, OSC, and single-char ESC sequences from tool stdout. */
const ANSI_RE = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Apply in-line `\r` the way a terminal does: each segment overwrites from
 * column 0. Used so npm / Vite progress lines do not pile up as garbage.
 */
export function applyCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text.split("\n").map((line) => {
    if (!line.includes("\r")) return line;
    let current = "";
    for (const part of line.split("\r")) {
      current = part + current.slice(part.length);
    }
    return current;
  }).join("\n");
}

export function displayBashOutput(text: string): string {
  return applyCarriageReturns(stripAnsi(text));
}

export type BashDisplayRow = {
  readonly text: string;
  readonly cls: string;
};

/**
 * 展示上限，只保留尾部。流式期间每个 chunk 都要重跑一次 ANSI 剥离与行切分；
 * 不设上限时一份 256 KiB 的构建日志每帧都要全量正则扫描并铺出上万个 DOM 节点。
 * 先裁尾再处理，使单次代价与输出总长无关。
 */
export const BASH_DISPLAY_MAX_ROWS = 1500;
export const BASH_DISPLAY_MAX_CHARS = 64 * 1024;

export type BashDisplay = {
  readonly rows: readonly BashDisplayRow[];
  /** 前面还有内容被省略，只显示了尾部。 */
  readonly truncated: boolean;
};

/**
 * 取末尾至多 maxRows 行且不超过 maxChars 个字符。`lastIndexOf` 从尾部单向回退，
 * 总代价是 O(保留长度)，与被丢弃的前缀无关。
 */
export function bashTailSlice(
  text: string,
  maxRows = BASH_DISPLAY_MAX_ROWS,
  maxChars = BASH_DISPLAY_MAX_CHARS,
): { readonly text: string; readonly truncated: boolean } {
  let start = text.length > maxChars ? text.length - maxChars : 0;
  if (start > 0) {
    /* 字符上限落在行中间时从下一行开始，避免留半行开头。 */
    const nextBreak = text.indexOf("\n", start);
    start = nextBreak === -1 ? start : nextBreak + 1;
  }
  let cut = text.length;
  let rows = 0;
  while (rows < maxRows) {
    const previous = text.lastIndexOf("\n", cut - 1);
    if (previous < start) break;
    cut = previous;
    rows += 1;
  }
  if (rows === maxRows && cut > start) start = cut + 1;
  if (start === 0) return { text, truncated: false };
  return { text: text.slice(start), truncated: true };
}

export function bashDisplay(raw: unknown, maxRows = BASH_DISPLAY_MAX_ROWS): BashDisplay {
  if (Array.isArray(raw)) {
    const truncated = raw.length > maxRows;
    const lines = truncated ? raw.slice(raw.length - maxRows) : raw;
    const rows: BashDisplayRow[] = [];
    for (const line of lines) {
      if (Array.isArray(line)) {
        rows.push({
          text: displayBashOutput(String(line[0] ?? "")),
          cls: typeof line[1] === "string" && line[1] ? `c-${line[1]}` : "",
        });
      } else {
        rows.push({ text: displayBashOutput(String(line)), cls: "" });
      }
    }
    return { rows, truncated };
  }
  if (typeof raw !== "string" || raw.length === 0) return { rows: [], truncated: false };
  const tail = bashTailSlice(raw, maxRows);
  const rows: BashDisplayRow[] = [];
  for (const line of displayBashOutput(tail.text).split("\n")) {
    rows.push({ text: line, cls: "" });
  }
  return { rows, truncated: tail.truncated };
}
