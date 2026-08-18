import type { AgentOperation, JobOperation } from "./agents-jobs";
import type { SessionTranscriptRead } from "./conversation";
import type { CommandId, InteractionId } from "./ids";
import type { RemoteInteractionResponse } from "./interactions";
import type { SessionThinkingSelector } from "./state";

export interface LoopLimit {
  turns?: number;
  minutes?: number;
  tokens?: number;
}

export type CoreOperation =
  | { kind: "core.prompt"; text: string; images?: unknown[] }
  | { kind: "core.steer"; text: string; images?: unknown[] }
  | { kind: "core.followUp"; text: string; images?: unknown[] }
  | { kind: "core.abort" }
  | { kind: "runtime.snapshot" }
  | { kind: "runtime.pause" }
  | { kind: "runtime.resume"; expectedPauseEpoch: number }
  | { kind: "runtime.shutdown"; drain: true };

export type SessionOperation =
  | { kind: "queue.enqueue"; text: string }
  | { kind: "session.clearContext" }
  | { kind: "session.drop" }
  | { kind: "session.fork" }
  | { kind: "session.handoff"; customInstructions?: string }
  /**
   * Switch the live session model — same semantics as `/model`, so it never
   * rewrites `modelRoles` on disk. `thinking` pins a level alongside the
   * switch; omitted, the target model's own default applies.
   */
  | { kind: "session.model.set"; selector: string; thinking?: SessionThinkingSelector }
  | { kind: "session.thinking.set"; level: SessionThinkingSelector }
  | { kind: "session.tree.get" }
  | {
      kind: "session.tree.navigate";
      targetId: string;
      summarize?: boolean;
      customInstructions?: string;
      reanswer?: unknown;
    }
  | { kind: "session.tree.branch"; targetId: string }
  | { kind: "turn.retry" }
  | { kind: "session.fast.set"; enabled: boolean }
  | { kind: "session.prewalk.arm"; target?: string }
  | { kind: "session.prewalk.disarm" }
  | SessionTranscriptRead;

export type ModeOperation =
  | { kind: "mode.plan.enter"; initialPrompt?: string }
  | { kind: "mode.plan.exit"; discardDraft?: boolean }
  | { kind: "mode.plan.review.open" }
  | {
      kind: "mode.plan.review.respond";
      /**
       * `execute` clears conversation context, `compact` distills it, `keep`
       * preserves it. `approve` is the keep-context alias.
       */
      decision: "execute" | "compact" | "keep" | "approve" | "refine" | "dismiss";
      feedback?: string;
    }
  | { kind: "mode.vibe.enter"; initialPrompt?: string }
  | { kind: "mode.vibe.exit" }
  | { kind: "goal.create"; objective: string; tokenBudget?: number }
  | { kind: "goal.replace"; objective: string; tokenBudget?: number }
  | { kind: "goal.show" }
  | { kind: "goal.setBudget"; tokenBudget?: number }
  | { kind: "goal.pause" }
  | { kind: "goal.resume" }
  | { kind: "goal.drop" }
  | { kind: "goal.guided.start"; initial?: string }
  | { kind: "loop.enable"; prompt?: string; limit?: LoopLimit }
  | { kind: "loop.pause" }
  | { kind: "loop.disable" };

export type CompositeOperation =
  | { kind: "btw.ask"; question: string }
  | { kind: "btw.abort"; ephemeralId: string }
  | { kind: "btw.branch"; branchToken: string }
  | { kind: "tan.start"; work: string }
  | { kind: "omfg.generate"; complaint: string }
  | { kind: "omfg.amend"; candidateId: string; feedback: string }
  | {
      kind: "omfg.commit";
      candidateId: string;
      scope: "project" | "user";
      overwrite: boolean;
    }
  | { kind: "live.start"; deviceId?: string }
  | { kind: "live.stop" };

export type OperatorOperation =
  | { kind: "operator.manifest.get" }
  | { kind: "operator.invoke"; commandId: string; arguments?: unknown };

export type ApprovalMode = "always-ask" | "write" | "yolo";

export type PermissionOperation = {
  kind: "permissions.mode.set";
  mode: ApprovalMode;
  /** Persist to the OMP global configuration; false = runtime-local override. */
  persist: boolean;
};

export type TransferOperation = {
  kind: "tui.transfer";
  commandId: CommandId;
  interactionId?: InteractionId;
};

export type StudioOperation =
  | CoreOperation
  | SessionOperation
  | ModeOperation
  | CompositeOperation
  | OperatorOperation
  | PermissionOperation
  | TransferOperation
  | AgentOperation
  | JobOperation
  | RemoteInteractionResponse;

export type CommandConcurrency =
  | "read-concurrent"
  | "queue-compatible"
  | "session-exclusive"
  | "process-exclusive";

export type CommandRisk = "normal" | "sensitive" | "destructive";
export type CommandEffect = "read" | "session" | "workspace" | "process" | "external";
