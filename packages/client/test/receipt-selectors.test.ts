import assert from "node:assert/strict";
import { test } from "node:test";

import type { CommandRequestId, CommandState } from "@omp-studio/client-contract";

import { reduceClientState, createInitialClientState } from "../src/reducer.js";
import { selectComposerReceipt, selectComposerTerminal } from "../src/receipt-selectors.js";

const REQ = "req-composer-1" as CommandRequestId;
const TS = "2026-08-15T13:00:00.000Z";

function issue() {
  return reduceClientState(createInitialClientState(), {
    type: "command.issue",
    requestId: REQ,
    commandName: "core.prompt",
    idempotencyKey: "idem-1" as never,
    issuedAt: TS,
  });
}

test("accepted is not completed", () => {
  let state = issue();
  assert.equal(selectComposerReceipt(state.commands, REQ).phase, "pending");
  state = reduceClientState(state, {
    type: "event",
    event: {
      kind: "command.accepted",
      authorityEpoch: 1 as never,
      stateVersion: 1 as never,
      cursor: "1" as never,
      occurredAt: TS,
      accepted: { commandName: "core.prompt", requestId: REQ, status: "accepted", acceptedAt: TS },
    },
  });
  const view = selectComposerReceipt(state.commands, REQ);
  assert.equal(view.phase, "accepted");
  assert.equal(selectComposerTerminal(state.commands, REQ), undefined);
});

test("failed, rejected, and outcome_unknown keep a safe reason and terminal once", () => {
  const cases: Array<{ status: CommandState["status"]; event: Parameters<typeof reduceClientState>[1] }> = [
    {
      status: "failed",
      event: {
        type: "event",
        event: {
          kind: "command.receipt",
          authorityEpoch: 1 as never,
          stateVersion: 1 as never,
          cursor: "1" as never,
          occurredAt: TS,
          receipt: {
            requestId: REQ,
            commandName: "core.prompt",
            status: "failed",
            error: { code: "INTERNAL_ERROR", message: "model failed" },
            observedAt: TS,
          },
        },
      },
    },
    {
      status: "rejected",
      event: {
        type: "event",
        event: {
          kind: "command.receipt",
          authorityEpoch: 1 as never,
          stateVersion: 1 as never,
          cursor: "1" as never,
          occurredAt: TS,
          receipt: {
            requestId: REQ,
            commandName: "core.prompt",
            status: "rejected",
            reason: "runtime rejected request",
            observedAt: TS,
          },
        },
      },
    },
    {
      status: "outcome_unknown",
      event: {
        type: "event",
        event: {
          kind: "command.receipt",
          authorityEpoch: 1 as never,
          stateVersion: 1 as never,
          cursor: "1" as never,
          occurredAt: TS,
          receipt: {
            requestId: REQ,
            commandName: "core.prompt",
            status: "outcome_unknown",
            reason: "runtime lost; outcome unknown",
            observedAt: TS,
          },
        },
      },
    },
  ];
  for (const item of cases) {
    let state = issue();
    state = reduceClientState(state, item.event);
    const view = selectComposerReceipt(state.commands, REQ);
    assert.equal(view.phase, item.status);
    const second = reduceClientState(state, {
      type: "event",
      event: {
        kind: "command.receipt",
        authorityEpoch: 1 as never,
        stateVersion: 2 as never,
        cursor: "2" as never,
        occurredAt: TS,
        receipt: {
          requestId: REQ,
          commandName: "core.prompt",
          status: "completed",
          result: {} as never,
          observedAt: TS,
        },
      },
    });
    assert.equal(selectComposerReceipt(second.commands, REQ).phase, item.status);
    assert.ok(selectComposerTerminal(second.commands, REQ));
  }
});
