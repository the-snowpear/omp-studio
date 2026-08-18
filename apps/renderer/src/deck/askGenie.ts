import type { ClientInteraction } from "@omp-studio/client-contract";

/** 与 `.sa-inspect` / `.deck.is-ask-enter` 打开时长对齐。收起另见 ASK_GENIE_LEAVE_MS。 */
export const ASK_GENIE_MS = 480;
/** 与 `.deck.is-ask-leave` / `--dur-sa-inspect-leave` 对齐；超时略加缓冲以免末帧被卸掉。 */
export const ASK_GENIE_LEAVE_MS = 260;
export const ASK_GENIE_HOLD_MS = ASK_GENIE_LEAVE_MS + 24;

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isAskDeckInteraction(
  interaction: Pick<ClientInteraction, "kind"> | null | undefined,
): boolean {
  if (interaction == null) return false;
  return interaction.kind === "ask"
    || interaction.kind === "select"
    || interaction.kind === "input"
    || interaction.kind === "editor";
}
