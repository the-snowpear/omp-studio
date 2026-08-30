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

/** 同一类别的连续行合成的一段；`text` 内部保留原来的换行。 */
export type BashDisplayBlock = BashDisplayRow;

/**
 * 展示上限，只保留尾部。流式期间每个 chunk 都要重跑一次 ANSI 剥离与行切分；
 * 不设上限时一份 256 KiB 的构建日志每帧都要全量正则扫描并铺出上万个 DOM 节点。
 * 先裁尾再处理，使单次代价与输出总长无关。
 */
export const BASH_DISPLAY_MAX_ROWS = 1500;
export const BASH_DISPLAY_MAX_CHARS = 64 * 1024;

export type BashDisplay = {
  readonly blocks: readonly BashDisplayBlock[];
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

/**
 * 输出分段。要点只有一条：把「同类别的连续行」合成一段。`.codeblock` 是
 * `white-space: pre`，段内的换行本来就照原样渲染，一行一个 `<div>` 只是把同一份文
 * 本铺成上千个 DOM 节点——而流式期间每帧都要重建并 diff 这上千个节点（实测 1200 行
 * 的构建日志每帧约 16ms 的 React 时间，一帧的预算就这么没了）。纯字符串输出（最常
 * 见的情况）因此收敛成单个文本节点，每帧只写一次 nodeValue。
 */
export function bashDisplay(raw: unknown, maxRows = BASH_DISPLAY_MAX_ROWS): BashDisplay {
  if (Array.isArray(raw)) {
    const truncated = raw.length > maxRows;
    const lines = truncated ? raw.slice(raw.length - maxRows) : raw;
    const runs: { readonly cls: string; readonly lines: string[] }[] = [];
    for (const line of lines) {
      const listed = Array.isArray(line);
      const text = displayBashOutput(String((listed ? line[0] : line) ?? ""));
      const cls = listed && typeof line[1] === "string" && line[1] ? `c-${line[1]}` : "";
      const last = runs[runs.length - 1];
      if (last !== undefined && last.cls === cls) last.lines.push(text);
      else runs.push({ cls, lines: [text] });
    }
    return { blocks: runs.map((run) => ({ cls: run.cls, text: run.lines.join("\n") })), truncated };
  }
  if (typeof raw !== "string" || raw.length === 0) return { blocks: [], truncated: false };
  const tail = bashTailSlice(raw, maxRows);
  return { blocks: [{ cls: "", text: displayBashOutput(tail.text) }], truncated: tail.truncated };
}
