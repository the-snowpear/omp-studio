import type { JsonValue } from "@omp-studio/client-contract";

import type { ChangesDiffHunk, ChangesDiffLine } from "./ChangesPanel";
import type { AssistantSegment, ToolView } from "./conversationViewModel";
import { jsonRecord, jsonString } from "./conversationViewModel";
import { toolFields, toolKind } from "./toolMeta";

type FileEditKind = "write" | "edit" | "ast_edit";
type DiffMark = "+" | "-" | " ";
type DiffBlock = { readonly kind: FileEditKind; readonly lines: readonly ChangesDiffLine[]; readonly truncated?: boolean };

export type SessionFileDiff = {
  readonly hunks: readonly ChangesDiffHunk[];
  readonly truncated?: boolean;
};

const PATCH_LINE_CAP = 500;
const BLOCK_LABEL: Readonly<Record<FileEditKind, string>> = {
  write: "Write",
  edit: "Edit",
  ast_edit: "AST Edit",
};

function editKind(tool: ToolView): FileEditKind | undefined {
  const kind = toolKind(tool);
  return kind === "write" || kind === "edit" || kind === "ast_edit" ? kind : undefined;
}

function normalizedPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const normalized = path.replaceAll("\\", "/").trim();
  if (normalized.length === 0 || normalized.includes(" → ") || normalized.toLowerCase().startsWith("xd://")) return undefined;
  return normalized;
}

function toolPath(tool: ToolView): string | undefined {
  const fields = toolFields(tool);
  return normalizedPath(jsonString(fields.path) ?? jsonString(fields.resolvedPath) ?? jsonString(fields.target));
}

function markOf(value: unknown): DiffMark {
  return value === "+" || value === "-" ? value : " ";
}

function diffLine(mark: DiffMark, oldLn: string, newLn: string, text: string): ChangesDiffLine {
  return { kind: "row", mark, oldLn: mark === "+" ? "" : oldLn, newLn: mark === "-" ? "" : newLn, text };
}

function editLines(diff: JsonValue | undefined): ChangesDiffLine[] {
  const lines: ChangesDiffLine[] = [];
  if (Array.isArray(diff)) {
    for (const row of diff) {
      if (!Array.isArray(row)) continue;
      lines.push(diffLine(markOf(row[0]), String(row[1] ?? ""), String(row[2] ?? ""), String(row[3] ?? "")));
    }
    return lines;
  }
  if (typeof diff !== "string" || diff.length === 0) return lines;
  for (const line of diff.split("\n")) {
    const match = /^([ +\-])(\d*)\|(.*)$/u.exec(line);
    if (match === null) lines.push(diffLine(" ", "", "", line));
    else lines.push(diffLine(markOf(match[1]), match[2] ?? "", match[2] ?? "", match[3] ?? ""));
  }
  return lines;
}

const GROUPED_HEADER_RE = /^(#+)\s+(.*)$/u;
const GROUPED_HEADER_SUFFIX_RE = /\s+\([^)]*\)\s*$/u;
const GROUPED_HEADER_HASH_TAG_RE = /#[0-9a-f]+$/iu;
const GROUPED_BODY_RE = /^([ +\-])(\d*)│(.*)$/u;

function astEditDisplayDiffs(display: string): Map<string, ChangesDiffLine[]> {
  const byFile = new Map<string, ChangesDiffLine[]>();
  const dirAtDepth = new Map<number, string>();
  let current: ChangesDiffLine[] | undefined;
  for (const line of display.split("\n")) {
    const header = GROUPED_HEADER_RE.exec(line);
    if (header === null) {
      const body = GROUPED_BODY_RE.exec(line);
      if (body !== null && current !== undefined) {
        current.push(diffLine(markOf(body[1]), body[2] ?? "", body[2] ?? "", body[3] ?? ""));
      }
      continue;
    }
    const depth = header[1]!.length;
    const rest = header[2]!.trimEnd().replace(GROUPED_HEADER_SUFFIX_RE, "");
    for (const level of [...dirAtDepth.keys()]) if (level >= depth) dirAtDepth.delete(level);
    const parent = depth > 1 ? dirAtDepth.get(depth - 1) : undefined;
    const joined = (name: string) => parent === undefined ? name : `${parent}/${name}`;
    current = undefined;
    if (rest.endsWith("/")) {
      const name = rest.slice(0, -1);
      if (name.length > 0) dirAtDepth.set(depth, joined(name));
      continue;
    }
    const path = normalizedPath(joined(rest.replace(GROUPED_HEADER_HASH_TAG_RE, "")));
    if (path === undefined) continue;
    current = byFile.get(path) ?? [];
    byFile.set(path, current);
  }
  return byFile;
}

function contentLines(content: JsonValue | undefined): string[] | undefined {
  if (typeof content === "string") return content.length === 0 ? [] : content.split("\n");
  if (!Array.isArray(content)) return undefined;
  return content.map((entry) => typeof entry === "string" ? entry : String(entry ?? ""));
}

function addBlock(files: Map<string, DiffBlock[]>, path: string | undefined, block: DiffBlock): void {
  const normalized = normalizedPath(path);
  if (normalized === undefined || block.lines.length === 0) return;
  const blocks = files.get(normalized);
  if (blocks === undefined) files.set(normalized, [block]);
  else blocks.push(block);
}

function addAstEdit(files: Map<string, DiffBlock[]>, tool: ToolView): void {
  const fields = toolFields(tool);
  if (Array.isArray(fields.changes)) {
    const byFile = new Map<string, ChangesDiffLine[]>();
    for (const entry of fields.changes) {
      const record = jsonRecord(entry);
      const path = normalizedPath(jsonString(record?.file));
      if (path === undefined) continue;
      const lines = byFile.get(path) ?? [];
      const before = jsonString(record?.before);
      const after = jsonString(record?.after);
      if (before !== undefined) for (const line of before.split("\n")) lines.push(diffLine("-", "", "", line));
      if (after !== undefined) for (const line of after.split("\n")) lines.push(diffLine("+", "", "", line));
      byFile.set(path, lines);
    }
    for (const [path, lines] of byFile) addBlock(files, path, { kind: "ast_edit", lines, ...(tool.truncated ? { truncated: true } : {}) });
    return;
  }
  const display = jsonString(fields.displayContent);
  if (display === undefined) return;
  for (const [path, lines] of astEditDisplayDiffs(display)) {
    addBlock(files, path, { kind: "ast_edit", lines, ...(tool.truncated ? { truncated: true } : {}) });
  }
}

export function sessionFileDiffs(segments: readonly AssistantSegment[]): ReadonlyMap<string, SessionFileDiff> {
  const files = new Map<string, DiffBlock[]>();
  for (const segment of segments) {
    if (segment.type !== "batch") continue;
    for (const tool of segment.tools) {
      if (tool.status !== "succeeded") continue;
      const kind = editKind(tool);
      if (kind === undefined) continue;
      if (kind === "ast_edit") {
        addAstEdit(files, tool);
        continue;
      }
      const fields = toolFields(tool);
      const path = toolPath(tool);
      if (kind === "edit") {
        addBlock(files, path, { kind, lines: editLines(fields.diff), ...(tool.truncated ? { truncated: true } : {}) });
        continue;
      }
      const raw = contentLines(fields.content);
      if (raw === undefined) continue;
      const truncated = tool.truncated === true || raw.length > PATCH_LINE_CAP;
      addBlock(files, path, {
        kind,
        lines: raw.slice(0, PATCH_LINE_CAP).map((line, index) => diffLine("+", "", String(index + 1), line)),
        ...(truncated ? { truncated: true } : {}),
      });
    }
  }

  const result = new Map<string, SessionFileDiff>();
  for (const [path, blocks] of files) {
    result.set(path, {
      hunks: blocks.map((block, index) => ({
        hunkLabel: `@@ ${BLOCK_LABEL[block.kind]} · ${index + 1}/${blocks.length} @@`,
        lines: block.lines,
      })),
      ...(blocks.some((block) => block.truncated === true) ? { truncated: true } : {}),
    });
  }
  return result;
}
