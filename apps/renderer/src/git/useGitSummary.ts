import { useEffect, useState } from "react";
import type { QueryResult, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { hostErrorMessage } from "../hostError";

/** The breadcrumb never needs file revisions, diffs or untracked line counts. */
export function useGitSummary(client: StudioClient, workspaceId?: WorkspaceId) {
  const [value, setValue] = useState<{ workspaceId: WorkspaceId; repository: QueryResult<"git.repository.summary"> }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!workspaceId) return;
    let active = true, generation = 0;
    const read = () => {
      const token = ++generation;
      void client.query("git.repository.summary", { workspaceId }).then(repository => {
        if (active && token === generation) setValue({ workspaceId, repository });
      }).catch(cause => { if (active && token === generation) setError(hostErrorMessage(cause, "无法读取 Git 摘要")); });
    };
    read();
    const off = client.subscribe({ scope: "all" }, event => {
      if (event.kind === "git.repository.changed" && event.repository.workspaceId === workspaceId) read();
    });
    return () => { active = false; off(); };
  }, [client, workspaceId]);
  return { repository: value?.workspaceId === workspaceId ? value?.repository : undefined, error };
}
