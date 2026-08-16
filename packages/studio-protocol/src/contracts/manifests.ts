import type { CommandEffect, CommandRisk } from "./commands";
import type { InteractionKind } from "./interactions";

export type CapabilityGrade = "stable" | "experimental" | "limited" | "unavailable";

export interface CapabilityManifestEntry {
  id: string;
  grade: CapabilityGrade;
  version: number;
  evidence: string;
  limitations?: string[];
}

export interface CapabilityManifest {
  profile: "full-parity-v1" | "limited";
  generatedAt: string;
  hash: string;
  capabilities: CapabilityManifestEntry[];
}

export type CommandSource =
  | "builtin"
  | "extension"
  | "skill"
  | "prompt-template"
  | "file-command";

export type CommandImplementation =
  | "shared-service"
  | "headless-handle"
  | "extension-command"
  | "tui-compatibility";

export type CommandPresentation = "native" | "generic-form" | "terminal";

export interface OperatorCommandManifestEntry {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  source: CommandSource;
  implementation: CommandImplementation;
  argumentSchema?: Record<string, unknown>;
  interactionKinds: InteractionKind[];
  presentation: CommandPresentation;
  availability: "available" | "disabled" | "blocked";
  risk: CommandRisk;
  effect: CommandEffect;
  contractTestId: string;
}

export interface OperatorCommandManifest {
  generatedAt: string;
  upstreamCommit: string;
  hash: string;
  commands: OperatorCommandManifestEntry[];
  unclassifiedBuiltins: string[];
}

export const FULL_PARITY_REQUIRED_CAPABILITIES = [
  "core.prompt",
  "core.steer",
  "core.followUp",
  "core.abort",
  "core.stream",
  "session.state",
  "session.history",
  "session.tree",
  "session.fork",
  "session.clearContext",
  "session.drop",
  "turn.retry",
  "operator.manifest",
  "operator.invoke",
  "permissions.mode.set",
  "interaction.respond",
  "agent.list",
  "agent.send",
  "agent.spawn",
  "agent.kill",
  "agent.revive",
  "agent.release",
  "agent.transcript",
  "job.list",
  "job.cancel",
  "remoteUi.standard",
  "tui.manualCompatibility",
  "runtime.pause",
  "runtime.resume",
  "runtime.snapshot",
] as const;

