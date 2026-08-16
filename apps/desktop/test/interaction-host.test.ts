import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  StudioInteractionForward,
  StudioRuntimeSessionController,
} from "@omp-studio/studio-host";
import type {
  CommandId,
  InteractionId,
  RemoteInteractionRequiredEvent,
  RuntimeEpoch,
  StateVersion,
  StudioInteractionResolvedEvent,
  StudioOperation,
} from "@omp-studio/studio-protocol";

import type { DesktopRuntimeSession } from "../src/host-composition.js";
import { DesktopInteractionHost } from "../src/interaction-host.js";

const interactionId = "interaction-1" as InteractionId;
const commandId = "command-1" as CommandId;

function forward(
  event: RemoteInteractionRequiredEvent | StudioInteractionResolvedEvent,
  eventSeq: number,
): StudioInteractionForward {
  return {
    envelope: {
      type: "studio.event",
      runtimeEpoch: 1,
      eventSeq,
      stateVersion: 1,
      occurredAt: "2026-08-16T00:00:00.000Z",
      event,
    },
  };
}

test("a stale resolved generation cannot revoke the current approval token", async () => {
  let interactionListener: ((event: StudioInteractionForward) => void) | undefined;
  const invoked: StudioOperation[] = [];
  const snapshot = {
    runtimeId: "runtime-1",
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 1 as StateVersion,
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
  };
  const controller = {
    publication: () => ({ commitSeq: 1, publishedAt: "2026-08-16T00:00:00.000Z", snapshot, terminalOutcomes: [] }),
    pendingInteraction: () => undefined,
    onInteractionEvent: (listener: (event: StudioInteractionForward) => void) => {
      interactionListener = listener;
      return () => {
        if (interactionListener === listener) interactionListener = undefined;
      };
    },
    onPublication: () => () => undefined,
    requestIdForCommandId: () => undefined,
    invoke: async (request: { operation: StudioOperation }) => {
      invoked.push(request.operation);
      return { status: "accepted" };
    },
  } as unknown as StudioRuntimeSessionController;
  const session = {
    controller,
    hello: () => ({ runtimeId: "runtime-1", runtimeEpoch: 1, classification: "managed" }),
  } as unknown as DesktopRuntimeSession;
  const host = new DesktopInteractionHost({ current: session });
  host.attach(controller);

  const request = {
    kind: "approval",
    interactionId,
    commandId,
    title: "Allow once?",
    approvalType: "tool",
    details: { toolName: "write" },
  } as const;
  interactionListener?.(forward({ kind: "interaction.required", request, owner: "gui", leaseGeneration: 1 }, 1));
  interactionListener?.(forward({ kind: "interaction.required", request, owner: "gui", leaseGeneration: 2 }, 2));
  interactionListener?.(
    forward(
      {
        kind: "interaction.resolved",
        interactionId,
        commandId,
        leaseGeneration: 1,
        outcome: "submitted",
      },
      3,
    ),
  );

  await host.respond({ interactionId, leaseGeneration: 2, decision: "submit", value: true });
  assert.deepEqual(invoked, [
    { kind: "interaction.respond", interactionId, commandId, decision: "submit", value: true },
  ]);
});
