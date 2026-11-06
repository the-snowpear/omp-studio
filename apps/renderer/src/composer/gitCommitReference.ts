import { referenceCodec } from "./referenceCodec";
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

export const { serialize: serializeGitCommitReference, next: nextGitCommitReference } = referenceCodec<GitCommitReferenceSnapshot>(
  "git-commit-reference",
  metadata => metadata.kind === "commit" && typeof metadata.key === "string" && typeof metadata.oid === "string" && typeof metadata.title === "string",
);

export function gitCommitReferenceLabel(reference: GitCommitReferenceSnapshot): string {
  return `Commit ${reference.oid.slice(0, 7)} ${reference.title}`;
}
