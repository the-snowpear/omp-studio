import {
  parseSessionTelemetryEvent,
  type SessionTelemetryEvent,
  type StudioEventEnvelope,
} from "@omp-studio/studio-protocol";

export interface StudioTelemetryForward {
  readonly envelope: StudioEventEnvelope<SessionTelemetryEvent>;
}

/** Live latest-value telemetry fan-out. Events are not retained for replay. */
export class TelemetryEventFanout {
  readonly #listeners = new Set<(event: StudioTelemetryForward) => void>();

  onEvent(listener: (event: StudioTelemetryForward) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  forward(envelope: StudioEventEnvelope): boolean {
    if (envelope.event === null || typeof envelope.event !== "object" || !("kind" in envelope.event)) return false;
    if (envelope.event.kind !== "session.telemetry.changed") return false;
    let parsed: SessionTelemetryEvent;
    try {
      parsed = parseSessionTelemetryEvent(envelope.event);
    } catch {
      return false;
    }
    const event: StudioTelemetryForward = {
      envelope: { ...envelope, event: parsed },
    };
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Isolate sibling listeners.
      }
    }
    return true;
  }

  dispose(): void {
    this.#listeners.clear();
  }
}
