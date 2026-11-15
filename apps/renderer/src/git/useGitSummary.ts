import { useEffect, useRef, useState } from "react";
import type { QueryResult, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { hostErrorMessage } from "../hostError";
import { useI18n } from "../i18n";

/** The breadcrumb never needs file revisions, diffs or untracked line counts. */
export function useGitSummary(client: StudioClient, workspaceId?: WorkspaceId) {
  const { resolvedLanguage } = useI18n();
  const zhRef = useRef(resolvedLanguage === "zh");
  zhRef.current = resolvedLanguage === "zh";
  const [value, setValue] = useState<{ client: StudioClient; workspaceId: WorkspaceId; repository?: QueryResult<"git.repository.summary">; error?: string }>();
  useEffect(() => {
    if (!workspaceId) return;
    let active = true, generation = 0;
    const read = () => {
      const token = ++generation;
      void client.query("git.repository.summary", { workspaceId }).then(repository => {
        if (active && token === generation) setValue({ client, workspaceId, repository });
      }).catch(cause => { if (active && token === generation) setValue({ client, workspaceId, error: hostErrorMessage(cause, zhRef.current ? "无法读取 Git 摘要" : "Cannot read Git summary") }); });
    };
    read();
    const off = client.subscribe({ scope: "all" }, event => {
      if (event.kind === "git.repository.changed" && event.repository.workspaceId === workspaceId) read();
    });
    return () => { active = false; off(); };
  }, [client, workspaceId]);
  const current = value?.client === client && value.workspaceId === workspaceId ? value : undefined;
  return { repository: current?.repository, error: current?.error };
}
