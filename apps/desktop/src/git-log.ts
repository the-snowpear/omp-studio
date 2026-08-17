/**
 * Parsers for Host-owned `git log` / `git diff-tree` output.
 * Paths stay repository-relative; decorations become public ref pills.
 */

import type { GitCommitChangeRecord, GitCommitChangeStatus, GitLogCommitRecord, GitLogRef, GitLogRelation } from "@omp-studio/client-contract";

const SUBJECT_LIMIT = 200;
const AUTHOR_LIMIT = 80;
const RECORD_SEPARATOR = "\u001e";

export function sanitizeLogText(value: string, limit: number, fallback: string): string {
  const cleaned = value.replace(/[\0\r\n\u0001-\u0008\u000b\u000c\u000e-\u001f]/gu, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

export function parseLogDecorations(raw: string): GitLogRef[] {
  if (!raw.trim()) return [];
  const refs: GitLogRef[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    if (token.startsWith("tag: ")) {
      refs.push({ name: sanitizeLogText(token.slice(5), 96, "tag"), kind: "tag", current: false });
      continue;
    }
    if (token.startsWith("HEAD -> ")) {
      refs.push({ name: "HEAD", kind: "head", current: true });
      refs.push({ name: sanitizeLogText(token.slice(8), 96, "branch"), kind: "local", current: true });
      continue;
    }
    if (token === "HEAD") {
      refs.push({ name: "HEAD", kind: "head", current: true });
      continue;
    }
    const remote = token.includes("/");
    refs.push({ name: sanitizeLogText(token, 96, remote ? "origin" : "branch"), kind: remote ? "remote" : "local", current: false });
  }
  return refs;
}

export function classifyLogRelation(oid: string, headOid: string | undefined, outgoing: ReadonlySet<string>, incoming: ReadonlySet<string>): GitLogRelation {
  if (headOid !== undefined && oid === headOid) return "head";
  if (outgoing.has(oid)) return "outgoing";
  if (incoming.has(oid)) return "incoming";
  return "common";
}

export function parseLogRecords(
  stdout: string,
  options: {
    readonly headOid?: string;
    readonly outgoing: ReadonlySet<string>;
    readonly incoming: ReadonlySet<string>;
  },
): GitLogCommitRecord[] {
  const commits: GitLogCommitRecord[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    if (!record.trim()) continue;
    const [oid, parentsRaw, decorations, subject, authorName, authorDate] = record.replace(/^\n+/u, "").split("\0");
    if (!oid) continue;
    commits.push({
      oid,
      parents: (parentsRaw ?? "").split(" ").map((parent) => parent.trim()).filter(Boolean),
      subject: sanitizeLogText(subject ?? "", SUBJECT_LIMIT, "(no subject)"),
      authorName: sanitizeLogText(authorName ?? "", AUTHOR_LIMIT, "unknown"),
      authorDate: sanitizeLogText(authorDate ?? "", 64, "1970-01-01T00:00:00Z"),
      refs: parseLogDecorations(decorations ?? ""),
      relation: classifyLogRelation(oid, options.headOid, options.outgoing, options.incoming),
    });
  }
  return commits;
}

function nameStatus(code: string): GitCommitChangeStatus {
  switch (code[0]) {
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    default: return "modified";
  }
}

export function parseNameStatus(stdout: string): GitCommitChangeRecord[] {
  const files: GitCommitChangeRecord[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line) continue;
    const columns = line.split("\t");
    const code = columns[0] ?? "";
    if (columns.length >= 3) {
      const originalPath = columns[1]?.replaceAll("\\", "/");
      const path = columns[2]?.replaceAll("\\", "/");
      if (!path) continue;
      files.push({
        path,
        status: nameStatus(code),
        ...(originalPath ? { originalPath } : {}),
      });
      continue;
    }
    const path = columns[1]?.replaceAll("\\", "/");
    if (!path) continue;
    files.push({ path, status: nameStatus(code) });
  }
  return files;
}

export const LOG_RECORD_SEPARATOR = RECORD_SEPARATOR;
export const LOG_PRETTY_FORMAT = "%H%x00%P%x00%D%x00%s%x00%an%x00%aI%x1e";
