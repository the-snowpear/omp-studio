import type {
  GitHubTarget, GitHubRepository, GitHubListInput, GitHubItemInput, GitHubItem,
  GitHubItemPage, GitHubItemDetail, GitHubDiscussionPage, GitHubComment,
  GitHubFilesPage, GitHubFileDiff, GitHubCheckRecord,
} from "@omp-studio/client-contract";

export type GithubReadRepository = GitHubRepository & { readonly cwd: string };
type JsonRead = <T>(repo: GithubReadRepository, args: readonly string[]) => Promise<T>;
const COMMON = "number title body url state author { login } updatedAt labels(first:100) { nodes { name } } comments { totalCount }";
const PR = "isDraft headRefName baseRefName headRefOid reviewDecision additions deletions changedFiles commits(last:1) { nodes { commit { statusCheckRollup { state } } } }";
interface WireItem {
  __typename?: string; number: number; title: string; body: string; url: string; state: string;
  author: { login: string } | null; updatedAt: string; labels: { nodes: { name: string }[] }; comments: { totalCount: number };
  isDraft?: boolean; headRefName?: string; baseRefName?: string; headRefOid?: string; reviewDecision?: string;
  additions?: number; deletions?: number; changedFiles?: number;
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}
function item(row: WireItem, kind: "issue" | "pr"): GitHubItem {
  return {
    kind, number: row.number, title: row.title, body: row.body, url: row.url,
    state: row.state.toLowerCase() as GitHubItem["state"], author: row.author?.login ?? "",
    updatedAt: row.updatedAt, labels: row.labels.nodes.map(label => label.name), commentCount: row.comments.totalCount,
    ...(kind === "pr" ? { draft: row.isDraft ?? false, headBranch: row.headRefName ?? "", baseBranch: row.baseRefName ?? "", headOid: row.headRefOid ?? "",
      reviewDecision: row.reviewDecision ?? "", checkState: row.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? "",
      additions: row.additions ?? 0, deletions: row.deletions ?? 0, changedFiles: row.changedFiles ?? 0 } : {}),
  };
}
function identity(repo: GithubReadRepository): GitHubRepository {
  return { remote: repo.remote, host: repo.host, ownerRepo: repo.ownerRepo, url: repo.url };
}
interface WireComment { id: number; user: { login: string } | null; body: string; created_at?: string; submitted_at?: string; html_url: string; state?: string; path?: string; line?: number; original_line?: number }
interface WireFile { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }

/** GitHub-owned JSON is mapped once here. Desktop transport only checks envelopes. */
export class GithubReads {
  constructor(
    private readonly repository: (input: GitHubTarget) => Promise<GithubReadRepository>,
    private readonly json: JsonRead,
    private readonly checks: (input: GitHubTarget & { number: number }) => Promise<readonly GitHubCheckRecord[]>,
  ) {}

  async items(input: GitHubListInput): Promise<GitHubItemPage> {
    const repo = await this.repository(input);
    // Keep user search in its own term; repository/type are always fixed by the selected remote.
    const search = (input.search ?? "").replace(/\b(?:repo|org|user|is|type|sort):\S+/giu, "").trim();
    const terms = [`repo:${repo.ownerRepo}`, `is:${input.kind}`, "sort:updated-desc", search];
    if (input.state !== "all") terms.push(input.state === "merged" ? "is:merged" : `is:${input.state ?? "open"}`);
    if (input.state === "closed" && input.kind === "pr") terms.push("is:unmerged");
    if (input.label) terms.push(`label:${JSON.stringify(input.label)}`);
    if (input.assignedToMe) terms.push("assignee:@me");
    if (input.reviewRequested && input.kind === "pr") terms.push("review-requested:@me");
    const query = `query($q:String!,$cursor:String) { search(query:$q,type:ISSUE,first:50,after:$cursor) { issueCount pageInfo { hasNextPage endCursor } nodes { ... on Issue { ${COMMON} } ... on PullRequest { ${COMMON} ${PR} } } } }`;
    const result = await this.json<{ data: { search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: WireItem[] } } }>(repo,
      ["graphql", "-f", `query=${query}`, "-f", `q=${terms.filter(Boolean).join(" ")}`, ...(input.cursor ? ["-f", `cursor=${input.cursor}`] : [])]);
    const page = result.data.search;
    return { repository: identity(repo), items: page.nodes.map(row => item(row, input.kind)), totalCount: page.issueCount,
      ...(page.pageInfo.hasNextPage ? { nextCursor: page.pageInfo.endCursor } : {}) };
  }

  async item(input: GitHubItemInput): Promise<GitHubItemDetail> {
    const repo = await this.repository(input);
    const [owner, name] = repo.ownerRepo.split("/");
    const query = `query($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { item:${input.kind === "pr" ? "pullRequest" : "issue"}(number:$number) { ${COMMON} ${input.kind === "pr" ? PR : ""} } } }`;
    const result = await this.json<{ data: { repository: { item: WireItem | null } } }>(repo,
      ["graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${input.number}`]);
    if (!result.data.repository.item) throw new Error("GitHub item was not found");
    return { repository: identity(repo), item: item(result.data.repository.item, input.kind), checks: input.kind === "pr" ? await this.checks(input) : [] };
  }

  async discussion(input: GitHubItemInput & { page?: number }): Promise<GitHubDiscussionPage> {
    const repo = await this.repository(input);
    const page = input.page ?? 1;
    const endpoints: [GitHubComment["kind"], string][] = [["comment", `issues/${input.number}/comments`]];
    if (input.kind === "pr") endpoints.push(["review", `pulls/${input.number}/reviews`], ["inline", `pulls/${input.number}/comments`]);
    const groups = await Promise.all(endpoints.map(async ([kind, endpoint]) => {
      const rows = await this.json<WireComment[]>(repo, [`repos/${repo.ownerRepo}/${endpoint}?per_page=50&page=${page}`]);
      return { more: rows.length === 50, comments: rows.map(row => ({
        id: `${kind}:${row.id}`, kind, author: row.user?.login ?? "", body: row.body ?? "", createdAt: row.created_at ?? row.submitted_at ?? "", url: row.html_url,
        ...(row.state ? { state: row.state } : {}), ...(row.path ? { path: row.path } : {}),
        ...(row.line ?? row.original_line ? { line: (row.line ?? row.original_line)! } : {}),
      })) };
    }));
    return { comments: groups.flatMap(group => group.comments).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      ...(groups.some(group => group.more) ? { nextPage: page + 1 } : {}) };
  }

  private async assertHead(repo: GithubReadRepository, number: number, expected: string): Promise<string> {
    const current = await this.json<{ head: { sha: string } }>(repo, [`repos/${repo.ownerRepo}/pulls/${number}`]);
    if (current.head.sha !== expected) throw new Error("PR_HEAD_CHANGED");
    return current.head.sha;
  }

  async files(input: GitHubTarget & { number: number; page?: number; headOid: string }): Promise<GitHubFilesPage> {
    const repo = await this.repository(input);
    const page = input.page ?? 1;
    const rows = await this.json<WireFile[]>(repo, [`repos/${repo.ownerRepo}/pulls/${input.number}/files?per_page=50&page=${page}`]);
    const headOid = await this.assertHead(repo, input.number, input.headOid);
    return { headOid, files: rows.map(row => ({ path: row.filename, status: row.status, additions: row.additions, deletions: row.deletions,
      ...(row.previous_filename ? { previousPath: row.previous_filename } : {}) })), ...(rows.length === 50 ? { nextPage: page + 1 } : {}) };
  }

  async fileDiff(input: GitHubTarget & { number: number; path: string; headOid: string }): Promise<GitHubFileDiff> {
    const repo = await this.repository(input);
    let found: WireFile | undefined;
    for (let page = 1; ; page++) {
      const rows = await this.json<WireFile[]>(repo, [`repos/${repo.ownerRepo}/pulls/${input.number}/files?per_page=100&page=${page}`]);
      found = rows.find(row => row.filename === input.path);
      if (found || rows.length < 100) break;
    }
    const headOid = await this.assertHead(repo, input.number, input.headOid);
    return { path: input.path, headOid, patch: found?.patch ?? "", ...(!found?.patch ? { unavailableReason: "GitHub did not provide a text patch for this file. Open it on GitHub." } : {}) };
  }
}
