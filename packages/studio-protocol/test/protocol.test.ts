import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ContractValidationError,
  FrameCodecError,
  FrameDecoder,
  canonicalJson,
  encodeFrame,
  parseFoundationStudioRequest,
  parseOperatorCommandManifest,
  parseStudioEventEnvelope,
  parseStudioHelloRequest,
  parseStudioHelloResponse,
  parseStudioReceipt,
  parseStudioSnapshotResponse,
  parseSessionTelemetryReadResult,
  parseSessionTelemetrySnapshot,
} from "../src/index.js";
import type { RuntimeEpoch } from "../src/contracts/ids.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

test("PR-001 parses the canonical hello fixture", async () => {
  const value: unknown = JSON.parse(await readFile(fixture("hello.request.json"), "utf8"));
  assert.equal(parseStudioHelloRequest(value).requiredProfile, "full-parity-v1");
});

test("evaluation operations validate nested targets and bounded media", () => {
  const base = { type: "studio.request", requestId: "eval", runtimeEpoch: 1 } as const;
  assert.throws(
    () => parseFoundationStudioRequest({ ...base, operation: { kind: "browser.evaluate", expression: "1", target: 42 } }),
    ContractValidationError,
  );
  assert.throws(
    () => parseFoundationStudioRequest({ ...base, operation: { kind: "terminal.image", result: { data: "bad!", mimeType: "image/png", encoding: "base64", source: "kitty" } } }),
    ContractValidationError,
  );
  assert.doesNotThrow(() => parseFoundationStudioRequest({ ...base, operation: { kind: "video.frame", attachmentId: "attachment://clip", timestampMs: 0 } }));
});

test("WP-011 parses the canonical hello response without inventing full parity", async () => {
  const value: unknown = JSON.parse(await readFile(fixture("hello.response.json"), "utf8"));
  const response = parseStudioHelloResponse(value);
  assert.equal(response.selectedProtocolVersion, 1);
  assert.equal(response.capabilityManifest.profile, "limited");
  assert.throws(() => parseStudioHelloResponse({ ...(value as object), token: "must-not-appear" }), ContractValidationError);
});

test("WP-011 rejects ambiguous protocol version offers", () => {
  const hello = {
    type: "studio.hello",
    requestId: "req-hello",
    supportedProtocolVersions: [1],
    requiredProfile: "full-parity-v1",
    challenge: "nonce",
  };
  assert.throws(
    () => parseStudioHelloRequest({ ...hello, supportedProtocolVersions: [1, 1] }),
    ContractValidationError,
  );
  assert.throws(
    () => parseStudioHelloRequest({ ...hello, supportedProtocolVersions: [0] }),
    ContractValidationError,
  );
});

test("WP-012 parses the canonical initial snapshot and fences nested epochs", async () => {
  const value: unknown = JSON.parse(await readFile(fixture("snapshot.initial.json"), "utf8"));
  const response = parseStudioSnapshotResponse(value);
  assert.equal(response.snapshot.runtimeEpoch, 1);
  assert.equal(response.snapshot.stateVersion, 0);
  assert.equal(response.lastEventSeq, 0);
  assert.throws(
    () =>
      parseStudioSnapshotResponse({
        ...(value as object),
        terminalReceipts: [
          {
            type: "studio.receipt",
            requestId: "request-old",
            runtimeEpoch: 0,
            stateVersion: 0,
            status: "completed",
          },
        ],
      }),
    ContractValidationError,
  );
  const snapshotValue = value as { snapshot: Record<string, unknown> };
  assert.throws(
    () =>
      parseStudioSnapshotResponse({
        ...snapshotValue,
        snapshot: {
          ...snapshotValue.snapshot,
          pendingInteraction: {
            owner: "gui",
            leaseGeneration: 0,
            request: {
              kind: "editor",
              interactionId: "interaction-1",
              commandId: "command-1",
              title: "Edit",
              content: "",
            },
          },
        },
      }),
    ContractValidationError,
  );
});

test("WP-012 accepts semantic session titles and rejects invalid title sources", async () => {
  const value: unknown = JSON.parse(await readFile(fixture("snapshot.initial.json"), "utf8"));
  const snapshotValue = value as { snapshot: Record<string, unknown> };
  const parsed = parseStudioSnapshotResponse({
    ...snapshotValue,
    snapshot: {
      ...snapshotValue.snapshot,
      sessionTitle: "Inspect runtime title projection",
      sessionTitleSource: "auto",
    },
  });
  assert.equal(parsed.snapshot.sessionTitle, "Inspect runtime title projection");
  assert.equal(parsed.snapshot.sessionTitleSource, "auto");
  assert.equal(parseStudioSnapshotResponse({
    ...snapshotValue,
    snapshot: { ...snapshotValue.snapshot, sessionTitle: "Legacy title" },
  }).snapshot.sessionTitle, "Legacy title");
  assert.throws(() => parseStudioSnapshotResponse({
    ...snapshotValue,
    snapshot: { ...snapshotValue.snapshot, sessionTitle: "Bad source", sessionTitleSource: "host" },
  }), ContractValidationError);
});

test("snapshot accepts optional fast and prewalk projections", async () => {
  const value = JSON.parse(await readFile(fixture("snapshot.initial.json"), "utf8")) as {
    snapshot: Record<string, unknown>;
  };
  const parsed = parseStudioSnapshotResponse({
    ...value,
    snapshot: {
      ...value.snapshot,
      fast: { enabled: true, active: false },
      prewalk: { status: "armed", target: "@smol" },
    },
  });
  assert.equal(parsed.snapshot.fast?.enabled, true);
  assert.equal(parsed.snapshot.fast?.active, false);
  assert.equal(parsed.snapshot.prewalk?.status, "armed");
  assert.equal(parsed.snapshot.prewalk?.target, "@smol");
  assert.throws(
    () =>
      parseStudioSnapshotResponse({
        ...value,
        snapshot: { ...value.snapshot, fast: { enabled: "yes" } },
      }),
    ContractValidationError,
  );
});

test("snapshot accepts optional session model projection", async () => {
  const value = JSON.parse(await readFile(fixture("snapshot.initial.json"), "utf8")) as {
    snapshot: Record<string, unknown>;
  };
  const parsed = parseStudioSnapshotResponse({
    ...value,
    snapshot: {
      ...value.snapshot,
      model: {
        selector: "anthropic/claude-sonnet-4-5",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        thinking: "high",
        configuredThinking: "auto",
      },
    },
  });
  assert.equal(parsed.snapshot.model?.selector, "anthropic/claude-sonnet-4-5");
  assert.equal(parsed.snapshot.model?.thinking, "high");
  assert.equal(parsed.snapshot.model?.configuredThinking, "auto");
  assert.throws(
    () =>
      parseStudioSnapshotResponse({
        ...value,
        snapshot: {
          ...value.snapshot,
          model: {
            selector: "anthropic/claude-sonnet-4-5",
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            thinking: "auto",
          },
        },
      }),
    ContractValidationError,
  );
});

test("Runtime settings and compaction projections mirror the closed Runtime seam", async () => {
  const value = JSON.parse(await readFile(fixture("snapshot.initial.json"), "utf8")) as {
    snapshot: Record<string, unknown>;
  };
  const runtimeSettings = {
    "edit.autoRepair.enabled": true,
    "features.unexpectedStopDetection": "smart",
    "providers.unexpectedStopModel": "online",
    extendedContext: false,
    "compaction.asyncEnabled": true,
    "compaction.methodOrder": ["remote", "snapcompact", "handoff", "shake", "soft"],
    "providers.openai-codex.codeMode": "auto",
  };
  const parsed = parseStudioSnapshotResponse({
    ...value,
    snapshot: { ...value.snapshot, runtimeSettings, compactionSpeculation: "armed" },
  });
  assert.equal(parsed.snapshot.runtimeSettings?.["features.unexpectedStopDetection"], "smart");
  assert.equal(parsed.snapshot.compactionSpeculation, "armed");

  const base = { type: "studio.request", requestId: "req-runtime-settings", runtimeEpoch: 1 };
  assert.equal(
    parseFoundationStudioRequest({ ...base, operation: { kind: "runtime.settings.get" } }).operation.kind,
    "runtime.settings.get",
  );
  assert.equal(
    parseFoundationStudioRequest({
      ...base,
      operation: {
        kind: "runtime.settings.get",
        keys: ["extendedContext", "compaction.methodOrder"],
      },
    }).operation.kind,
    "runtime.settings.get",
  );
  assert.equal(
    parseFoundationStudioRequest({
      ...base,
      operation: {
        kind: "runtime.settings.set",
        key: "compaction.methodOrder",
        value: ["remote", "soft"],
        persist: false,
      },
    }).operation.kind,
    "runtime.settings.set",
  );
  assert.equal(
    parseFoundationStudioRequest({
      ...base,
      operation: { kind: "mode.plan.review.saveAndQuit", path: ".\\plans\\plan.md" },
    }).operation.kind,
    "mode.plan.review.saveAndQuit",
  );

  const invalid = [
    { kind: "runtime.settings.get", keys: ["extendedContext", "extendedContext"] },
    { kind: "runtime.settings.get", keys: ["not-a-setting"] },
    { kind: "runtime.settings.set", key: "extendedContext", value: "yes", persist: false },
    { kind: "runtime.settings.set", key: "compaction.methodOrder", value: ["soft", "soft"], persist: true },
    { kind: "runtime.settings.set", key: "not-a-setting", value: true, persist: true },
    { kind: "mode.plan.review.saveAndQuit", path: "C:\\plans\\plan.md" },
    { kind: "mode.plan.review.saveAndQuit", path: "../plans/plan.md" },
    { kind: "mode.plan.review.saveAndQuit", path: "/plans/plan.md" },
    { kind: "mode.plan.review.saveAndQuit", path: "plans/plan.md/" },
    { kind: "mode.plan.review.saveAndQuit", path: " ../plans/plan.md" },
    { kind: "mode.plan.review.saveAndQuit", path: '"../plans/plan.md"' },
  ];
  for (const operation of invalid) {
    assert.throws(() => parseFoundationStudioRequest({ ...base, operation }), ContractValidationError);
  }
  assert.throws(
    () => parseStudioSnapshotResponse({ ...value, snapshot: { ...value.snapshot, runtimeSettings: { ...runtimeSettings, surprise: true } } }),
    ContractValidationError,
  );
  assert.throws(
    () => parseStudioSnapshotResponse({ ...value, snapshot: { ...value.snapshot, compactionSpeculation: "paused" } }),
    ContractValidationError,
  );
});

test("WP-012 validates state events against their envelope", async () => {
  const snapshot = parseStudioSnapshotResponse(
    JSON.parse(await readFile(fixture("snapshot.initial.json"), "utf8")) as unknown,
  ).snapshot;
  const event = {
    type: "studio.event",
    runtimeEpoch: 1,
    eventSeq: 1,
    stateVersion: 1,
    occurredAt: "2026-08-11T00:00:01.000Z",
    event: { kind: "state.changed", snapshot: { ...snapshot, stateVersion: 1 } },
  };
  assert.equal(parseStudioEventEnvelope(event).eventSeq, 1);
  assert.throws(
    () => parseStudioEventEnvelope({ ...event, event: { ...event.event, snapshot } }),
    ContractValidationError,
  );
});

test("plan review snapshot may carry title and body", async () => {
  const value = JSON.parse(await readFile(fixture("snapshot.initial.json"), "utf8")) as {
    snapshot: Record<string, unknown>;
  };
  const parsed = parseStudioSnapshotResponse({
    ...value,
    snapshot: {
      ...value.snapshot,
      activeMode: "plan",
      plan: {
        status: "review",
        planReference: "local://preview-plan.md",
        title: "Preview zoom inertia",
        body: "## Goal\n\nFreeze the protocol.",
      },
    },
  });
  assert.equal(parsed.snapshot.plan?.status, "review");
  assert.equal(parsed.snapshot.plan?.title, "Preview zoom inertia");
  assert.equal(parsed.snapshot.plan?.body, "## Goal\n\nFreeze the protocol.");
});

test("session telemetry events validate numeric usage and reject unsafe fields", () => {
  const telemetry = {
    sessionId: "session-1",
    capturedAt: "2026-08-15T12:00:00.000Z",
    tokens: { input: 10, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 0, total: 14, cost: 0.12 },
    lastCompletedTurn: {
      input: 10,
      output: 4,
      reasoning: 1,
      cacheRead: 2,
      cacheWrite: 0,
      total: 14,
      cost: 0.12,
      completedAt: "2026-08-15T11:59:00.000Z",
      durationMs: 9_500,
      tps: 35.4,
    },
    context: {
      contextWindow: 128000,
      usedTokens: 2400,
      percent: 1.875,
      anchored: true,
      systemPromptTokens: 100,
      systemContextTokens: 200,
      systemToolsTokens: 300,
      skillsTokens: 400,
      messagesTokens: 1400,
    },
  };
  const event = {
    type: "studio.event",
    runtimeEpoch: 1,
    eventSeq: 2,
    stateVersion: 0,
    occurredAt: "2026-08-15T12:00:00.000Z",
    event: { kind: "session.telemetry.changed", sessionId: "session-1", telemetry },
  };
  assert.equal((parseStudioEventEnvelope(event).event as { kind: string }).kind, "session.telemetry.changed");
  assert.throws(() => parseStudioEventEnvelope({ ...event, event: { ...event.event, telemetry: { ...telemetry, tokens: { ...telemetry.tokens, input: -1 } } } }), ContractValidationError);
  assert.throws(() => parseStudioEventEnvelope({ ...event, event: { ...event.event, telemetry: { ...telemetry, context: { ...telemetry.context, surprise: 1 } } } }), ContractValidationError);
});

test("btw.changed events validate the snapshot instead of accepting any JSON", () => {
  const snapshot = { ephemeralId: "ephemeral-1", status: "running", text: "partial answer" };
  const event = {
    type: "studio.event",
    runtimeEpoch: 1,
    eventSeq: 3,
    stateVersion: 0,
    occurredAt: "2026-08-15T12:00:00.000Z",
    event: { kind: "btw.changed", snapshot },
  };
  assert.equal((parseStudioEventEnvelope(event).event as { kind: string }).kind, "btw.changed");
  const completed = {
    ...snapshot,
    status: "completed",
    copy: "answer",
  };
  assert.equal(
    (parseStudioEventEnvelope({ ...event, event: { kind: "btw.changed", snapshot: completed } }).event as {
      snapshot: { status: string };
    }).snapshot.status,
    "completed",
  );
  const failed = {
    ...snapshot,
    status: "failed",
    error: { code: "OUTPUT_LIMIT", message: "answer exceeded the output limit" },
  };
  assert.equal(
    (parseStudioEventEnvelope({ ...event, event: { kind: "btw.changed", snapshot: failed } }).event as {
      snapshot: { error: { code: string } };
    }).snapshot.error.code,
    "OUTPUT_LIMIT",
  );
  for (const bad of [
    { ...snapshot, status: "pending" },
    { ...snapshot, ephemeralId: "" },
    { ...snapshot, text: 42 },
    { ...snapshot, surprise: true },
    { ...snapshot, error: { code: "TIMEOUT", message: "nope" } },
    { ...snapshot, error: { code: "INTERNAL_ERROR" } },
  ]) {
    assert.throws(
      () => parseStudioEventEnvelope({ ...event, event: { kind: "btw.changed", snapshot: bad } }),
      ContractValidationError,
    );
  }
});

test("telemetry turns validate optional rate fields and reject deviations", () => {
  const telemetry = {
    sessionId: "session-1",
    capturedAt: "2026-08-15T12:00:00.000Z",
    tokens: { input: 10, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 0, total: 14, cost: 0.12 },
    context: null,
  };
  const withRates = {
    ...telemetry,
    lastCompletedTurn: {
      input: 10,
      output: 450,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 460,
      cost: 0.02,
      completedAt: "2026-08-15T11:59:00.000Z",
      durationMs: 10_000,
      tps: 45,
    },
  };
  assert.equal(parseSessionTelemetrySnapshot(withRates).lastCompletedTurn?.tps, 45);
  assert.equal(parseSessionTelemetrySnapshot({ ...telemetry, lastCompletedTurn: undefined }).lastCompletedTurn, undefined);
  const turn = withRates.lastCompletedTurn;
  assert.throws(
    () => parseSessionTelemetrySnapshot({ ...withRates, lastCompletedTurn: { ...turn, tps: -1 } }),
    ContractValidationError,
  );
  assert.throws(
    () => parseSessionTelemetrySnapshot({ ...withRates, lastCompletedTurn: { ...turn, tps: Number.POSITIVE_INFINITY } }),
    ContractValidationError,
  );
  assert.throws(
    () => parseSessionTelemetrySnapshot({ ...withRates, lastCompletedTurn: { ...turn, durationMs: 10.5 } }),
    ContractValidationError,
  );
  assert.throws(
    () => parseSessionTelemetrySnapshot({ ...withRates, lastCompletedTurn: { ...turn, ttft: 120 } }),
    ContractValidationError,
  );
});

test("session telemetry snapshots accept the probe unavailable reason", () => {
  const telemetry = {
    sessionId: "session-1",
    capturedAt: "2026-08-15T12:00:00.000Z",
    tokens: { input: 10, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 0, total: 14, cost: 0.12 },
    context: null,
    unavailableReason: "probe_dynamic_context_disabled",
  };
  assert.equal(parseSessionTelemetrySnapshot(telemetry).unavailableReason, "probe_dynamic_context_disabled");
  assert.throws(
    () => parseSessionTelemetrySnapshot({ ...telemetry, unavailableReason: "made-up-reason" }),
    ContractValidationError,
  );
});

test("session telemetry read results validate source, semantics, and identity", () => {
  const telemetry = {
    sessionId: "session-1",
    capturedAt: "2026-08-15T12:00:00.000Z",
    tokens: { input: 10, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 0, total: 14, cost: 0.12 },
    context: {
      contextWindow: 128000,
      usedTokens: 2400,
      percent: 1.875,
      anchored: false,
      systemPromptTokens: 100,
      systemContextTokens: 200,
      systemToolsTokens: 300,
      skillsTokens: 400,
      messagesTokens: 1400,
    },
  };
  const result = { sessionId: "session-1", source: "archive-recomputed", semantics: "current-environment-recomputed", telemetry };
  assert.equal(parseSessionTelemetryReadResult(result).source, "archive-recomputed");
  assert.equal(parseSessionTelemetryReadResult({ ...result, source: "persisted", semantics: "last-observed" }).semantics, "last-observed");
  assert.equal(parseSessionTelemetryReadResult({ ...result, source: "live", semantics: "current-live" }).source, "live");
  assert.throws(() => parseSessionTelemetryReadResult({ ...result, source: "cached" }), ContractValidationError);
  assert.throws(() => parseSessionTelemetryReadResult({ ...result, semantics: "stale" }), ContractValidationError);
  assert.throws(() => parseSessionTelemetryReadResult({ ...result, extra: true }), ContractValidationError);
  assert.throws(
    () => parseSessionTelemetryReadResult({ ...result, sessionId: "session-2" }),
    ContractValidationError,
  );
  assert.throws(
    () => parseSessionTelemetryReadResult({ ...result, telemetry: { ...telemetry, tokens: { ...telemetry.tokens, input: Number.NaN } } }),
    ContractValidationError,
  );
});

test("WP-001 parses canonical request and receipt fixtures bidirectionally", async () => {
  const requestValue: unknown = JSON.parse(await readFile(fixture("request.pause.json"), "utf8"));
  const receiptValue: unknown = JSON.parse(await readFile(fixture("receipt.pause.accepted.json"), "utf8"));
  assert.equal(parseFoundationStudioRequest(requestValue).operation.kind, "runtime.pause");
  assert.equal(parseStudioReceipt(receiptValue).status, "accepted");
  assert.throws(() => parseStudioReceipt({ ...(receiptValue as object), unknown: true }), ContractValidationError);
});

test("WP-001 rejects unknown mutation fields", () => {
  assert.throws(
    () =>
      parseFoundationStudioRequest({
        type: "studio.request",
        requestId: "req-1",
        runtimeEpoch: 1,
        operation: { kind: "runtime.pause", surprise: true },
      }),
    ContractValidationError,
  );
});

test("WP-021/022/024/025 parses the canonical safe-operation fixtures", async () => {
  const cases = [
    ["request.enqueue.json", "queue.enqueue"],
    ["request.clearContext.json", "session.clearContext"],
    ["request.drop.json", "session.drop"],
    ["request.retry.json", "turn.retry"],
    ["request.prompt.json", "core.prompt"],
    ["request.steer.json", "core.steer"],
    ["request.followUp.json", "core.followUp"],
    ["request.abort.json", "core.abort"],
  ] as const;
  for (const [name, kind] of cases) {
    const value: unknown = JSON.parse(await readFile(fixture(name), "utf8"));
    assert.equal(parseFoundationStudioRequest(value).operation.kind, kind);
  }
});

test("WP-021/022/024/025 fail closed on invalid safe-operation arguments", () => {
  const base = { type: "studio.request", requestId: "req-x", runtimeEpoch: 1 };
  const cases = [
    { kind: "queue.enqueue" },
    { kind: "queue.enqueue", text: "" },
    { kind: "queue.enqueue", text: "x", extra: true },
    { kind: "session.clearContext", extra: true },
    { kind: "session.drop", extra: true },
    { kind: "turn.retry", extra: true },
    { kind: "core.prompt", text: "x", images: "not-an-array" },
    { kind: "core.prompt", text: "x", images: [null] },
    { kind: "core.prompt", text: "" },
    { kind: "core.steer", text: "x", extra: true },
    { kind: "core.followUp", images: [] },
    { kind: "core.abort", text: "x" },
  ];
  for (const operation of cases) {
    assert.throws(
      () => parseFoundationStudioRequest({ ...base, operation }),
      ContractValidationError,
    );
  }
});

test("WP-033 parses canonical loop requests and rejects ambiguous limits", async () => {
  const cases = [
    ["request.loop.enable.json", "loop.enable"],
    ["request.loop.pause.json", "loop.pause"],
    ["request.loop.disable.json", "loop.disable"],
  ] as const;
  for (const [name, kind] of cases) {
    const value: unknown = JSON.parse(await readFile(fixture(name), "utf8"));
    assert.equal(parseFoundationStudioRequest(value).operation.kind, kind);
  }

  const base = { type: "studio.request", requestId: "req-loop-invalid", runtimeEpoch: 1 };
  const invalid = [
    { kind: "loop.enable", prompt: "" },
    { kind: "loop.enable", limit: { turns: 0 } },
    { kind: "loop.enable", limit: { minutes: 1, turns: 1 } },
    { kind: "loop.enable", limit: { tokens: 1, extra: true } },
    { kind: "loop.pause", extra: true },
    { kind: "loop.disable", extra: true },
  ];
  for (const operation of invalid) {
    assert.throws(() => parseFoundationStudioRequest({ ...base, operation }), ContractValidationError);
  }
});

test("WP-030..035 validate Plan, Goal, Vibe, Tree, and Fork operations", () => {
  const base = { type: "studio.request", requestId: "req-m3", runtimeEpoch: 1 };
  const valid = [
    { kind: "mode.plan.enter", initialPrompt: "draft a plan" },
    { kind: "mode.plan.exit", discardDraft: true },
    { kind: "mode.plan.review.open" },
    { kind: "mode.plan.review.respond", decision: "refine", feedback: "add tests" },
    { kind: "mode.plan.review.respond", decision: "execute" },
    { kind: "mode.plan.review.respond", decision: "compact" },
    { kind: "mode.plan.review.respond", decision: "keep" },
    { kind: "mode.plan.review.respond", decision: "approve" },
    { kind: "mode.vibe.enter", initialPrompt: "delegate this" },
    { kind: "mode.vibe.exit" },
    { kind: "goal.create", objective: "ship", tokenBudget: 1000 },
    { kind: "goal.replace", objective: "ship safely" },
    { kind: "goal.show" },
    { kind: "goal.setBudget" },
    { kind: "goal.pause" },
    { kind: "goal.resume" },
    { kind: "goal.drop" },
    { kind: "goal.guided.start", initial: "ask me questions" },
    { kind: "session.tree.get" },
    { kind: "session.tree.navigate", targetId: "entry-1", summarize: true },
    { kind: "session.tree.branch", targetId: "entry-1" },
    { kind: "session.fork" },
    { kind: "session.handoff" },
    { kind: "session.handoff", customInstructions: "focus on the parser bug" },
    { kind: "session.fast.set", enabled: true },
    { kind: "session.prewalk.arm", target: "@smol" },
    { kind: "session.prewalk.disarm" },
    { kind: "session.model.set", selector: "anthropic/claude-sonnet-4-5" },
    { kind: "session.model.set", selector: "anthropic/claude-sonnet-4-5", thinking: "high" },
    { kind: "session.thinking.set", level: "auto" },
    { kind: "session.thinking.set", level: "off" },
  ];
  for (const operation of valid) {
    assert.equal(parseFoundationStudioRequest({ ...base, operation }).operation.kind, operation.kind);
  }

  const invalid = [
    { kind: "mode.plan.enter", initialPrompt: "" },
    { kind: "mode.plan.exit", discardDraft: "yes" },
    { kind: "mode.plan.review.respond", decision: "maybe" },
    { kind: "mode.vibe.exit", extra: true },
    { kind: "goal.create", objective: "" },
    { kind: "goal.replace", objective: "x", tokenBudget: 0 },
    { kind: "goal.setBudget", tokenBudget: -1 },
    { kind: "goal.guided.start", initial: "" },
    { kind: "session.tree.navigate", targetId: "" },
    { kind: "session.tree.navigate", targetId: "entry-1", summarize: "yes" },
    { kind: "session.tree.branch", targetId: "" },
    { kind: "session.tree.branch", targetId: "entry-1", extra: true },
    { kind: "session.fork", extra: true },
    { kind: "session.handoff", customInstructions: "" },
    { kind: "session.handoff", extra: true },
    { kind: "session.fast.set", enabled: "yes" },
    { kind: "session.prewalk.arm", target: "" },
    { kind: "session.prewalk.disarm", extra: true },
    { kind: "session.model.set", selector: "" },
    { kind: "session.model.set", selector: "anthropic/claude-sonnet-4-5", thinking: "inherit" },
    { kind: "session.thinking.set", level: "inherit" },
    { kind: "session.thinking.set", extra: true },
  ];
  for (const operation of invalid) {
    assert.throws(() => parseFoundationStudioRequest({ ...base, operation }), ContractValidationError);
  }
});

test("M4 parses canonical operator operation fixtures", async () => {
  const cases = [
    ["request.operator.manifest.get.json", "operator.manifest.get"],
    ["request.operator.invoke.json", "operator.invoke"],
  ] as const;
  for (const [name, kind] of cases) {
    const value: unknown = JSON.parse(await readFile(fixture(name), "utf8"));
    assert.equal(parseFoundationStudioRequest(value).operation.kind, kind);
  }
  const invokeValue: unknown = JSON.parse(await readFile(fixture("request.operator.invoke.json"), "utf8"));
  const invoke = parseFoundationStudioRequest(invokeValue).operation;
  assert.equal(invoke.kind, "operator.invoke");
  if (invoke.kind === "operator.invoke") {
    assert.equal(invoke.commandId, "builtin.help");
    assert.deepEqual(invoke.arguments, { args: "--short" });
  }
});

test("M4 validates the complete operator command manifest boundary", () => {
  const manifest = {
    generatedAt: "1970-01-01T00:00:00.000Z",
    upstreamCommit: "a".repeat(40),
    hash: "sha256:commands",
    commands: [{
      id: "builtin.help",
      name: "help",
      aliases: ["h"],
      description: "Show help",
      source: "builtin",
      implementation: "headless-handle",
      argumentSchema: { type: "string" },
      interactionKinds: [],
      presentation: "generic-form",
      availability: "available",
      risk: "normal",
      effect: "read",
      contractTestId: "CMD-BUILTIN-HELP",
    }],
    unclassifiedBuiltins: [],
  };
  assert.equal(parseOperatorCommandManifest(manifest).commands[0]?.id, "builtin.help");
  assert.throws(
    () => parseOperatorCommandManifest({ ...manifest, commands: [{ ...manifest.commands[0], source: "custom" }] }),
    ContractValidationError,
  );
  assert.throws(
    () => parseOperatorCommandManifest({ ...manifest, commands: [manifest.commands[0], manifest.commands[0]] }),
    ContractValidationError,
  );
});

test("M4 operator.invoke accepts JSON-safe arguments and omits arguments", () => {
  const base = { type: "studio.request", requestId: "req-operator-valid", runtimeEpoch: 1 };
  const valid = [
    { kind: "operator.invoke", commandId: "builtin.help" },
    { kind: "operator.invoke", commandId: "builtin.help", arguments: null },
    { kind: "operator.invoke", commandId: "builtin.help", arguments: "list --all" },
    { kind: "operator.invoke", commandId: "builtin.help", arguments: 42 },
    { kind: "operator.invoke", commandId: "builtin.help", arguments: true },
    { kind: "operator.invoke", commandId: "builtin.help", arguments: [1, "two", null, { nested: true }] },
    { kind: "operator.invoke", commandId: "builtin.help", arguments: { args: "--short" } },
  ];
  for (const operation of valid) {
    assert.equal(parseFoundationStudioRequest({ ...base, operation }).operation.kind, "operator.invoke");
  }
});

test("M4 operator operations fail closed on invalid shapes", () => {
  const base = { type: "studio.request", requestId: "req-operator-invalid", runtimeEpoch: 1 };
  const invalid = [
    { kind: "operator.manifest.get", extra: true },
    { kind: "operator.manifest.get", commandId: "builtin.help" },
    { kind: "operator.invoke" },
    { kind: "operator.invoke", commandId: "" },
    { kind: "operator.invoke", commandId: "builtin.help", extra: true },
    { kind: "operator.invoke", commandId: "x".repeat(1025) },
    { kind: "operator.invoke", commandId: "builtin.help", arguments: Number.NaN },
    { kind: "operator.invoke", commandId: "builtin.help", arguments: Number.POSITIVE_INFINITY },
    { kind: "operator.invoke", commandId: "builtin.help", arguments: () => undefined },
    { kind: "operator.invoke", commandId: "builtin.help", arguments: new Date() },
    { kind: "operator.invoke", commandId: "builtin.help", arguments: { args: undefined } },
  ];
  for (const operation of invalid) {
    assert.throws(() => parseFoundationStudioRequest({ ...base, operation }), ContractValidationError);
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () =>
      parseFoundationStudioRequest({
        ...base,
        operation: { kind: "operator.invoke", commandId: "builtin.help", arguments: cyclic },
      }),
    ContractValidationError,
  );
});

test("M4 receipts accept TERMINAL_REQUIRED and reject unknown error codes", () => {
  const base = {
    type: "studio.receipt",
    requestId: "req-operator-invoke-1",
    commandId: "builtin.help",
    runtimeEpoch: 1,
    stateVersion: 0,
    status: "failed",
    error: {
      code: "TERMINAL_REQUIRED",
      message: "/help requires the TUI",
      retryable: false,
    },
  };
  assert.equal(parseStudioReceipt(base).error?.code, "TERMINAL_REQUIRED");
  assert.throws(
    () => parseStudioReceipt({ ...base, error: { ...base.error, code: "NOT_A_CODE" } }),
    ContractValidationError,
  );
});

test("M4 parses interaction response and TUI transfer fixtures fail closed", async () => {
  for (const [name, kind] of [
    ["request.interaction.respond.json", "interaction.respond"],
    ["request.tui.transfer.json", "tui.transfer"],
  ] as const) {
    const value: unknown = JSON.parse(await readFile(fixture(name), "utf8"));
    assert.equal(parseFoundationStudioRequest(value).operation.kind, kind);
  }
  const base = { type: "studio.request", requestId: "req-m4-invalid", runtimeEpoch: 1 };
  for (const operation of [
    { kind: "interaction.respond", interactionId: "i", commandId: "c", decision: "maybe" },
    { kind: "interaction.respond", interactionId: "", commandId: "c", decision: "cancel" },
    { kind: "interaction.respond", interactionId: "i", commandId: "c", decision: "submit", value: undefined },
    { kind: "tui.transfer", commandId: "", interactionId: "i" },
    { kind: "tui.transfer", commandId: "c", extra: true },
  ]) {
    assert.throws(() => parseFoundationStudioRequest({ ...base, operation }), ContractValidationError);
  }
});

test("M4 validates interaction, progress, and notification events", () => {
  const envelope = (event: unknown) => ({
    type: "studio.event",
    runtimeEpoch: 1,
    eventSeq: 1,
    stateVersion: 0,
    occurredAt: "2026-08-12T00:00:00.000Z",
    event,
  });
	const eventKind = (event: unknown) => (parseStudioEventEnvelope(envelope(event)).event as { kind: string }).kind;
  assert.equal(
		eventKind({
				kind: "interaction.required",
        owner: "gui",
        leaseGeneration: 1,
        request: {
          kind: "confirm",
          interactionId: "interaction-1",
          commandId: "command-1",
          title: "Drop session",
          message: "Proceed?",
          destructive: true,
        },
			}),
		"interaction.required",
	);
	assert.equal(eventKind({ kind: "progress", commandId: "c", stage: "working", percent: 50 }), "progress");
	assert.equal(eventKind({ kind: "notify", severity: "warning", title: "Heads up" }), "notify");
	assert.equal(eventKind({ kind: "runtime.quiescing" }), "runtime.quiescing");
	assert.equal(eventKind({ kind: "runtime.shutdownComplete" }), "runtime.shutdownComplete");
  assert.throws(
    () => parseStudioEventEnvelope(envelope({ kind: "progress", commandId: "c", stage: "working", percent: 101 })),
    ContractValidationError,
  );
	assert.throws(
		() =>
			parseStudioEventEnvelope(
				envelope({
					kind: "interaction.resolved",
					interactionId: "interaction-1",
					commandId: "command-1",
					leaseGeneration: 0,
					outcome: "submitted",
				}),
			),
		ContractValidationError,
	);
  assert.throws(
    () =>
      parseStudioEventEnvelope(
        envelope({ kind: "interaction.required", owner: "gui", leaseGeneration: 1, request: { kind: "confirm" } }),
      ),
    ContractValidationError,
  );
	assert.throws(() => parseStudioEventEnvelope(envelope({ kind: "runtime.futureEvent" })), ContractValidationError);
});

test("interaction payloads are bounded at the Studio protocol boundary", () => {
  const envelope = (event: unknown) => ({
    type: "studio.event",
    runtimeEpoch: 1,
    eventSeq: 1,
    stateVersion: 0,
    occurredAt: "2026-08-12T00:00:00.000Z",
    event,
  });
  assert.throws(
    () =>
      parseStudioEventEnvelope(
        envelope({
          kind: "interaction.required",
          owner: "gui",
          leaseGeneration: 1,
          request: {
            kind: "confirm",
            interactionId: "interaction-1",
            commandId: "command-1",
            title: "x".repeat(4_097),
            message: "Proceed?",
          },
        }),
      ),
    ContractValidationError,
  );
  assert.throws(
    () =>
      parseStudioEventEnvelope(
        envelope({
          kind: "interaction.required",
          owner: "gui",
          leaseGeneration: 1,
          request: {
            kind: "select",
            interactionId: "interaction-1",
            commandId: "command-1",
            title: "Pick",
            options: Array.from({ length: 257 }, (_, index) => ({ id: `id-${index}`, label: "x" })),
          },
        }),
      ),
    ContractValidationError,
  );
  const emptyEditor = parseStudioEventEnvelope(
    envelope({
      kind: "interaction.required",
      owner: "gui",
      leaseGeneration: 1,
      request: {
        kind: "editor",
        interactionId: "interaction-1",
        commandId: "command-1",
        title: "Edit",
        content: "",
        language: "",
      },
    }),
  );
  assert.ok(emptyEditor !== undefined);
  const emptyOptionalText = parseStudioEventEnvelope(
    envelope({
      kind: "interaction.required",
      owner: "gui",
      leaseGeneration: 1,
      request: {
        kind: "select",
        interactionId: "interaction-1",
        commandId: "command-1",
        title: "Pick",
        options: [{ id: "one", label: "One", description: "" }],
      },
    }),
  );
  assert.ok(emptyOptionalText !== undefined);
  const askCard = parseStudioEventEnvelope(
    envelope({
      kind: "interaction.required",
      owner: "gui",
      leaseGeneration: 1,
      request: {
        kind: "ask",
        interactionId: "interaction-1",
        commandId: "command-1",
        title: "Agent 提问",
        questions: [
          {
            id: "inertia",
            question: "Need inertia?",
            header: "惯性",
            options: [
              { id: "option:0", label: "Yes", description: "coast", preview: "v *= 0.92" },
              { id: "option:1", label: "No" },
            ],
            recommended: 0,
          },
          {
            id: "default",
            question: "Default?",
            options: [{ id: "option:0", label: "On" }],
          },
        ],
      },
    }),
  );
  assert.ok(askCard !== undefined);
  assert.throws(
    () =>
      parseStudioEventEnvelope(
        envelope({
          kind: "interaction.required",
          owner: "gui",
          leaseGeneration: 1,
          request: {
            kind: "ask",
            interactionId: "interaction-1",
            commandId: "command-1",
            title: "Agent 提问",
            questions: [],
          },
        }),
      ),
    ContractValidationError,
  );
});

test("M4 validates BTW, TAN, and OMFG composite operations", () => {
  const base = { type: "studio.request", requestId: "req-composite", runtimeEpoch: 1 };
  for (const operation of [
    { kind: "btw.ask", question: "why?" },
    { kind: "btw.abort", ephemeralId: "ephemeral-1" },
    { kind: "btw.branch", branchToken: "opaque-token" },
    { kind: "tan.start", work: "review tests" },
    { kind: "omfg.generate", complaint: "avoid this mistake" },
    { kind: "omfg.amend", candidateId: "candidate-1", feedback: "be precise" },
    { kind: "omfg.commit", candidateId: "candidate-1", scope: "project", overwrite: false },
  ]) {
    assert.equal(parseFoundationStudioRequest({ ...base, operation }).operation.kind, operation.kind);
  }
  for (const operation of [
    { kind: "btw.ask", question: "" },
    { kind: "btw.branch", branchToken: "", extra: true },
    { kind: "tan.start", work: "" },
    { kind: "omfg.amend", candidateId: "candidate-1", feedback: "" },
    { kind: "omfg.commit", candidateId: "candidate-1", scope: "machine", overwrite: false },
    { kind: "omfg.commit", candidateId: "candidate-1", scope: "user", overwrite: "yes" },
  ]) {
    assert.throws(() => parseFoundationStudioRequest({ ...base, operation }), ContractValidationError);
  }
});

test("M5 validates Agent Hub and Job operations at the trust boundary", () => {
  const base = { type: "studio.request", requestId: "req-m5", runtimeEpoch: 1 };
  for (const operation of [
    { kind: "agent.list", includeTerminal: true, includePersisted: true },
    { kind: "agent.get", agentId: "Child-1" },
    {
      kind: "agent.spawn",
      definition: "researcher",
      assignment: "audit the implementation",
      context: "backend only",
      async: true,
      isolation: "patch",
      effort: "hi",
    },
    { kind: "agent.send", agentId: "Child-1", expectedGeneration: 1, text: "continue", mode: "steer" },
    {
      kind: "agent.send",
      agentId: "Child-1",
      expectedGeneration: 1,
      text: "[图1]",
      mode: "prompt",
      images: [{ type: "image", mimeType: "image/png", data: "abc" }],
    },
    { kind: "agent.kill", agentId: "Child-1", expectedGeneration: 1 },
    { kind: "agent.revive", agentId: "Child-1", expectedGeneration: 2 },
    { kind: "agent.release", agentId: "Child-1", expectedGeneration: 3 },
    { kind: "agent.transcript.read", agentId: "Child-1", cursor: "opaque", limit: 100 },
    { kind: "agent.conversation.read", agentId: "Child-1", cursor: "opaque", limit: 100 },
    { kind: "agent.subscribe", level: "events" },
    { kind: "job.list", ownerAgentId: "Main", includeRecent: true },
    { kind: "job.get", jobId: "job-1" },
    { kind: "job.cancel", jobId: "job-1", expectedGeneration: 1 },
    { kind: "job.subscribe" },
  ]) {
    assert.equal(parseFoundationStudioRequest({ ...base, operation }).operation.kind, operation.kind);
  }

  for (const operation of [
    { kind: "agent.list", includeTerminal: "yes" },
    { kind: "agent.get", agentId: "" },
    { kind: "agent.spawn", definition: "researcher", assignment: "audit", isolation: "none" },
    { kind: "agent.spawn", definition: "researcher", assignment: "audit", effort: "high" },
    { kind: "agent.send", agentId: "Child-1", expectedGeneration: 0, text: "continue", mode: "prompt" },
    { kind: "agent.send", agentId: "Child-1", expectedGeneration: 1, text: "continue", mode: "broadcast" },
    { kind: "agent.send", agentId: "Child-1", expectedGeneration: 1, text: "continue", mode: "prompt", images: [null] },
    { kind: "agent.kill", agentId: "Child-1", expectedGeneration: 1, force: true },
    { kind: "agent.transcript.read", agentId: "Child-1", limit: 101 },
    { kind: "agent.conversation.read", agentId: "Child-1", limit: 101 },
    { kind: "agent.subscribe", level: "all" },
    { kind: "job.list", includeRecent: "yes" },
    { kind: "job.cancel", jobId: "job-1", expectedGeneration: 0 },
    { kind: "job.subscribe", extra: true },
  ]) {
    assert.throws(() => parseFoundationStudioRequest({ ...base, operation }), ContractValidationError);
  }
});

test("WP-060 validates Live control operations without claiming a media device", () => {
  const base = { type: "studio.request", requestId: "request-live", runtimeEpoch: 1 };
  const start = { ...base, operation: { kind: "live.start", deviceId: "default-microphone" } };
  const stop = { ...base, requestId: "request-live-stop", operation: { kind: "live.stop" } };
  assert.equal(parseFoundationStudioRequest(start).operation.kind, "live.start");
  assert.equal(parseFoundationStudioRequest(stop).operation.kind, "live.stop");
  assert.throws(
    () => parseFoundationStudioRequest({ ...base, operation: { kind: "live.start", deviceId: "" } }),
    ContractValidationError,
  );
  assert.throws(
    () => parseFoundationStudioRequest({ ...base, operation: { kind: "live.stop", deviceId: "invalid" } }),
    ContractValidationError,
  );
});

test("canonical JSON is stable across key order", () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"z":1}');
});

test("frame codec handles chunking and validates the body length", () => {
  const body = { type: "studio.event", event: { kind: "runtime.ready" } };
  const encoded = encodeFrame("frame-1", 1 as RuntimeEpoch, body);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 5)), []);
  const [decoded] = decoder.push(encoded.subarray(5));
  assert.deepEqual(decoded?.body, body);
});

test("PR-008 rejects an oversized frame before payload allocation", () => {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(1025);
  assert.throws(() => new FrameDecoder(1024).push(prefix), FrameCodecError);
});

test("malformed frames poison the decoder and cannot accumulate more bytes", () => {
  const malformed = Buffer.alloc(8);
  malformed.writeUInt32BE(4, 0);
  malformed.writeUInt32BE(0, 4);
  const decoder = new FrameDecoder();
  assert.throws(() => decoder.push(malformed), FrameCodecError);
  assert.throws(() => decoder.push(Buffer.alloc(1024)), /closed after a protocol error/u);
});

test("encode rejects an oversized frame", () => {
  assert.throws(() => encodeFrame("frame-large", 1 as RuntimeEpoch, { value: "x".repeat(1024) }, 128), FrameCodecError);
});

test("decoder consumes a large multi-frame chunk without retaining its backing buffer", () => {
  const encoded = encodeFrame("frame-many", 1 as RuntimeEpoch, { ok: true });
  const largeChunk = Buffer.concat(Array.from({ length: 2048 }, () => encoded));
  const decoder = new FrameDecoder();
  assert.equal(decoder.push(largeChunk).length, 2048);
  assert.deepEqual(decoder.push(encodeFrame("frame-next", 1 as RuntimeEpoch, { next: true }))[0]?.body, {
    next: true,
  });
});
