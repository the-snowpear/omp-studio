import {
  type CommandId,
  type IdempotencyKey,
  type OperatorStateSnapshot,
  type RuntimeEpoch,
  type RuntimeId,
  type StateVersion,
  type StudioReceipt,
  type StudioRequest,
} from "@omp-studio/studio-protocol";
import { CommandArbiter } from "../../src/command-arbiter.js";
import { CommandLedger } from "../../src/command-ledger.js";
import { ReceiptRegistry } from "../../src/receipt-registry.js";
import { StateProjector } from "../../src/state-projector.js";

export class SimulatedPauseRuntime {
  readonly ledger = new CommandLedger(() => "2026-08-10T00:00:00.000Z");
  readonly registry = new ReceiptRegistry();
  readonly projector: StateProjector;
  readonly arbiter: CommandArbiter;
  #commandSequence = 0;

  constructor(initial: OperatorStateSnapshot) {
    this.projector = new StateProjector(initial);
    this.arbiter = new CommandArbiter(() => {
      const state = this.projector.snapshot();
      return {
        runtimeEpoch: state.runtimeEpoch,
        stateVersion: state.stateVersion,
        isStreaming: state.isStreaming,
        isCompacting: state.isCompacting,
      };
    });
  }

  async invoke(request: StudioRequest): Promise<StudioReceipt> {
    if (request.idempotencyKey !== undefined) {
      const existing = this.registry.lookup(request.idempotencyKey, request.operation);
      if (existing.kind === "replay") return existing.receipt;
      if (existing.kind === "conflict") {
        return this.receipt(request, "rejected", undefined, "INVALID_ARGUMENT");
      }
    }

    return this.arbiter.run(request, async () => {
      const commandId = `cmd-${++this.#commandSequence}` as CommandId;
      const before = this.projector.snapshot();
      this.ledger.request(commandId, request, before.runtimeId, before.stateVersion);

      let result: unknown;
      if (request.operation.kind === "runtime.pause") {
        this.ledger.transition(commandId, "accepted");
        const nextPauseEpoch = (before.pause?.pauseEpoch ?? 0) + 1;
        this.projector.commit((draft) => {
          draft.pause = { paused: true, pauseEpoch: nextPauseEpoch, pausedAt: "2026-08-10T00:00:00.000Z" };
        });
        result = { pauseEpoch: nextPauseEpoch };
      } else if (request.operation.kind === "runtime.resume") {
        const expectedPauseEpoch = request.operation.expectedPauseEpoch;
        if (!before.pause?.paused || expectedPauseEpoch !== before.pause.pauseEpoch) {
          this.ledger.transition(commandId, "rejected", { errorCode: "STATE_VERSION_CONFLICT" });
          return this.receipt(request, "rejected", commandId, "STATE_VERSION_CONFLICT");
        }
        this.ledger.transition(commandId, "accepted");
        this.projector.commit((draft) => {
          draft.pause = { paused: false, pauseEpoch: expectedPauseEpoch };
        });
        result = { pauseEpoch: expectedPauseEpoch };
      } else if (request.operation.kind === "runtime.snapshot") {
        this.ledger.transition(commandId, "accepted");
        result = this.projector.snapshot();
      } else {
        this.ledger.transition(commandId, "rejected", { errorCode: "COMMAND_UNKNOWN" });
        return this.receipt(request, "rejected", commandId, "COMMAND_UNKNOWN");
      }

      const after = this.projector.snapshot();
      this.ledger.transition(commandId, "completed", { stateVersionAfter: after.stateVersion });
      const receipt = this.receipt(request, "completed", commandId, undefined, result);
      if (request.idempotencyKey !== undefined) {
        this.registry.remember(request.idempotencyKey as IdempotencyKey, request.operation, receipt);
      }
      return receipt;
    });
  }

  snapshot(): OperatorStateSnapshot {
    return this.projector.snapshot();
  }

  private receipt(
    request: StudioRequest,
    status: StudioReceipt["status"],
    commandId?: CommandId,
    errorCode?: "INVALID_ARGUMENT" | "STATE_VERSION_CONFLICT" | "COMMAND_UNKNOWN",
    result?: unknown,
  ): StudioReceipt {
    const snapshot = this.projector.snapshot();
    return {
      type: "studio.receipt",
      requestId: request.requestId,
      runtimeEpoch: snapshot.runtimeEpoch as RuntimeEpoch,
      stateVersion: snapshot.stateVersion as StateVersion,
      status,
      ...(commandId === undefined ? {} : { commandId }),
      ...(result === undefined ? {} : { result }),
      ...(errorCode === undefined
        ? {}
        : { error: { code: errorCode, message: errorCode, retryable: false } }),
    };
  }
}

export function initialSnapshot(runtimeId: RuntimeId, runtimeEpoch: RuntimeEpoch): OperatorStateSnapshot {
  return {
    runtimeId,
    runtimeEpoch,
    stateVersion: 0 as StateVersion,
    sessionId: "session-fixture" as OperatorStateSnapshot["sessionId"],
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal",
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}
