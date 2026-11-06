import type { GitCommitChangeRecord, GitLogCommitRecord } from "@omp-studio/client-contract";

export interface GitCommitReferenceSnapshot {
  readonly kind: "commit";
  readonly key: string;
  readonly oid: string;
  readonly title: string;
  readonly text: string;
}

/** A local commit remains useful even when the repository has no remote. */
export function gitCommitReferenceSnapshot(input: {
  commit: GitLogCommitRecord;
  files: readonly GitCommitChangeRecord[];
  repositoryKey: string;
  workspaceName: string;
}): GitCommitReferenceSnapshot {
  const { commit, files, repositoryKey, workspaceName } = input;
  const lines = [
    `# Git commit ${commit.oid}: ${commit.subject}`,
    `Workspace: ${workspaceName}`,
    `Author: ${commit.authorName}`,
    `Date: ${commit.authorDate}`,
    ...(commit.parents.length ? [`Parents: ${commit.parents.join(", ")}`] : []),
    `## Changed files (${files.length})`,
    ...files.map(file => `- ${file.status}: ${file.originalPath ? `${file.originalPath} → ` : ""}${file.path}`),
  ];
  return { kind: "commit", key: `git-commit:${JSON.stringify([repositoryKey, commit.oid])}`, oid: commit.oid, title: commit.subject, text: lines.join("\n\n") };
}

export function serializeGitCommitReference(reference: GitCommitReferenceSnapshot): string {
  const { text, ...metadata } = reference;
  return `<git-commit-reference metadata=${JSON.stringify(metadata)} length=${text.length}>\n${text}\n</git-commit-reference>`;
}

export function nextGitCommitReference(text: string, from: number): { start: number; end: number; reference: GitCommitReferenceSnapshot } | null {
  const pattern = /<git-commit-reference metadata=(\{[^\n]*\}) length=(\d+)>\n/g;
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const bodyStart = pattern.lastIndex;
    const bodyEnd = bodyStart + Number(match[2]);
    const closing = "\n</git-commit-reference>";
    if (text.slice(bodyEnd, bodyEnd + closing.length) !== closing) continue;
    try {
      const metadata = JSON.parse(match[1]!) as Omit<GitCommitReferenceSnapshot, "text">;
      if (metadata.kind !== "commit" || typeof metadata.key !== "string" || typeof metadata.oid !== "string" || typeof metadata.title !== "string") continue;
      return { start: match.index, end: bodyEnd + closing.length, reference: { ...metadata, text: text.slice(bodyStart, bodyEnd) } };
    } catch { /* Ordinary pasted text is left untouched. */ }
  }
  return null;
}

export function gitCommitReferenceLabel(reference: GitCommitReferenceSnapshot): string {
  return `Commit ${reference.oid.slice(0, 7)} ${reference.title}`;
}
