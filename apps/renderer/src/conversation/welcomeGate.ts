import type { HydrateStatus } from "./conversationViewModel";

const NEW_CONVERSATION_HYDRATE: ReadonlySet<HydrateStatus> = new Set(["ready", "unavailable", "idle"]);

export type ConversationWelcomeInput = {
  readonly preview: boolean;
  readonly previewThreadId?: string;
  readonly selectedSessionId?: string;
  readonly sessionCreating?: boolean;
  readonly compacting: boolean;
  readonly rowCount: number;
  readonly hydrateStatus: HydrateStatus;
  readonly demo?: boolean;
};

/**
 * New-conversation chrome (welcome hero, project strip). No selected
 * session + empty transcript counts even when hydrate is unavailable
 * (Runtime down / no workspace). A selected session that failed to
 * hydrate stays on the honest empty shell.
 */
export function isNewConversationSurface(input: ConversationWelcomeInput): boolean {
  if (input.preview) return input.previewThreadId === "t0";
  if (input.selectedSessionId !== undefined) return false;
  if (input.sessionCreating === true) return true;
  return input.rowCount === 0 && !input.compacting && NEW_CONVERSATION_HYDRATE.has(input.hydrateStatus);
}

/** Pass `ConversationEmpty` into the pane. Compacting never shows welcome. */
export function shouldShowConversationWelcome(input: ConversationWelcomeInput): boolean {
  if (input.compacting) return false;
  if (input.sessionCreating === true) return true;
  if (isNewConversationSurface(input)) return true;
  return input.rowCount === 0 && (input.demo === true || input.hydrateStatus === "ready");
}
