import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import {
  ValidationError,
  assertClientEvent,
  parseClientCommandRequest,
} from "../src/index.js";
import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGES_TOTAL_BYTES,
} from "../src/validate-inbound.js";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import type { RuntimeEpoch, RuntimeId, SessionId, StateVersion } from "@omp-studio/studio-protocol";

const SNAPSHOT: OperatorStateSnapshot = {
  runtimeId: "runtime-1" as RuntimeId,
  runtimeEpoch: 1 as RuntimeEpoch,
  stateVersion: 1 as StateVersion,
  sessionId: "session-1" as SessionId,
  isStreaming: false,
  isCompacting: false,
  activeMode: "plan",
  approvalMode: "always-ask",
  pendingMessages: 0,
  activeCommandIds: [],
  agentsRevision: 0,
  jobsRevision: 0,
  agents: [],
  jobs: [],
};

function command(commandName: string, input: unknown): unknown {
  return {
    commandName,
    input,
    requestId: "request-runtime-mirror",
    idempotencyKey: "idempotency-runtime-mirror",
  };
}

function assertInvalid(commandName: string, input: unknown): void {
  assert.throws(
    () => parseClientCommandRequest(command(commandName, input)),
    (error: unknown) => error instanceof ValidationError,
  );
}

test("IPC validates condition loops, Prewalk restart and experimental settings", () => {
  assert.equal(parseClientCommandRequest(command("session.prewalk.restart", {})).commandName, "session.prewalk.restart");
  const input = { condition: { command: "test -f done", until: true } };
  assert.deepEqual(parseClientCommandRequest(command("loop.enable", input)).input, input);
  assertInvalid("loop.enable", { condition: { command: "check", until: 1 } });
  assertInvalid("loop.enable", { condition: { command: "check", until: true, cwd: "outside" } });
  assertInvalid("runtime.settings.set", { key: "plan.autosave", value: "true", persist: true });
  assertInvalid("runtime.settings.set", { key: "compaction.experimentalContextManagement", value: {}, persist: true });
});

test("Desktop inbound validator mirrors Runtime settings and strict Plan paths", () => {
  assert.equal(
    parseClientCommandRequest(command("runtime.settings.get", { keys: ["extendedContext"] })).commandName,
    "runtime.settings.get",
  );
  assert.equal(
    parseClientCommandRequest(
      command("runtime.settings.set", { key: "compaction.methodOrder", value: ["remote", "soft"], persist: false }),
    ).commandName,
    "runtime.settings.set",
  );
  assert.equal(
    parseClientCommandRequest(command("mode.plan.review.saveAndQuit", { path: "plans/plan.md" })).commandName,
    "mode.plan.review.saveAndQuit",
  );

  const invalid = [
    ["runtime.settings.get", { keys: ["extendedContext", "extendedContext"] }],
    ["runtime.settings.get", { keys: ["unknown"] }],
    ["runtime.settings.set", { key: "extendedContext", value: "true", persist: false }],
    ["runtime.settings.set", { key: "compaction.methodOrder", value: ["soft", "soft"], persist: true }],
    ["runtime.settings.set", { key: "not-allowed", value: true, persist: true }],
    ["mode.plan.review.saveAndQuit", { path: "../plan.md" }],
    ["mode.plan.review.saveAndQuit", { path: " C:\\plan.md " }],
    ["mode.plan.review.saveAndQuit", { path: '"../plan.md"' }],
    ["mode.plan.review.saveAndQuit", { path: "plans/plan.md/" }],
  ] as const;
  for (const [name, input] of invalid) assertInvalid(name, input);
});

test("Desktop outbound validates Runtime mirror receipts and optional snapshot projection", () => {
  const base = {
    authorityEpoch: 1,
    runtimeEpoch: 1,
    stateVersion: 1,
    cursor: "1",
    occurredAt: "2026-08-23T00:00:00.000Z",
  } as const;
  assert.doesNotThrow(() =>
    assertClientEvent({
      ...base,
      kind: "snapshot",
      snapshot: {
        ...SNAPSHOT,
        runtimeSettings: {
          "edit.autoRepair.enabled": true,
          "features.unexpectedStopDetection": "mechanical",
          "providers.unexpectedStopModel": "online",
          extendedContext: true,
          "compaction.asyncEnabled": false,
          "compaction.methodOrder": ["remote", "soft"],
          "providers.openai-codex.codeMode": "off",
        },
        compactionSpeculation: "idle",
      },
    }),
  );
  assert.doesNotThrow(() =>
    assertClientEvent({
      ...base,
      kind: "command.receipt",
      receipt: {
        requestId: "request-runtime-mirror",
        commandName: "runtime.settings.get",
        status: "completed",
        result: { values: { extendedContext: true } },
        observedAt: base.occurredAt,
      },
    }),
  );
  assert.doesNotThrow(() =>
    assertClientEvent({
      ...base,
      kind: "command.receipt",
      receipt: {
        requestId: "request-runtime-mirror",
        commandName: "mode.plan.review.saveAndQuit",
        status: "completed",
        result: {
          saved: true,
          path: "plans/plan.md",
          exitedPlan: true,
          newSession: "started",
          sessionId: "session-2",
        },
        observedAt: base.occurredAt,
      },
    }),
  );
  assert.doesNotThrow(() =>
    assertClientEvent({
      ...base,
      kind: "command.receipt",
      receipt: {
        requestId: "request-runtime-mirror",
        commandName: "mode.plan.review.saveAndQuit",
        status: "completed",
        result: {
          saved: true,
          path: "plans/plan.md",
          exitedPlan: true,
          newSession: "failed",
        },
        observedAt: base.occurredAt,
      },
    }),
  );
  assert.throws(() =>
    assertClientEvent({
      ...base,
      kind: "command.receipt",
      receipt: {
        requestId: "request-runtime-mirror",
        commandName: "runtime.settings.set",
        status: "completed",
        result: { key: "extendedContext", value: "yes", persisted: true },
        observedAt: base.occurredAt,
      },
    }),
  );
});

function image(data: string) {
  return { type: "image" as const, mimeType: "image/png" as const, data };
}

test("Desktop outbound accepts btw.changed snapshots carrying session/topic/question", () => {
  const base = {
    authorityEpoch: 1,
    runtimeEpoch: 1,
    stateVersion: 1,
    cursor: "1",
    occurredAt: "2026-08-23T00:00:00.000Z",
    kind: "btw.changed" as const,
    sessionId: "session-1",
    eventSeq: 1,
  };
  const eventWith = (snapshot: unknown) => ({ ...base, snapshot });
  const snapshot = {
    ephemeralId: "btw-1",
    status: "running" as const,
    text: "answer",
    sessionId: "session-1",
    topicId: "topic-1",
    question: "why",
  };
  assert.doesNotThrow(() => assertClientEvent(eventWith(snapshot)));
  const { sessionId: _sessionId, topicId: _topicId, question: _question, ...legacy } = snapshot;
  assert.doesNotThrow(() => assertClientEvent(eventWith(legacy)));
  assert.throws(() => assertClientEvent(eventWith({ ...snapshot, topicId: 42 })), ValidationError);
  assert.throws(() => assertClientEvent(eventWith({ ...snapshot, question: 42 })), ValidationError);
  assert.throws(() => assertClientEvent(eventWith({ ...snapshot, mystery: true })), ValidationError);
});

test("Desktop outbound applies canonical Base64 and image byte/count caps to editorImages", () => {
  const base = {
    authorityEpoch: 1,
    runtimeEpoch: 1,
    stateVersion: 1,
    cursor: "1",
    occurredAt: "2026-08-23T00:00:00.000Z",
    kind: "command.receipt" as const,
    receipt: {
      requestId: "request-editor-images",
      commandName: "session.tree.navigate" as const,
      status: "completed" as const,
      observedAt: "2026-08-23T00:00:00.000Z",
    },
  };
  const eventWith = (editorImages: unknown[]) => ({
    ...base,
    receipt: {
      ...base.receipt,
      result: { snapshot: SNAPSHOT, editorImages },
    },
  });
  assert.doesNotThrow(() => assertClientEvent(eventWith([image("AQID")])))
  assert.throws(() => assertClientEvent(eventWith([image("AR==")])), ValidationError);
  assert.throws(() => assertClientEvent(eventWith(Array.from({ length: MAX_PROMPT_IMAGES + 1 }, () => image("AQID")))), ValidationError);

  const maxImage = Buffer.alloc(MAX_PROMPT_IMAGE_BYTES).toString("base64");
  const maxImages = Array.from({ length: Math.floor(MAX_PROMPT_IMAGES_TOTAL_BYTES / MAX_PROMPT_IMAGE_BYTES) }, () => image(maxImage));
  assert.doesNotThrow(() => assertClientEvent(eventWith(maxImages)));
  assert.throws(() => assertClientEvent(eventWith([...maxImages, image("AQID")])), ValidationError);
});

test("media input grants cannot be forged through public Desktop commands", () => {
  const request = { commandName: "media.start", requestId: "media", idempotencyKey: "media", input: { sessionId: "s", request: { type: "image", prompt: "mock" } } };
  assert.doesNotThrow(() => parseClientCommandRequest(request));
  assert.throws(() => parseClientCommandRequest({ ...request, input: { ...request.input, inputTransfers: [] } }), ValidationError);
});
