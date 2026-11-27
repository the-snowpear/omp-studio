import type { ClientInteraction, InteractionResponseValue, StudioClient } from "@omp-studio/client-contract";
import { waitReceipt } from "../hostError";

/** Keep the Host error intact so the pending card can explain a failed response. */
export async function respondToInteraction(
  client: StudioClient,
  interaction: ClientInteraction,
  decision: "submit" | "cancel",
  value?: InteractionResponseValue,
): Promise<boolean> {
  const handle = await client.command("interaction.respond", {
    interactionId: interaction.interactionId,
    leaseGeneration: interaction.leaseGeneration,
    decision,
    ...(value === undefined ? {} : { value }),
  });
  await waitReceipt(client, handle.requestId);
  return true;
}
