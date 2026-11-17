import { memo } from "react";
import { Icon } from "../icons";
import { AgentSigil } from "./deck/AgentSigil";
import type { DeckTone } from "./deck/deckModel";
import { sigilHue } from "./deck/sigil";

export type AgentAvatarProps = {
  /** The Runtime agent id. The face and hue come from it alone; without one the tile shows the generic glyph. */
  readonly agentId: string | undefined;
  readonly name?: string | undefined;
  /** Expression: open eyes while working, closed once settled, amber when waiting, red on failure. */
  readonly tone: DeckTone;
  /** The main agent wears the crowned commander face. */
  readonly main?: boolean | undefined;
  readonly size: number;
  /** 0–1; drawn as a border ring only with `ring`. */
  readonly progress?: number | undefined;
  readonly ring?: boolean | undefined;
  readonly className?: string | undefined;
};

/**
 * An agent's avatar anywhere in Studio: the same pixel face and hue it has in the
 * deck, so one agent is recognisable across the Hub, the workbench and the
 * conversation. Decorative (`aria-hidden`); the caller names the agent in text.
 */
export const AgentAvatar = memo(function AgentAvatar({ agentId, name, tone, main = false, size, progress, ring = false, className }: AgentAvatarProps) {
  if (!agentId) {
    return <span className={`sg is-unknown${className ? ` ${className}` : ""}`} data-tone={tone}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }} aria-hidden="true">
      <Icon name="bot" />
    </span>;
  }
  return <AgentSigil
    identity={{ id: agentId, name: name ?? agentId, hue: main ? -1 : sigilHue(agentId), main }}
    tone={tone}
    size={size}
    progress={progress}
    ring={ring}
    {...(className === undefined ? {} : { className })}
  />;
});
