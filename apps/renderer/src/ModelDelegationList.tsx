import { useEffect, useState } from "react";
import type { StudioClient, ModelMentionInfo } from "@omp-studio/client-contract";
import { invokeUpgrade } from "./runtimeUpgrade";
import { useI18n } from "./i18n";
import { PREVIEW_MODEL_MENTIONS } from "./preview/runtimeUpgradeFixtures";
/** Definitions authorized for delegation; these are not running-agent rows. */
export function ModelDelegationList({ client, preview, sessionId }: { client: StudioClient | null; preview: boolean; sessionId?: string }) {
 const { t } = useI18n();
 const [mentions, setMentions] = useState<readonly ModelMentionInfo[]>([]);
 useEffect(() => {
  let gone = false, refreshing = false, queued = false, connected = true, resyncing = false;
  let generation = 0;
  setMentions(preview ? PREVIEW_MODEL_MENTIONS : []);
  if (preview || !client || !sessionId) return;
  const refresh = async () => {
   if (gone || !connected) return;
   generation++;
   if (refreshing) { queued = true; return; }
   refreshing = true;
   try {
    do {
     queued = false;
     const current = generation;
     try {
      const result = await invokeUpgrade(client, "session.models.mentions", {});
      if (!gone && connected && current === generation && result.sessionId === sessionId) setMentions(result.mentions);
     } catch { /* Older Runtimes do not expose model delegation. */ }
    } while (queued && !gone && connected);
   } finally { refreshing = false; }
  };
  const unsubscribe = client.subscribe({ scope: "all" }, event => {
   if (event.kind === "runtime.changed") {
    generation++;
    connected = event.connection.status === "connected";
    if (connected) { resyncing = false; void refresh(); }
    else { queued = false; setMentions([]); }
   } else if (event.kind === "resync.required") {
    generation++; connected = false; queued = false; resyncing = true; setMentions([]);
   } else if (event.kind === "snapshot" && resyncing) {
    connected = true; resyncing = false; void refresh();
   } else if (event.kind === "conversation.changed" && event.sessionId === sessionId
     && event.update.kind === "conversation.message.completed" && event.update.item.role === "user") {
    void refresh();
   } else if (event.kind === "command.receipt" && event.receipt.status === "completed"
     && ["session.tree.navigate", "session.tree.branch", "session.clearContext"].includes(event.receipt.commandName)) {
    void refresh();
   }
  });
  void refresh();
  return () => { gone = true; unsubscribe(); };
 }, [client, preview, sessionId]);
 if (!mentions.length) return null;
 return <section className="model-delegation-list" aria-label={t("runtimeUpgrade.delegation")}><span className="small muted">{t("runtimeUpgrade.delegation")}</span>{mentions.map(mention => <span className="chip gray" key={mention.agent} data-tip={mention.selector}>{mention.agent} · {mention.name}</span>)}{preview ? <span className="chip gray xs">{t("common.demo")}</span> : null}</section>;
}
