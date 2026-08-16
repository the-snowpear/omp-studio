/**
 * Desktop Host interaction adoption, pre-signed high-risk tokens, and
 * Facade fan-out. Tokens never leave this module.
 */

import { randomUUID } from "node:crypto";

import type { HostInteractionRespondInput } from "@omp-studio/host-client-api";
import {
  CommandArbiter,
  HostConfirmationRegistry,
  RemoteInteractionAdapter,
  StudioHostError,
  type RuntimePublication,
  type StudioInteractionForward,
  type StudioRuntimeSessionController,
} from "@omp-studio/studio-host";
import type { CommandId, RequestId, StudioOperation } from "@omp-studio/studio-protocol";

import type { DesktopRuntimeSession } from "./host-composition.js";

class IsolatedForwarder<T> {
  readonly #listeners = new Set<(value: T) => void>();

  subscribe(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(value: T): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(value);
      } catch {
        // Isolate consumer failures from the Runtime event path.
      }
    }
  }
}

function isHighRisk(kind: string, destructive?: boolean): boolean {
  return kind === "approval" || (kind === "confirm" && destructive === true);
}

export class DesktopInteractionHost {
  readonly #sessionRef: { current: DesktopRuntimeSession | undefined };
  readonly #confirmations = new HostConfirmationRegistry();
  readonly #tokens = new Map<string, string>();
  readonly #events = new IsolatedForwarder<StudioInteractionForward>();
  readonly #adapter: RemoteInteractionAdapter;
  #unsubscribe: (() => void) | undefined;
  #unsubscribeLoss: (() => void) | undefined;
  #lost = false;

  constructor(sessionRef: { current: DesktopRuntimeSession | undefined }) {
    this.#sessionRef = sessionRef;
    const arbiter = new CommandArbiter(() => {
      const snapshot = sessionRef.current?.controller.publication()?.snapshot;
      return {
        runtimeEpoch: snapshot?.runtimeEpoch ?? (1 as RuntimePublication["snapshot"]["runtimeEpoch"]),
        stateVersion: snapshot?.stateVersion ?? (0 as RuntimePublication["snapshot"]["stateVersion"]),
        isStreaming: snapshot?.isStreaming ?? false,
        isCompacting: snapshot?.isCompacting ?? false,
      };
    });
    this.#adapter = new RemoteInteractionAdapter(arbiter, this.#confirmations, async (operation) => {
      const session = this.#sessionRef.current;
      if (session === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime is not available");
      }
      const snapshot = session.controller.publication()?.snapshot;
      const hello = session.hello();
      if (snapshot === undefined || hello === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime snapshot is unavailable");
      }
      const receipt = await session.controller.invoke({
        type: "studio.request",
        requestId: randomUUID() as RequestId,
        runtimeEpoch: snapshot.runtimeEpoch,
        expectedStateVersion: snapshot.stateVersion,
        operation,
      });
      if (receipt.status !== "accepted" && receipt.status !== "completed") {
        throw new StudioHostError("INTERNAL_ERROR", receipt.error?.message ?? "Interaction was not acknowledged");
      }
      return { status: receipt.status };
    });
  }

  subscribe(listener: (event: StudioInteractionForward) => void): () => void {
    return this.#events.subscribe(listener);
  }

  attach(controller: StudioRuntimeSessionController | undefined): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#unsubscribeLoss?.();
    this.#unsubscribeLoss = undefined;
    this.#lost = false;
    this.clear();
    if (controller === undefined || typeof controller.onInteractionEvent !== "function") {
      return;
    }
    this.#unsubscribe = controller.onInteractionEvent((event) => this.#onEvent(event, controller));
    // A resident/reconnected Runtime may already have an interaction in its
    // snapshot. Adopt it locally so the GUI can respond even though the
    // original required event happened before this Host attached.
    const pending = controller.pendingInteraction?.();
    if (pending !== undefined && pending.owner === "gui") {
      this.#adoptPending(pending);
    }
    // Runtime loss: the bridge disconnect clears the hello; revoke every
    // pre-signed token and drop the adapter pending so stale cards and
    // confirmations cannot outlive the Runtime (plan §4.3). The client is
    // resynced through the facade's runtime.changed event.
    if (typeof controller.onPublication !== "function") {
      return;
    }
    this.#unsubscribeLoss = controller.onPublication(() => {
      const session = this.#sessionRef.current;
      if (session === undefined || session.hello() !== undefined || this.#lost) {
        return;
      }
      this.#lost = true;
      this.clear();
    });
  }

  clear(): void {
    this.#tokens.clear();
    this.#adapter.clear();
  }

  async respond(input: HostInteractionRespondInput): Promise<void> {
    const pending = this.#adapter.pending();
    if (
      pending === undefined ||
      pending.interactionId !== input.interactionId ||
      pending.generation !== input.leaseGeneration
    ) {
      throw new StudioHostError("INTERACTION_STALE", "No matching interaction is pending");
    }
    if (pending.owner !== "gui") {
      throw new StudioHostError("NOT_OWNER", "This interaction is owned by the terminal");
    }
    const highRisk = isHighRisk(pending.request.kind, pending.request.kind === "confirm" ? pending.request.destructive : undefined);
    const tokenKey = `${pending.interactionId}:${pending.generation}`;
    const confirmationToken = highRisk && input.decision === "submit" ? this.#tokens.get(tokenKey) : undefined;
    if (highRisk && input.decision === "submit" && confirmationToken === undefined) {
      throw new StudioHostError("INVALID_ARGUMENT", "High-risk confirmation token is not available");
    }
    try {
      await this.#adapter.respond({
        interactionId: pending.interactionId,
        commandId: pending.commandId,
        generation: pending.generation,
        decision: input.decision,
        owner: "gui",
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(confirmationToken === undefined ? {} : { confirmationToken }),
        // Bind the one-shot token to this interaction's lease generation and
        // the current Runtime epoch (plan §3.4): a stale generation or a token
        // minted for an older epoch fails closed at consumption.
        binding: { leaseGeneration: pending.generation, runtimeEpoch: this.#runtimeEpoch() },
      });
      this.#tokens.delete(tokenKey);
    } catch (error) {
      // The one-shot token was consumed or is stale; the interaction is
      // still pending. Re-enter the safe confirmation flow by re-signing a
      // fresh token so the next attempt can proceed (plan §3.4). If the
      // pending disappeared (resolved concurrently), just drop the token.
      const current = this.#adapter.pending();
      if (
        current !== undefined &&
        current.interactionId === pending.interactionId &&
        isHighRisk(current.request.kind, current.request.kind === "confirm" ? current.request.destructive : undefined)
      ) {
        this.#resign(
          current.interactionId,
          current.generation,
          current.commandId,
          current.request.kind,
          current.request.kind === "confirm" ? current.request.destructive : undefined,
        );
      } else {
        this.#tokens.delete(tokenKey);
      }
      throw error;
    }
  }

  #onEvent(forward: StudioInteractionForward, controller: StudioRuntimeSessionController): void {
    try {
      if (forward.envelope.event.kind === "interaction.resolved") {
        // Runtime-side resolution (submit/cancel/abort/expire): clean the
        // adapter pending when it matches, revoke any pre-signed token and
        // forward so the client clears its pending card. Idempotent for
        // stale generations.
        this.#adapter.resolve(forward.envelope.event);
        this.#revokeToken(
          forward.envelope.event.interactionId,
          forward.envelope.event.leaseGeneration,
        );
        this.#events.publish({ envelope: forward.envelope });
        return;
      }
      const adopted = this.#adapter.adopt(forward.envelope.event);
      this.#resign(adopted.interactionId, adopted.generation, adopted.commandId, adopted.request.kind, adopted.request.kind === "confirm" ? adopted.request.destructive : undefined);
      const clientRequestId =
        forward.clientRequestId ??
        (typeof controller.requestIdForCommandId === "function"
          ? controller.requestIdForCommandId(adopted.commandId)
          : undefined);
      this.#events.publish({
        envelope: forward.envelope,
        ...(clientRequestId === undefined ? {} : { clientRequestId }),
      });
    } catch {
      // Duplicate/conflict must not break the Bridge socket or sibling listeners.
    }
  }

  #adoptPending(
    pending: NonNullable<ReturnType<StudioRuntimeSessionController["pendingInteraction"]>>,
  ): void {
    const adopted = this.#adapter.adopt({
      kind: "interaction.required",
      request: pending.request,
      owner: pending.owner,
      leaseGeneration: pending.leaseGeneration,
    });
    this.#resign(
      adopted.interactionId,
      adopted.generation,
      adopted.commandId,
      adopted.request.kind,
      adopted.request.kind === "confirm" ? adopted.request.destructive : undefined,
    );
  }

  #revokeToken(interactionId: string, generation: number): void {
    this.#tokens.delete(`${interactionId}:${generation}`);
  }

  #resign(
    interactionId: string,
    generation: number,
    commandId: CommandId,
    kind: string,
    destructive?: boolean,
  ): void {
    for (const key of [...this.#tokens.keys()]) {
      if (key.startsWith(`${interactionId}:`)) this.#tokens.delete(key);
    }
    if (!isHighRisk(kind, destructive)) {
      return;
    }
    // The one-shot token is signed over the exact respond operation: submit
    // with value true (plan §3.3/§3.4) — decision, value, interactionId and
    // commandId are all bound by the operation hash.
    const operation: StudioOperation = {
      kind: "interaction.respond",
      interactionId,
      commandId,
      decision: "submit",
      value: true,
    };
    this.#tokens.set(
      `${interactionId}:${generation}`,
      this.#confirmations.issue(operation, "gui", { leaseGeneration: generation, runtimeEpoch: this.#runtimeEpoch() }),
    );
  }

  #runtimeEpoch(): number {
    return this.#sessionRef.current?.controller.publication()?.snapshot.runtimeEpoch ?? 0;
  }
}

export { IsolatedForwarder };
