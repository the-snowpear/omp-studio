import type { ClientInteraction } from "@omp-studio/client-contract";
import { MOTION_MS, MOTION_SLACK_MS } from "../motion";

/** `.deck.is-ask-enter`：Ask 卡从输入框上沿变形浮入（--dur-hero）。 */
export const ASK_GENIE_MS = MOTION_MS.hero;
/** `.deck.is-ask-leave`：收回（--dur-slow）；等它播完再卸载。 */
export const ASK_GENIE_LEAVE_MS = MOTION_MS.slow;
export const ASK_GENIE_HOLD_MS = ASK_GENIE_LEAVE_MS + MOTION_SLACK_MS;

export function isAskDeckInteraction(
  interaction: Pick<ClientInteraction, "kind"> | null | undefined,
): boolean {
  if (interaction == null) return false;
  return interaction.kind === "ask"
    || interaction.kind === "form"
    || interaction.kind === "select"
    || interaction.kind === "input"
    || interaction.kind === "editor";
}
