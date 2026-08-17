import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandId, InteractionId, RemoteInteractionRequest } from "@omp-studio/studio-protocol";
import type { CommandRequestId, SessionId } from "@omp-studio/client-contract";
import { mapRemoteInteractionToClient } from "../src/interaction-map.js";

const REQUEST_ID = "client-req-1" as CommandRequestId;
const SESSION_ID = "session-1" as SessionId;

function base(kind: RemoteInteractionRequest["kind"]): Pick<RemoteInteractionRequest, "interactionId" | "commandId" | "title"> {
  return {
    interactionId: "int-1" as InteractionId,
    commandId: "cmd-1" as CommandId,
    title: "Runtime prompt title",
  };
}

test("confirm/select/input default optional booleans to false and preserve title", () => {
  const confirm = mapRemoteInteractionToClient(
    { ...base("confirm"), kind: "confirm", message: "Drop the session?" },
    SESSION_ID,
    3,
    REQUEST_ID,
  );
  assert.deepEqual(confirm, {
    interactionId: "int-1",
    sessionId: SESSION_ID,
    leaseGeneration: 3,
    title: "Runtime prompt title",
    requestId: REQUEST_ID,
    kind: "confirm",
    message: "Drop the session?",
    destructive: false,
  });
  const select = mapRemoteInteractionToClient(
    { ...base("select"), kind: "select", options: [{ id: "a", label: "A" }] },
    SESSION_ID,
    3,
    REQUEST_ID,
  );
  assert.equal(select?.kind, "select");
  if (select?.kind === "select") {
    assert.equal(select.multiple, false);
    assert.equal(select.title, "Runtime prompt title");
    assert.equal(select.sessionId, SESSION_ID);
    assert.equal(select.leaseGeneration, 3);
  }
  const input = mapRemoteInteractionToClient({ ...base("input"), kind: "input" }, SESSION_ID, 3, REQUEST_ID);
  assert.equal(input?.kind, "input");
  if (input?.kind === "input") {
    assert.equal(input.secret, false);
  }
});

test("without a requestId the interaction stands alone (session-level)", () => {
  const mapped = mapRemoteInteractionToClient(
    { ...base("input"), kind: "input", placeholder: "answer" },
    SESSION_ID,
    5,
  );
  assert.equal(mapped?.kind, "input");
  if (mapped?.kind !== "input") return;
  assert.equal(mapped.placeholder, "answer");
  assert.equal("requestId" in mapped, false);
  assert.equal(mapped.sessionId, SESSION_ID);
  assert.equal(mapped.leaseGeneration, 5);
});

test("editor keeps content/language and drops promptStyle", () => {
  const mapped = mapRemoteInteractionToClient(
    {
      ...base("editor"),
      kind: "editor",
      content: "draft",
      language: "markdown",
      promptStyle: true,
    },
    SESSION_ID,
    1,
    REQUEST_ID,
  );
  assert.deepEqual(mapped, {
    interactionId: "int-1",
    sessionId: SESSION_ID,
    leaseGeneration: 1,
    title: "Runtime prompt title",
    requestId: REQUEST_ID,
    kind: "editor",
    content: "draft",
    language: "markdown",
  });
  assert.equal(JSON.stringify(mapped).includes("promptStyle"), false);
});

test("approval details are reduced to a redacted scalar record", () => {
  const mapped = mapRemoteInteractionToClient(
    {
      ...base("approval"),
      kind: "approval",
      approvalType: "bash",
      details: {
        command: "rm -rf /tmp/x",
        reason: "cleanup",
        token: "sk-secret-should-drop",
        nested: { inner: "nope" },
        path: "C:\\\\Users\\\\secret\\\\project",
      },
    },
    SESSION_ID,
    2,
    REQUEST_ID,
  );
  assert.equal(mapped?.kind, "approval");
  if (mapped?.kind !== "approval") return;
  assert.equal(mapped.approvalType, "bash");
  assert.equal(mapped.title, "Runtime prompt title");
  assert.match(String(mapped.detail.command), /redacted/i);
  assert.equal(mapped.detail.reason, "cleanup");
  assert.equal("token" in mapped.detail, false);
  assert.equal("nested" in mapped.detail, false);
  assert.equal(typeof mapped.detail.path, "string");
  assert.match(String(mapped.detail.path), /redacted/i);
});

test("approval summary is kept up to 4000 characters", () => {
  const summary = `Command: ${"npx tsc ".repeat(200).trim()}`;
  assert.ok(summary.length > 240);
  assert.ok(summary.length < 4000);
  const mapped = mapRemoteInteractionToClient(
    {
      ...base("approval"),
      kind: "approval",
      approvalType: "bash",
      details: { toolName: "bash", summary, risk: "low" },
    },
    SESSION_ID,
    1,
    REQUEST_ID,
  );
  assert.equal(mapped?.kind, "approval");
  if (mapped?.kind !== "approval") return;
  assert.equal(mapped.detail.summary, summary);
});
