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

/** Length framing preserves arbitrary Markdown and nested-looking delimiters without duplicating source text. */
export function serializeGithubReference(reference: GitHubReferenceSnapshot): string {
  const { text, ...metadata } = reference;
  return `<github-reference metadata=${JSON.stringify(metadata)} length=${text.length}>\n${text}\n</github-reference>`;
}

export function nextGithubReference(text: string, from: number): { start: number; end: number; reference: GitHubReferenceSnapshot } | null {
  const pattern = /<github-reference metadata=(\{[^\n]*\}) length=(\d+)>\n/g;
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const bodyStart = pattern.lastIndex;
    const bodyEnd = bodyStart + Number(match[2]);
    const closing = "\n</github-reference>";
    if (text.slice(bodyEnd, bodyEnd + closing.length) !== closing) continue;
    try {
      const metadata = JSON.parse(match[1]!) as Omit<GitHubReferenceSnapshot, "text">;
      if (typeof metadata.key !== "string" || typeof metadata.title !== "string" || typeof metadata.url !== "string" || !["issue", "pr"].includes(metadata.kind)) continue;
      return { start: match.index, end: bodyEnd + closing.length, reference: { ...metadata, text: text.slice(bodyStart, bodyEnd) } };
    } catch { /* Ordinary pasted text is left untouched. */ }
  }
  return null;
}
