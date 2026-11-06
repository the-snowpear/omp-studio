import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { ComputerAction } from "@omp-studio/studio-protocol";
import type { ComputerPreviewScenario } from "../preview/computerPreview";

export type ComputerExecutionTarget = { kind: "local" | "remote" | "unknown"; id?: string | undefined; name?: string | undefined };
export type ComputerFrameIntent = { id: string; frameId: string; sessionId?: string; toolCallId?: string; agentId?: string };
export interface ComputerPaneProps {
  client: StudioClient;
  sessionId?: string | undefined;
  sessionName?: string | undefined;
  /** Authority, Runtime epoch and execution target identity, never a panel's geometry. */
  scopeKey?: string | undefined;
  available: boolean;
  visible: boolean;
  width?: number | undefined;
  height?: number | undefined;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
  executionTarget?: ComputerExecutionTarget | undefined;
  frameIntent?: ComputerFrameIntent | undefined;
  onRevealConversation?: ((action?: Pick<ComputerAction, "sessionId" | "toolCallId" | "agentId">) => Promise<boolean> | void) | undefined;
  onRevealApproval?: (() => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
  /** Fixture choice is ignored when global preview mode is off. */
  previewScenario?: ComputerPreviewScenario | undefined;
}
export const hasComputerCapability = (manifest: ComputerPaneProps["capabilities"], id: string) =>
  manifest?.capabilities.some(item => item.id === id && item.grade !== "unavailable") === true;
