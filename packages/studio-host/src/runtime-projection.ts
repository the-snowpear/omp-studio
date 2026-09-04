import type {
  EventSeq,
  OpaqueCursor,
  OperatorStateSnapshot,
  StudioEventEnvelope,
  StudioHelloResponse,
  StudioSnapshotResponse,
  SessionTelemetryEvent,
} from "@omp-studio/studio-protocol";

export type RuntimeEventApplyResult = "applied" | "stale" | "gap" | "snapshot-required";

type StateChangedEvent = { kind: "state.changed"; snapshot: OperatorStateSnapshot };
type TelemetryChangedEvent = SessionTelemetryEvent;

function isStateChangedEvent(value: unknown): value is StateChangedEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "state.changed" &&
    "snapshot" in value
  );
}

function isTelemetryChangedEvent(value: unknown): value is TelemetryChangedEvent {
  return value !== null && typeof value === "object" && "kind" in value && value.kind === "session.telemetry.changed";
}

export class RuntimeProjection {
  #hello: StudioHelloResponse | undefined;
  #snapshot: OperatorStateSnapshot | undefined;
  #messagesCursor: OpaqueCursor | undefined;
  #lastEventSeq = 0 as EventSeq;
  #snapshotRequired = true;
  #snapshotRevision = 0;

  /**
   * Advances only where `#snapshot` is reassigned. Callers compare it across
   * `applyEvent` to decide whether a publication is warranted: a
   * `conversation.message.delta` is `"applied"` (it advances `#lastEventSeq`)
   * without touching the operator snapshot, and republishing an unchanged
   * snapshot deep-clones the whole read model — plus the command ledger — once
   * per streamed token. The contract already says a delta must not advance
   * `stateVersion` (`CONVERSATION_MESSAGE_DELTA_INCREMENTS_STATE_VERSION`); this
   * is the missing guard on the Host side.
   *
   * `beginConnection` deliberately does not advance it: it clears `#hello` and
   * the cursor, not the snapshot.
   */
  snapshotRevision(): number {
    return this.#snapshotRevision;
  }

  beginConnection(hello: StudioHelloResponse): void {
    this.#hello = structuredClone(hello);
    this.#messagesCursor = undefined;
    this.#snapshotRequired = true;
  }

  applySnapshot(response: StudioSnapshotResponse): OperatorStateSnapshot {
    const hello = this.#hello;
    if (hello === undefined) throw new Error("Runtime hello is required before snapshot");
    if (
      String(response.snapshot.runtimeId) !== String(hello.runtimeInstanceId) ||
      response.snapshot.runtimeEpoch !== hello.runtimeEpoch ||
      Number(response.snapshot.stateVersion) < Number(hello.stateVersion) ||
      response.capabilityHash !== hello.capabilityManifest.hash ||
      response.commandManifestHash !== hello.commandManifestHash
    ) {
      throw new Error("Runtime snapshot identity does not match hello");
    }
    this.#snapshot = structuredClone(response.snapshot);
    this.#snapshotRevision += 1;
    this.#messagesCursor = response.messagesCursor;
    this.#lastEventSeq = response.lastEventSeq;
    this.#snapshotRequired = false;
    return structuredClone(response.snapshot);
  }

  applyEvent(envelope: StudioEventEnvelope): RuntimeEventApplyResult {
    const snapshot = this.#snapshot;
    if (this.#snapshotRequired || snapshot === undefined) return "snapshot-required";
    if (envelope.runtimeEpoch !== snapshot.runtimeEpoch) return "stale";
    if (Number(envelope.eventSeq) <= Number(this.#lastEventSeq)) return "stale";
    if (Number(envelope.eventSeq) !== Number(this.#lastEventSeq) + 1) {
      this.#snapshotRequired = true;
      return "gap";
    }
    if (Number(envelope.stateVersion) < Number(snapshot.stateVersion)) return "stale";
    if (isStateChangedEvent(envelope.event)) {
      if (
        envelope.event.snapshot.runtimeId !== snapshot.runtimeId ||
        envelope.event.snapshot.runtimeEpoch !== snapshot.runtimeEpoch ||
        envelope.event.snapshot.stateVersion !== envelope.stateVersion
      ) {
        this.#snapshotRequired = true;
        return "gap";
      }
      this.#snapshot = structuredClone(envelope.event.snapshot);
      this.#snapshotRevision += 1;
    } else if (isTelemetryChangedEvent(envelope.event)) {
      if (envelope.event.sessionId !== snapshot.sessionId || envelope.event.telemetry.sessionId !== snapshot.sessionId) {
        // Event sequence is runtime-wide. A late telemetry event from the
        // prior session must be ignored without turning the next event into a
        // false gap.
        this.#lastEventSeq = envelope.eventSeq;
        return "stale";
      }
      this.#snapshot = { ...snapshot, telemetry: structuredClone(envelope.event.telemetry) };
      this.#snapshotRevision += 1;
    }
    this.#lastEventSeq = envelope.eventSeq;
    return "applied";
  }

  snapshot(): OperatorStateSnapshot | undefined {
    return this.#snapshot === undefined ? undefined : structuredClone(this.#snapshot);
  }

  messagesCursor(): OpaqueCursor | undefined {
    return this.#messagesCursor;
  }

  lastEventSeq(): EventSeq {
    return this.#lastEventSeq;
  }

  needsSnapshot(): boolean {
    return this.#snapshotRequired;
  }
}
