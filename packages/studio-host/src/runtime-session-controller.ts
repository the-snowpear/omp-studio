import type {
  CommandId,
  CommandLedgerEntry,
  RuntimeEpoch,
  RuntimeId,
  StudioReceipt,
  StudioRequest,
} from "@omp-studio/studio-protocol";
import { StudioBridgeClient } from "./bridge-client.js";
import { CommandLedger } from "./command-ledger.js";
import { RuntimePublicationStore, type RuntimePublication } from "./runtime-publication.js";

const TERMINAL = new Set<CommandLedgerEntry["status"]>(["completed", "failed", "rejected", "outcome_unknown"]);

export class StudioRuntimeSessionController {
  readonly #unsubscribeProjection: () => void;

  constructor(
    private readonly bridge: StudioBridgeClient,
    private readonly ledger: CommandLedger,
    private readonly publications = new RuntimePublicationStore(),
  ) {
    this.#unsubscribeProjection = bridge.onProjectionChanged((snapshot) => {
      this.publications.publish(snapshot, this.ledger.snapshot());
    });
  }

  async refresh(): Promise<RuntimePublication> {
    const response = await this.bridge.requestSnapshot();
    for (const receipt of response.terminalReceipts) {
      if (this.ledger.getByRequestId(receipt.requestId) !== undefined) this.ledger.reconcileReceipt(receipt);
    }
    return this.publications.publish(response.snapshot, this.ledger.snapshot());
  }

  async invoke(request: StudioRequest): Promise<StudioReceipt> {
    const snapshot = this.bridge.projectionSnapshot();
    if (snapshot === undefined) throw new Error("Runtime snapshot is required before command invocation");
    const provisionalCommandId = request.requestId as unknown as CommandId;
    this.ledger.request(provisionalCommandId, request, snapshot.runtimeId, snapshot.stateVersion);
    this.publications.publish(snapshot, this.ledger.snapshot());
    try {
      return await this.bridge.invoke(request, (receipt) => {
        this.ledger.reconcileReceipt(receipt);
        const current = this.bridge.projectionSnapshot();
        if (current !== undefined) this.publications.publish(current, this.ledger.snapshot());
      });
    } catch (error) {
      const entry = this.ledger.getByRequestId(request.requestId);
      if (entry !== undefined && !TERMINAL.has(entry.status)) {
        this.ledger.transition(entry.commandId, "outcome_unknown", { errorCode: "OUTCOME_UNKNOWN" });
        const current = this.bridge.projectionSnapshot();
        if (current !== undefined) this.publications.publish(current, this.ledger.snapshot());
      }
      throw error;
    }
  }

  runtimeLost(runtimeId: RuntimeId, runtimeEpoch: RuntimeEpoch): CommandLedgerEntry[] {
    const changed = this.ledger.markRuntimeLost(runtimeId, runtimeEpoch);
    const snapshot = this.bridge.projectionSnapshot();
    if (snapshot !== undefined) this.publications.publish(snapshot, this.ledger.snapshot());
    return changed;
  }

  publication(): RuntimePublication | undefined {
    return this.publications.current();
  }

  dispose(): void {
    this.#unsubscribeProjection();
  }
}
