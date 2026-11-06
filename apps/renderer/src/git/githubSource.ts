import type { QueryInput, QueryResult, StudioClient } from "@omp-studio/client-contract";

export type GitHubQuery = "github.repositories.list" | "github.auth.get" | "github.items.list" | "github.items.get" | "github.discussion.list" | "github.pr.files" | "github.pr.diff";
export interface GitHubSource {
  query<K extends GitHubQuery>(name: K, input: QueryInput<K>): Promise<QueryResult<K>>;
}
export function githubSource(client: StudioClient): GitHubSource {
  return { query: (name, input) => client.query(name, input) };
}
