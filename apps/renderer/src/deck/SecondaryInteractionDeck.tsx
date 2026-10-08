import { useEffect, useRef, useState } from "react";
import type { ClientInteraction, InteractionResponseValue, StudioClient } from "@omp-studio/client-contract";
import { InteractionDeck } from "../InteractionDeck";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { useI18n } from "../i18n";
import { interactionDeckDisabled } from "./interactionGate";
import "./secondaryInteractions.css";

/** The native approval host is shared by workspaces; its card must remain answerable off the conversation route. */
export function SecondaryInteractionDeck({ client, interaction, runtimeConnected, resyncRequired, preview }: {
  client: StudioClient; interaction: ClientInteraction | null; runtimeConnected: boolean; resyncRequired: boolean; preview: boolean;
}) {
  const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const current = useRef(interaction);
  current.current = interaction;
  useEffect(() => { setError(""); setBusy(false); }, [interaction?.interactionId, interaction?.leaseGeneration]);
  if (!interaction || preview) return null;
  const respond = async (decision: "submit" | "cancel", value?: InteractionResponseValue): Promise<boolean> => {
    const target = interaction; if (busy || current.current !== target) return false;
    setBusy(true); setError("");
    try {
      const handle = await client.command("interaction.respond", { interactionId: target.interactionId, leaseGeneration: target.leaseGeneration, decision, ...(value === undefined ? {} : { value }) });
      await waitReceipt(client, handle.requestId); return true;
    } catch (cause) { if (current.current?.interactionId === target.interactionId) setError(hostErrorMessage(cause, zh ? "响应失败，请检查连接后重试。" : "Response failed. Check the connection and retry.")); return false; }
    finally { if (current.current?.interactionId === target.interactionId) setBusy(false); }
  };
  return <div className="secondary-interactions" role="dialog" aria-label={zh ? "待处理的审批与提问" : "Pending approval or question"}>
    <InteractionDeck interaction={interaction} onRespond={respond} disabled={busy || interactionDeckDisabled({ runtimeConnected, resyncRequired })} />
    {error ? <p role="alert" className="session-options-error">{error}</p> : null}
  </div>;
}
