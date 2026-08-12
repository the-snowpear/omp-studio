import type {
  EventSeq,
  OperatorStateSnapshot,
  StateVersion,
  StudioEventEnvelope,
} from "@omp-studio/studio-protocol";

export type ProjectedEvent = { kind: "state.changed"; snapshot: OperatorStateSnapshot };

export class StateProjector {
  #snapshot: OperatorStateSnapshot;
  #eventSeq: EventSeq;

  constructor(initial: OperatorStateSnapshot, initialEventSeq = 0 as EventSeq) {
    this.#snapshot = structuredClone(initial);
    this.#eventSeq = initialEventSeq;
  }

  snapshot(): OperatorStateSnapshot {
    return structuredClone(this.#snapshot);
  }

  lastEventSeq(): EventSeq {
    return this.#eventSeq;
  }

  commit(mutator: (draft: OperatorStateSnapshot) => void, occurredAt = new Date().toISOString()): StudioEventEnvelope<ProjectedEvent> {
    const draft = structuredClone(this.#snapshot);
    mutator(draft);
    draft.stateVersion = (Number(this.#snapshot.stateVersion) + 1) as StateVersion;
    this.#eventSeq = (Number(this.#eventSeq) + 1) as EventSeq;
    this.#snapshot = draft;
    return {
      type: "studio.event",
      runtimeEpoch: draft.runtimeEpoch,
      eventSeq: this.#eventSeq,
      stateVersion: draft.stateVersion,
      occurredAt,
      event: { kind: "state.changed", snapshot: structuredClone(draft) },
    };
  }
}
