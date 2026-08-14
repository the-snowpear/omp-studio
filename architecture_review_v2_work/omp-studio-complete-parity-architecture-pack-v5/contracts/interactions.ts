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

export interface InteractionSummary {
  interactionId: InteractionId;
  commandId: CommandId;
  kind: InteractionKind;
  owner: "gui" | "tui";
  leaseGeneration: number;
}

