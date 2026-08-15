import type { CommandId, InteractionId } from "./ids";

export type InteractionKind = "confirm" | "select" | "input" | "editor" | "approval";

interface InteractionBase {
  interactionId: InteractionId;
  commandId: CommandId;
  title: string;
}

export type RemoteInteractionRequest =
  | (InteractionBase & {
      kind: "confirm";
      message: string;
      destructive?: boolean;
    })
  | (InteractionBase & {
      kind: "select";
      options: Array<{ id: string; label: string; description?: string }>;
      multiple?: boolean;
    })
  | (InteractionBase & {
      kind: "input";
      placeholder?: string;
      secret?: boolean;
    })
  | (InteractionBase & {
      kind: "editor";
      content?: string;
      language?: string;
      promptStyle?: boolean;
    })
  | (InteractionBase & {
      kind: "approval";
      approvalType: string;
      details: unknown;
    });

export interface RemoteInteractionResponse {
  kind: "interaction.respond";
  interactionId: InteractionId;
  commandId: CommandId;
  decision: "submit" | "cancel";
  value?: unknown;
}

/**
 * Full recoverable pending interaction carried by the snapshot. The request
 * is the same shape the Bridge carries; the Host redacts and length-limits
 * before mapping to the Client contract. At most one pending Interaction
 * exists in a snapshot; a second request must fail closed.
 */
export interface StudioPendingInteraction {
  readonly request: RemoteInteractionRequest;
  readonly owner: "gui" | "tui";
  readonly leaseGeneration: number;
}

export interface RemoteInteractionRequiredEvent {
  kind: "interaction.required";
  request: RemoteInteractionRequest;
  owner: "gui" | "tui";
  leaseGeneration: number;
}

export interface StudioInteractionResolvedEvent {
  kind: "interaction.resolved";
  interactionId: InteractionId;
  commandId: CommandId;
  leaseGeneration: number;
  outcome: "submitted" | "cancelled" | "aborted" | "expired";
}
