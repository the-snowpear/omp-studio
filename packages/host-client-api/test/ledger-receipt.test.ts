import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandId, CommandLedgerEntry, RuntimeEpoch, RuntimeId } from "@omp-studio/studio-protocol";
import { receiptFromLedgerEntry } from "../src/events.js";

const OBSERVED_AT = "2026-08-21T00:00:00.000Z";

function entry(overrides: Partial<CommandLedgerEntry> = {}): CommandLedgerEntry {
  return {
    commandId: "cmd-1" as CommandId,
    requestId: "req-1",
    runtimeId: "runtime-1" as RuntimeId,
    runtimeEpoch: 1 as RuntimeEpoch,
    operationKind: "session.model.set",
    requestedAt: OBSERVED_AT,
    status: "failed",
    ...overrides,
  };
}

test("a failed ledger entry surfaces the Runtime's own message under the mapped code", () => {
  const receipt = receiptFromLedgerEntry(
    entry({
      status: "failed",
      errorCode: "INVALID_ARGUMENT",
      errorMessage: "Model is not available: deepseek/deepseek-v9",
    }),
    "session.model.set",
    OBSERVED_AT,
  );
  assert.equal(receipt?.status, "failed");
  assert.equal(receipt?.status === "failed" ? receipt.error.code : undefined, "INVALID_ARGUMENT");
  assert.equal(
    receipt?.status === "failed" ? receipt.error.message : undefined,
    "Model is not available: deepseek/deepseek-v9",
  );
});

test("a failed ledger entry without a message keeps the code-derived phrasing", () => {
  const receipt = receiptFromLedgerEntry(
    entry({ status: "failed", errorCode: "INVALID_ARGUMENT" }),
    "session.model.set",
    OBSERVED_AT,
  );
  assert.equal(
    receipt?.status === "failed" ? receipt.error.message : undefined,
    "runtime rejected the request arguments",
  );
});

test("code mapping is unchanged by the message passthrough", () => {
  const cases: ReadonlyArray<readonly [string | undefined, string]> = [
    ["RUNTIME_EPOCH_STALE", "STALE_EPOCH"],
    ["STATE_VERSION_CONFLICT", "STATE_VERSION_CONFLICT"],
    ["CAPABILITY_UNAVAILABLE", "CAPABILITY_UNAVAILABLE"],
    ["INVALID_ARGUMENT", "INVALID_ARGUMENT"],
    ["RESYNC_REQUIRED", "RESYNC_REQUIRED"],
    ["SOMETHING_NEW", "INTERNAL_ERROR"],
    [undefined, "INTERNAL_ERROR"],
  ];
  for (const [errorCode, expected] of cases) {
    const receipt = receiptFromLedgerEntry(
      entry({ status: "failed", ...(errorCode === undefined ? {} : { errorCode }), errorMessage: "detail text" }),
      "session.model.set",
      OBSERVED_AT,
    );
    assert.equal(receipt?.status === "failed" ? receipt.error.code : undefined, expected);
    assert.equal(receipt?.status === "failed" ? receipt.error.message : undefined, "detail text");
  }
});

test("rejected and outcome_unknown reasons append the Runtime detail to the code phrasing", () => {
  const rejected = receiptFromLedgerEntry(
    entry({ status: "rejected", errorCode: "INVALID_ARGUMENT", errorMessage: "Unsupported thinking level: turbo" }),
    "session.thinking.set",
    OBSERVED_AT,
  );
  assert.equal(
    rejected?.status === "rejected" ? rejected.reason : undefined,
    "runtime rejected request: INVALID_ARGUMENT: Unsupported thinking level: turbo",
  );

  const lost = receiptFromLedgerEntry(
    entry({ status: "outcome_unknown", errorCode: "OUTCOME_UNKNOWN", errorMessage: "pipe closed mid-turn" }),
    "core.prompt",
    OBSERVED_AT,
  );
  assert.equal(
    lost?.status === "outcome_unknown" ? lost.reason : undefined,
    "runtime lost (OUTCOME_UNKNOWN); outcome unknown: pipe closed mid-turn",
  );
});

test("reasons fall back to the bare phrasing when neither code nor message exists", () => {
  const rejected = receiptFromLedgerEntry(entry({ status: "rejected" }), "session.model.set", OBSERVED_AT);
  assert.equal(rejected?.status === "rejected" ? rejected.reason : undefined, "rejected by runtime");

  const lost = receiptFromLedgerEntry(entry({ status: "outcome_unknown" }), "core.prompt", OBSERVED_AT);
  assert.equal(lost?.status === "outcome_unknown" ? lost.reason : undefined, "runtime lost; outcome unknown");

  const detailOnly = receiptFromLedgerEntry(
    entry({ status: "rejected", errorMessage: "no code, just text" }),
    "session.model.set",
    OBSERVED_AT,
  );
  assert.equal(detailOnly?.status === "rejected" ? detailOnly.reason : undefined, "no code, just text");
});

test("non-terminal ledger statuses map to no receipt", () => {
  for (const status of ["requested", "accepted", "interaction_required", "completed"] as const) {
    assert.equal(receiptFromLedgerEntry(entry({ status }), "session.model.set", OBSERVED_AT), undefined);
  }
});
