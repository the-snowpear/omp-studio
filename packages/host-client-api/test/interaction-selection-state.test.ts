import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionId } from "@omp-studio/client-contract";
import type { CommandId, InteractionId, RemoteInteractionRequest } from "@omp-studio/studio-protocol";
import { mapRemoteInteractionToClient } from "../src/interaction-map.js";

test("native select cursor and checkbox state survive the Host mapping without changing activation semantics", () => {
  const request: RemoteInteractionRequest = {
    kind: "select", interactionId: "selection" as InteractionId, commandId: "command" as CommandId,
    title: "Choose changes", options: [{id:"a",label:"First"},{id:"b",label:"Second"},{id:"done",label:"Done"}],
    initialIndex: 1, selectionMarker: "checkbox", checkedIndices: [0], markableCount: 2,
  };
  const result = mapRemoteInteractionToClient(request, "session" as SessionId, 7);
  assert.equal(result?.kind, "select");
  if (result?.kind !== "select") throw new Error("Expected a select interaction");
  assert.equal(result.initialIndex, 1);
  assert.equal(result.selectionMarker, "checkbox");
  assert.deepEqual(result.checkedIndices, [0]);
  assert.equal(result.markableCount, 2);
  assert.equal(result.multiple, false);
  assert.equal(result.leaseGeneration, 7);
  assert.deepEqual(result.options.map(option => option.id), ["a", "b", "done"]);
});
