import type {
  EventSeq,
  OperatorStateSnapshot,
  StudioEventEnvelope,
  StudioHelloResponse,
  StudioSnapshotResponse,
} from "@omp-studio/studio-protocol";

export type RuntimeEventApplyResult = "applied" | "stale" | "gap" | "snapshot-required";

type StateChangedEvent = { kind: "state.changed"; snapshot: OperatorStateSnapshot };

function isStateChangedEvent(value: unknown): value is StateChangedEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "state.changed" &&
    "snapshot" in value
  );
}

export class RuntimeProjection {
  #hello: StudioHelloResponse | undefined;
  #snapshot: OperatorStateSnapshot | undefined;
  #lastEventSeq = 0 as EventSeq;
  #snapshotRequired = true;

  beginConnection(hello: StudioHelloResponse): void {
    this.#hello = structuredClone(hello);
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
    }
    this.#lastEventSeq = envelope.eventSeq;
    return "applied";
  }

  snapshot(): OperatorStateSnapshot | undefined {
    return this.#snapshot === undefined ? undefined : structuredClone(this.#snapshot);
  }

  lastEventSeq(): EventSeq {
    return this.#lastEventSeq;
  }

  needsSnapshot(): boolean {
    return this.#snapshotRequired;
  }
}
