import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientInteraction, InteractionResponseValue, StudioClient } from "@omp-studio/client-contract";
import { InteractionDeck } from "../InteractionDeck";
import { useI18n } from "../i18n";
import { interactionDeckDisabled } from "./interactionGate";
import { respondToInteraction } from "./interactionResponse";
import "./secondaryInteractions.css";

/** The native approval host is shared by workspaces; its card must remain answerable off the conversation route. */
export function SecondaryInteractionDeck({ client, interaction, runtimeConnected, resyncRequired, preview }: {
  client: StudioClient; interaction: ClientInteraction | null; runtimeConnected: boolean; resyncRequired: boolean; preview: boolean;
}) {
  const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [busy, setBusy] = useState(false); const current = useRef(interaction);
  current.current = interaction;
  const readForm = useCallback(async (target: Extract<ClientInteraction, { kind: "form" }>) => {
    const result = await client.query("interaction.form.read", { sessionId: target.sessionId, interactionId: target.interactionId, leaseGeneration: target.leaseGeneration });
    return result.form;
  }, [client]);
  const refresh = useCallback(() => client.bootstrap(), [client]);
  useEffect(() => { setBusy(false); }, [interaction?.interactionId, interaction?.leaseGeneration]);
  if (!interaction || preview) return null;
  const respond = async (decision: "submit" | "cancel", value?: InteractionResponseValue): Promise<boolean> => {
    const target = interaction; if (busy || current.current?.interactionId !== target.interactionId || current.current?.leaseGeneration !== target.leaseGeneration || current.current?.sessionId !== target.sessionId) return false;
    setBusy(true);
    try {
      return await respondToInteraction(client, target, decision, value);
    }
    finally { if (current.current?.interactionId === target.interactionId) setBusy(false); }
  };
  return <div className="secondary-interactions" role="dialog" aria-label={zh ? "待处理的审批与提问" : "Pending approval or question"}>
    <InteractionDeck interaction={interaction} readForm={readForm} onRespond={respond} onRefresh={refresh} disabled={busy || interactionDeckDisabled({ runtimeConnected, resyncRequired })} />
  </div>;
}
