/**
 * Magic-keyword detection for Studio (OMP-aligned).
 *
 * Matching mirrors oh-my-pi `modes/magic-keyword-boundary.ts` + `markdown-prose.ts`:
 * lowercase standalone prose only; skip fenced/inline code and HTML/XML.
 */

export const MAGIC_KEYWORDS = ["ultrathink", "orchestrate", "workflowz"] as const;

export type MagicKeywordId = (typeof MAGIC_KEYWORDS)[number];

export type MagicKeywordMatch = {
  readonly start: number;
  readonly end: number;
  readonly keyword: MagicKeywordId;
};

const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y;
const FENCE = /^( {0,3})([`~]{3,})/;

const PROBES: Readonly<Record<MagicKeywordId, RegExp>> = {
  ultrathink: /ultrathink/,
  orchestrate: /orchestrate/,
  workflowz: /workflowz/,
};

const HIGHLIGHTS: Readonly<Record<MagicKeywordId, RegExp>> = {
  ultrathink: magicKeywordRegex("ultrathink", "g"),
  orchestrate: magicKeywordRegex("orchestrate", "g"),
  workflowz: magicKeywordRegex("workflowz", "g"),
};

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Case-sensitive prose-boundary matcher (OMP `magicKeywordRegex`). */
export function magicKeywordRegex(keyword: string, flags = ""): RegExp {
  const normalizedFlags = flags.includes("u") ? flags : `${flags}u`;
  return new RegExp(`${LEFT_BOUNDARY}${escapeRegExp(keyword)}${RIGHT_BOUNDARY}`, normalizedFlags);
}

function backtickRunEnd(text: string, i: number, n: number): number {
  let j = i;
  while (j < n && text[j] === "`") j += 1;
  return j;
}

function findBacktickClose(text: string, from: number, n: number, runLen: number, masked: Uint8Array): number {
  let k = from;
  while (k < n) {
    if (masked[k]) {
      k += 1;
      continue;
    }
    if (text[k] === "`") {
      const e = backtickRunEnd(text, k, n);
      if (e - k === runLen) return e;
      k = e;
      continue;
    }
    k += 1;
  }
  return -1;
}

function findTagEnd(text: string, j: number, n: number): number {
  let quote = "";
  for (let k = j; k < n; k += 1) {
    const ch = text[k];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return k;
    if (ch === "<") return -1;
  }
  return -1;
}

function findMatchingClose(text: string, start: number, n: number, name: string, masked: Uint8Array): number {
  const lname = name.toLowerCase();
  let depth = 1;
  let k = start;
  while (k < n) {
    if (masked[k] || text[k] !== "<") {
      k += 1;
      continue;
    }
    let m = k + 1;
    let isClose = false;
    if (text[m] === "/") {
      isClose = true;
      m += 1;
    }
    TAG_NAME.lastIndex = m;
    const nm = TAG_NAME.exec(text);
    if (!nm) {
      k += 1;
      continue;
    }
    const gt = findTagEnd(text, TAG_NAME.lastIndex, n);
    if (gt < 0) {
      k += 1;
      continue;
    }
    if (nm[0].toLowerCase() === lname) {
      if (isClose) {
        depth -= 1;
        if (depth === 0) return gt + 1;
      } else if (text[gt - 1] !== "/") {
        depth += 1;
      }
    }
    k = gt + 1;
  }
  return -1;
}

function maskTagAt(text: string, i: number, n: number, masked: Uint8Array): number {
  if (text.startsWith("<!--", i)) {
    const end = text.indexOf("-->", i + 4);
    const stop = end < 0 ? n : end + 3;
    for (let p = i; p < stop; p += 1) masked[p] = 1;
    return stop;
  }
  let j = i + 1;
  let closing = false;
  if (text[j] === "/") {
    closing = true;
    j += 1;
  }
  TAG_NAME.lastIndex = j;
  const nm = TAG_NAME.exec(text);
  if (!nm) return i;
  const gt = findTagEnd(text, TAG_NAME.lastIndex, n);
  if (gt < 0) return i;
  const tagEnd = gt + 1;
  const selfClosing = text[gt - 1] === "/";
  for (let p = i; p < tagEnd; p += 1) masked[p] = 1;
  if (closing || selfClosing) return tagEnd;
  const close = findMatchingClose(text, tagEnd, n, nm[0], masked);
  if (close < 0) return tagEnd;
  for (let p = tagEnd; p < close; p += 1) masked[p] = 1;
  return close;
}

/** Length-preserving mask: non-prose regions become spaces (newlines kept). */
export function maskNonProse(text: string): string {
  if (!text.includes("`") && !text.includes("<") && !text.includes("~~~")) {
    return text;
  }
  const n = text.length;
  const masked = new Uint8Array(n);

  let fenceChar = "";
  let fenceLen = 0;
  let lineStart = 0;
  while (lineStart <= n) {
    let nl = text.indexOf("\n", lineStart);
    if (nl < 0) nl = n;
    const line = text.slice(lineStart, nl);
    const open = FENCE.exec(line);
    if (fenceChar) {
      for (let p = lineStart; p < nl; p += 1) masked[p] = 1;
      if (
        open &&
        open[2]![0] === fenceChar &&
        open[2]!.length >= fenceLen &&
        line.slice(open[1]!.length + open[2]!.length).trim() === ""
      ) {
        fenceChar = "";
        fenceLen = 0;
      }
    } else if (open) {
      const marker = open[2]!;
      const ch = marker[0]!;
      if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
        fenceChar = ch;
        fenceLen = marker.length;
        for (let p = lineStart; p < nl; p += 1) masked[p] = 1;
      }
    }
    if (nl === n) break;
    lineStart = nl + 1;
  }

  let i = 0;
  while (i < n) {
    if (masked[i]) {
      i += 1;
      continue;
    }
    const c = text[i];
    if (c === "`") {
      const runEnd = backtickRunEnd(text, i, n);
      const close = findBacktickClose(text, runEnd, n, runEnd - i, masked);
      if (close >= 0) {
        for (let p = i; p < close; p += 1) masked[p] = 1;
        i = close;
      } else {
        i = runEnd;
      }
      continue;
    }
    if (c === "<") {
      const end = maskTagAt(text, i, n, masked);
      i = end > i ? end : i + 1;
      continue;
    }
    i += 1;
  }

  const arr = text.split("");
  for (let p = 0; p < n; p += 1) {
    if (masked[p] && arr[p] !== "\n") arr[p] = " ";
  }
  return arr.join("");
}

export function keywordInProse(text: string, word: RegExp): boolean {
  if (!word.test(text)) return false;
  return word.test(maskNonProse(text));
}

export function containsMagicKeyword(text: string, keyword: MagicKeywordId): boolean {
  return keywordInProse(text, magicKeywordRegex(keyword));
}

/** Cheap gate: substring probe then prose-aware check. */
export function hasMagicKeyword(text: string): boolean {
  if (!text.includes("ultrathink") && !text.includes("orchestrate") && !text.includes("workflowz")) {
    return false;
  }
  return MAGIC_KEYWORDS.some((keyword) => containsMagicKeyword(text, keyword));
}

/** All prose matches, sorted by start; overlapping later keywords skipped. */
export function findMagicKeywordMatches(text: string): MagicKeywordMatch[] {
  if (!text.includes("ultrathink") && !text.includes("orchestrate") && !text.includes("workflowz")) {
    return [];
  }
  const masked = maskNonProse(text);
  const found: MagicKeywordMatch[] = [];
  for (const keyword of MAGIC_KEYWORDS) {
    if (!PROBES[keyword].test(text)) continue;
    for (const match of masked.matchAll(HIGHLIGHTS[keyword])) {
      const start = match.index ?? 0;
      found.push({ start, end: start + match[0].length, keyword });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.start - (a.end - a.start));
  const out: MagicKeywordMatch[] = [];
  let cursor = 0;
  for (const m of found) {
    if (m.start < cursor) continue;
    out.push(m);
    cursor = m.end;
  }
  return out;
}
