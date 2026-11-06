import { referenceCodec } from "./referenceCodec";
import type { GitHubReference } from "@omp-studio/client-contract";

export interface GitHubReferenceSnapshot {
  readonly key: string;
  readonly kind: "issue" | "pr";
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly updatedAt: string;
  readonly headOid?: string;
  readonly text: string;
}

export function githubReferenceSnapshot(reference: GitHubReference): GitHubReferenceSnapshot {
  const { repository, item, capturedAt, comments, checks, diffs } = reference;
  const lines = [
    `# ${item.kind === "pr" ? "PR" : "Issue"} #${item.number}: ${item.title}`,
    `Source: ${item.url}`, `Repository: ${repository.host}/${repository.ownerRepo}`,
    `Updated: ${item.updatedAt} · Captured: ${capturedAt}`, `State: ${item.state}`,
  ];
  if (item.kind === "pr") lines.push(`Branch: ${item.headBranch} → ${item.baseBranch}`, `Head commit: ${item.headOid}`,
    `Files: ${item.changedFiles} · +${item.additions} −${item.deletions}`, `Review: ${item.reviewDecision || "—"}`,
    "## Checks", ...checks.map(check => `- ${check.name}: ${check.state}`));
  lines.push("## Description", item.body, `## Loaded discussion (${comments.length})`);
  for (const comment of comments) lines.push(
    `### ${comment.author} · ${comment.createdAt}${comment.state ? ` · ${comment.state}` : ""}`,
    comment.url, ...(comment.path ? [`File: ${comment.path}${comment.line ? `:${comment.line}` : ""}`] : []), comment.body,
  );
  for (const diff of diffs) {
    const fence = "`".repeat(Math.max(3, ...[...diff.patch.matchAll(/`+/g)].map(match => match[0].length + 1)));
    lines.push(`## Diff: ${diff.path}`, `${fence}diff\n${diff.patch}\n${fence}`);
  }
  return { key: `${repository.host}/${repository.ownerRepo}/${item.kind}/${item.number}`.toLowerCase(), kind: item.kind,
    number: item.number, title: item.title, url: item.url, updatedAt: item.updatedAt,
    ...(item.headOid ? { headOid: item.headOid } : {}), text: lines.join("\n\n") };
}

export const { serialize: serializeGithubReference, next: nextGithubReference } = referenceCodec<GitHubReferenceSnapshot>(
  "github-reference",
  metadata => typeof metadata.key === "string" && typeof metadata.title === "string" && typeof metadata.url === "string" && ["issue", "pr"].includes(metadata.kind),
);
