/**
 * Split a plan into preamble + one section per ATX heading, matching OMP TUI
 * `plan-toc.ts` so Refine feedback can address the same chunks.
 */

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export type PlanSection = {
  /** `0` = preamble; `1..6` = heading depth. */
  readonly level: number;
  /** Plain-text heading; empty for preamble. */
  readonly title: string;
  /** Exact source slice, including trailing newlines. */
  readonly raw: string;
};

export function stripInlineMarkdown(text: string): string {
  let out = text;
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  out = out.replace(/<([^>\s]+)>/g, "$1");
  out = out.replace(/`([^`]+)`/g, "$1");
  out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
  out = out.replace(/(\*|_)(.+?)\1/g, "$2");
  out = out.replace(/~~(.+?)~~/g, "$1");
  return out.replace(/\s+/g, " ").trim();
}

export function parsePlanSections(text: string): PlanSection[] {
  const lines = text.split("\n");
  const offsets: number[] = new Array(lines.length);
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = cursor;
    cursor += lines[i]!.length + 1;
  }

  const heads: { line: number; level: number; title: string }[] = [];
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE_RE.exec(line);
    if (fenceChar === null) {
      if (fence) {
        fenceChar = fence[1]![0]!;
        fenceLen = fence[1]!.length;
        continue;
      }
    } else {
      if (fence && fence[1]![0] === fenceChar && fence[1]!.length >= fenceLen && fence[2]!.trim() === "") {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      heads.push({ line: i, level: heading[1]!.length, title: stripInlineMarkdown(heading[2]!) });
    }
  }

  const sliceRaw = (startLine: number, endLine: number): string => {
    const startOffset = offsets[startLine]!;
    const endOffset = endLine < lines.length ? offsets[endLine]! : text.length;
    return text.slice(startOffset, endOffset);
  };

  const sections: PlanSection[] = [];
  const firstHeadLine = heads.length > 0 ? heads[0]!.line : lines.length;
  if (firstHeadLine > 0) {
    const raw = sliceRaw(0, firstHeadLine);
    if (raw.length > 0) sections.push({ level: 0, title: "", raw });
  }
  for (let h = 0; h < heads.length; h++) {
    const head = heads[h]!;
    const endLine = h + 1 < heads.length ? heads[h + 1]!.line : lines.length;
    sections.push({ level: head.level, title: head.title, raw: sliceRaw(head.line, endLine) });
  }
  return sections;
}

/** Markdown for a section without its ATX heading line (preamble is unchanged). */
export function sectionBodyMarkdown(section: PlanSection): string {
  if (section.level === 0) return section.raw;
  const newline = section.raw.indexOf("\n");
  return newline === -1 ? "" : section.raw.slice(newline + 1);
}
