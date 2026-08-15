/**
 * P1 Desktop IPC boundary security tests (FRONTEND_INTEGRATION.md §9).
 *
 * These tests defend the strict-validation contract at the Main boundary:
 * a closed, fixed channel set (no generic invoke), envelope parsers that
 * fail closed on unknown fields / identity smuggling / prototype
 * pollution, per-name input validation for every query/command/scope, and
 * outbound assertions that keep malformed Host output away from the
 * Renderer. All code under test is pure, browser/Node-neutral ECMAScript —
 * no Electron, no display, no timers.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  COMMAND_NAMES,
  DESKTOP_IPC_CHANNELS,
  MAX_HISTORY_LIMIT,
  MAX_ID_LENGTH,
  MAX_LIST_ITEMS,
  MAX_TEXT_LENGTH,
  MAX_VALUE_DEPTH,
  QUERY_NAMES,
  ValidationError,
  assertClientCommandAccepted,
  assertClientEvent,
  assertClientQueryResponse,
  createDesktopTransport,
  parseClientCommandRequest,
  parseClientQueryRequest,
  parseSubscriptionScope,
  type DesktopIpcChannel,
  type OmpStudioDesktopApi,
} from "../src/index.js";
import { CONVERSATION_LIMITS } from "@omp-studio/client-contract";

/** Envelope fixtures that must always validate (P1 contract shapes). */
const QUERY_ENVELOPES: ReadonlyArray<{
  name: string;
  payload: unknown;
}> = [
  { name: "environment.get", payload: { queryName: "environment.get", input: {} } },
  { name: "capabilities.get", payload: { queryName: "capabilities.get", input: {} } },
  { name: "commands.getManifest", payload: { queryName: "commands.getManifest", input: {} } },
  { name: "diagnostics.get", payload: { queryName: "diagnostics.get", input: {} } },
  { name: "history.list", payload: { queryName: "history.list", input: { limit: 50 } } },
  { name: "session.state", payload: { queryName: "session.state", input: {} } },
  { name: "home.get", payload: { queryName: "home.get", input: {} } },
  { name: "models.get", payload: { queryName: "models.get", input: {} } },
  { name: "skills.get", payload: { queryName: "skills.get", input: {} } },
  { name: "mcp.get", payload: { queryName: "mcp.get", input: {} } },
  { name: "agents.definitions.get", payload: { queryName: "agents.definitions.get", input: {} } },
  { name: "projects.list", payload: { queryName: "projects.list", input: {} } },
  { name: "usage.get", payload: { queryName: "usage.get", input: {} } },
  { name: "session.transcript.read", payload: { queryName: "session.transcript.read", input: { limit: 50 } } },
  {
    name: "session.transcript.readPage",
    payload: {
      queryName: "session.transcript.readPage",
      input: { sessionId: "session-1", limit: 50 },
    },
  },
];

const COMMAND_ENVELOPES: ReadonlyArray<{
  name: string;
  payload: unknown;
}> = [
  { name: "core.prompt", payload: { commandName: "core.prompt", input: { text: "hello" }, idempotencyKey: "idem-core-1", requestId: "req-core-1" } },
  { name: "core.steer", payload: { commandName: "core.steer", input: { text: "steer" }, idempotencyKey: "idem-core-2", requestId: "req-core-2" } },
  { name: "core.followUp", payload: { commandName: "core.followUp", input: { text: "follow up" }, idempotencyKey: "idem-core-3", requestId: "req-core-3" } },
  { name: "core.abort", payload: { commandName: "core.abort", input: {}, idempotencyKey: "idem-core-4", requestId: "req-core-4" } },
  { name: "queue.enqueue", payload: { commandName: "queue.enqueue", input: { text: "queued" }, idempotencyKey: "idem-core-5", requestId: "req-core-5" } },
  { name: "runtime.pause", payload: { commandName: "runtime.pause", input: {}, idempotencyKey: "idem-core-6", requestId: "req-core-6" } },
  { name: "runtime.resume", payload: { commandName: "runtime.resume", input: { expectedPauseEpoch: 0 }, idempotencyKey: "idem-core-7", requestId: "req-core-7" } },
  { name: "turn.retry", payload: { commandName: "turn.retry", input: {}, idempotencyKey: "idem-core-8", requestId: "req-core-8" } },
  {
    name: "runtime.install",
    payload: {
      commandName: "runtime.install",
      input: { channel: "stable" },
      idempotencyKey: "idem-1",
      requestId: "req-1",
    },
  },
  {
    name: "session.resume",
    payload: {
      commandName: "session.resume",
      input: { threadId: "thread-1" },
      idempotencyKey: "idem-2",
      requestId: "req-2",
    },
  },
  {
    name: "session.drop",
    payload: {
      commandName: "session.drop",
      input: { threadId: "thread-1" },
      idempotencyKey: "idem-3",
      requestId: "req-3",
    },
  },
  {
    name: "interaction.respond",
    payload: {
      commandName: "interaction.respond",
      input: { interactionId: "interaction-1", decision: "submit", value: "ok" },
      idempotencyKey: "idem-4",
      requestId: "req-4",
    },
  },
  {
    name: "models.provider.upsert",
    payload: {
      commandName: "models.provider.upsert",
      input: { id: "acme", name: "Acme", api: "openai-completions", auth: { type: "api-key" } },
      idempotencyKey: "idem-models-1",
      requestId: "req-models-1",
    },
  },
  {
    name: "models.provider.delete",
    payload: {
      commandName: "models.provider.delete",
      input: { id: "acme" },
      idempotencyKey: "idem-models-2",
      requestId: "req-models-2",
    },
  },
  {
    name: "models.roles.set",
    payload: {
      commandName: "models.roles.set",
      input: { roleId: "default", selector: "acme/fast" },
      idempotencyKey: "idem-models-3",
      requestId: "req-models-3",
    },
  },
  {
    name: "models.provider.setEnabled",
    payload: {
      commandName: "models.provider.setEnabled",
      input: { id: "acme", enabled: false },
      idempotencyKey: "idem-models-enabled-1",
      requestId: "req-models-enabled-1",
    },
  },
  {
    name: "models.roles.write",
    payload: {
      commandName: "models.roles.write",
      input: { roles: { default: "acme/fast" } },
      idempotencyKey: "idem-models-write-1",
      requestId: "req-models-write-1",
    },
  },
  {
    name: "models.roles.create",
    payload: {
      commandName: "models.roles.create",
      input: { id: "review", name: "Review" },
      idempotencyKey: "idem-models-create-1",
      requestId: "req-models-create-1",
    },
  },
  {
    name: "models.roles.delete",
    payload: {
      commandName: "models.roles.delete",
      input: { roleId: "review" },
      idempotencyKey: "idem-models-delete-role-1",
      requestId: "req-models-delete-role-1",
    },
  },
  {
    name: "models.roleStorage.set",
    payload: {
      commandName: "models.roleStorage.set",
      input: { storage: "global" },
      idempotencyKey: "idem-models-storage-1",
      requestId: "req-models-storage-1",
    },
  },
  {
    name: "models.fallback.set",
    payload: {
      commandName: "models.fallback.set",
      input: { chains: { "acme/fast": ["acme/slow"] }, revertPolicy: "never" },
      idempotencyKey: "idem-models-fallback-1",
      requestId: "req-models-fallback-1",
    },
  },
  {
    name: "models.providerOrder.set",
    payload: {
      commandName: "models.providerOrder.set",
      input: { order: ["acme", "openai"] },
      idempotencyKey: "idem-models-order-1",
      requestId: "req-models-order-1",
    },
  },
  {
    name: "models.login.logout",
    payload: {
      commandName: "models.login.logout",
      input: { providerId: "anthropic" },
      idempotencyKey: "idem-models-logout-1",
      requestId: "req-models-logout-1",
    },
  },
  {
    name: "models.provider.probe",
    payload: {
      commandName: "models.provider.probe",
      input: { providerId: "ollama" },
      idempotencyKey: "idem-models-probe-1",
      requestId: "req-models-probe-1",
    },
  },
  {
    name: "models.discovery.refresh",
    payload: {
      commandName: "models.discovery.refresh",
      input: {},
      idempotencyKey: "idem-models-refresh-1",
      requestId: "req-models-refresh-1",
    },
  },
  {
    name: "models.yml.write",
    payload: {
      commandName: "models.yml.write",
      input: { text: "providers: {}\n" },
      idempotencyKey: "idem-models-yml-1",
      requestId: "req-models-yml-1",
    },
  },
  {
    name: "models.login.start",
    payload: {
      commandName: "models.login.start",
      input: { providerId: "anthropic" },
      idempotencyKey: "idem-models-4",
      requestId: "req-models-4",
    },
  },
  {
    name: "workspace.open",
    payload: {
      commandName: "workspace.open",
      input: { workspaceId: "ws-0001" },
      idempotencyKey: "idem-ws-1",
      requestId: "req-ws-1",
    },
  },
  {
    name: "workspace.pick",
    payload: {
      commandName: "workspace.pick",
      input: {},
      idempotencyKey: "idem-ws-2",
      requestId: "req-ws-2",
    },
  },
  {
    name: "usage.openDashboard",
    payload: {
      commandName: "usage.openDashboard",
      input: {},
      idempotencyKey: "idem-usage-1",
      requestId: "req-usage-1",
    },
  },
  {
    name: "plugins.setEnabled",
    payload: {
      commandName: "plugins.setEnabled",
      input: { name: "demo-plugin", enabled: false, scope: "user" },
      idempotencyKey: "idem-plugins-1",
      requestId: "req-plugins-1",
    },
  },
  {
    name: "skills.setEnabled",
    payload: {
      commandName: "skills.setEnabled",
      input: { name: "upstream-sync", enabled: true },
      idempotencyKey: "idem-skills-1",
      requestId: "req-skills-1",
    },
  },
  {
    name: "mcp.setEnabled",
    payload: {
      commandName: "mcp.setEnabled",
      input: { name: "filesystem", enabled: false, scope: "user" },
      idempotencyKey: "idem-mcp-1",
      requestId: "req-mcp-1",
    },
  },
  {
    name: "agents.definition.upsert",
    payload: {
      commandName: "agents.definition.upsert",
      input: {
        name: "reviewer",
        description: "Use this agent when reviewing code",
        systemPrompt: "Review the diff.",
        scope: "user",
      },
      idempotencyKey: "idem-agents-1",
      requestId: "req-agents-1",
    },
  },
  {
    name: "agents.definition.delete",
    payload: {
      commandName: "agents.definition.delete",
      input: { name: "reviewer", scope: "user" },
      idempotencyKey: "idem-agents-2",
      requestId: "req-agents-2",
    },
  },
  {
    name: "agents.definition.configure",
    payload: {
      commandName: "agents.definition.configure",
      input: { name: "scout", disabled: true },
      idempotencyKey: "idem-agents-3",
      requestId: "req-agents-3",
    },
  },
];

/** Assert `fn` throws a {@link ValidationError}; returns the message. */
function expectValidationError(fn: () => unknown): string {
  assert.throws(fn, ValidationError);
  let message = "";
  try {
    fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  return message;
}

describe("DESKTOP_IPC_CHANNELS: closed fixed channel set", () => {
  test("exposes exactly the six named channels and nothing else", () => {
    const channels = Object.values(DESKTOP_IPC_CHANNELS);
    assert.equal(channels.length, 6);
    assert.equal(new Set(channels).size, 6, "channel names must be unique");
    for (const channel of channels) {
      assert.equal(typeof channel, "string");
      assert.ok(channel.length > 0);
    }
    const expected = new Set([
      "omp-studio:desktop:bootstrap",
      "omp-studio:desktop:query",
      "omp-studio:desktop:command",
      "omp-studio:desktop:subscribe",
      "omp-studio:desktop:event",
      "omp-studio:desktop:close",
    ]);
    assert.deepEqual(new Set(channels), expected);
  });

  test("the channel table is frozen and every name is namespaced", () => {
    assert.ok(Object.isFrozen(DESKTOP_IPC_CHANNELS));
    const names = Object.values(DESKTOP_IPC_CHANNELS);
    for (const name of names) {
      assert.ok(name.startsWith("omp-studio:desktop:"), `unexpected channel ${name}`);
      assert.ok(!name.includes("*"), "no wildcard/generic channels");
      assert.equal(name.split(":").length, 3, "exactly omp-studio:desktop:<method>");
    }
  });

  test("the DesktopIpcChannel union covers exactly the constant values", () => {
    const values = Object.values(DESKTOP_IPC_CHANNELS);
    const union: readonly DesktopIpcChannel[] = values;
    assert.equal(union.length, values.length);
  });

  test("no generic invoke surface: an api exposing invoke(channel, payload) is rejected", () => {
    const genericApi = {
      invoke: async (_channel: string, _payload: unknown): Promise<unknown> => undefined,
      bootstrap: async () => ({}),
    } as unknown as OmpStudioDesktopApi;
    assert.throws(() => createDesktopTransport(genericApi), TypeError);
  });
});

describe("parseClientQueryRequest: envelope strictness", () => {
  test("validates every contract query name with its exact input shape", () => {
    assert.deepEqual(QUERY_NAMES, [
      "environment.get",
      "capabilities.get",
      "commands.getManifest",
      "diagnostics.get",
      "history.list",
      "session.state",
      "home.get",
      "models.get",
      "skills.get",
      "mcp.get",
      "agents.definitions.get",
      "projects.list",
      "usage.get",
      "session.transcript.read",
      "session.transcript.readPage",
    ]);
    for (const { name, payload } of QUERY_ENVELOPES) {
      const parsed = parseClientQueryRequest(payload);
      assert.equal(parsed.queryName, name);
      assert.ok("input" in parsed, "parsed envelope must carry exactly queryName + input");
      assert.equal(Object.keys(parsed).length, 2);
    }
    assert.deepEqual(parseClientQueryRequest({ queryName: "history.list", input: {} }).queryName, "history.list");
  });

  test("rejects an unknown queryName", () => {
    const message = expectValidationError(() =>
      parseClientQueryRequest({ queryName: "telemetry.get", input: {} }),
    );
    assert.match(message, /unknown queryName/);
  });

  test("rejects envelope-level identity/authority fields (windowId, authority, sender)", () => {
    for (const extra of [
      { windowId: 7 },
      { webContentsId: 7 },
      { authority: "A" },
      { sender: "renderer" },
      { sessionPath: "C:\\sessions\\1" },
      { pid: 1234 },
    ]) {
      const message = expectValidationError(() =>
        parseClientQueryRequest({ queryName: "home.get", input: {}, ...extra }),
      );
      assert.match(message, /unknown field/);
    }
  });

  test("rejects non-object, array, null and string payloads", () => {
    for (const payload of [null, undefined, "query", 42, ["environment.get"]]) {
      expectValidationError(() => parseClientQueryRequest(payload));
    }
  });

  test("rejects a non-string queryName and a missing input", () => {
    expectValidationError(() => parseClientQueryRequest({ queryName: 42, input: {} }));
    expectValidationError(() => parseClientQueryRequest({ queryName: "home.get" }));
  });

  test("rejects extra input fields on empty-input queries", () => {
    const message = expectValidationError(() =>
      parseClientQueryRequest({ queryName: "environment.get", input: { locale: "en" } }),
    );
    assert.match(message, /unknown field/);
  });

  test("history.list rejects a malformed or oversized limit", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, "10", MAX_HISTORY_LIMIT + 1]) {
      const message = expectValidationError(() =>
        parseClientQueryRequest({ queryName: "history.list", input: { limit } }),
      );
      assert.match(message, /limit/);
    }
    const ok = parseClientQueryRequest({
      queryName: "history.list",
      input: { limit: MAX_HISTORY_LIMIT },
    });
    assert.equal(ok.queryName, "history.list");
  });

  test("session.transcript.read rejects extra keys, bad limits, and oversized cursors", () => {
    expectValidationError(() =>
      parseClientQueryRequest({ queryName: "session.transcript.read", input: { extra: true } }),
    );
    expectValidationError(() =>
      parseClientQueryRequest({ queryName: "session.transcript.read", input: { limit: 0 } }),
    );
    expectValidationError(() =>
      parseClientQueryRequest({ queryName: "session.transcript.read", input: { limit: 101 } }),
    );
    expectValidationError(() =>
      parseClientQueryRequest({
        queryName: "session.transcript.read",
        input: { cursor: "x".repeat(CONVERSATION_LIMITS.CURSOR_MAX_CHARS + 1) },
      }),
    );
    const ok = parseClientQueryRequest({
      queryName: "session.transcript.read",
      input: { cursor: "opaque-older", limit: 50 },
    });
    assert.equal(ok.queryName, "session.transcript.read");
  });

  test("session.transcript.readPage requires an explicit session and validates pagination", () => {
    for (const input of [
      {},
      { sessionId: "" },
      { sessionId: " " },
      { sessionId: "x".repeat(MAX_ID_LENGTH + 1) },
      { sessionId: "session-1", extra: true },
      { sessionId: "session-1", cursor: "" },
      {
        sessionId: "session-1",
        cursor: "x".repeat(CONVERSATION_LIMITS.CURSOR_MAX_CHARS + 1),
      },
      { sessionId: "session-1", limit: 0 },
      { sessionId: "session-1", limit: CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX + 1 },
    ]) {
      expectValidationError(() =>
        parseClientQueryRequest({ queryName: "session.transcript.readPage", input }),
      );
    }
    const ok = parseClientQueryRequest({
      queryName: "session.transcript.readPage",
      input: { sessionId: "session-1", cursor: "opaque-older", limit: 50 },
    });
    assert.equal(ok.queryName, "session.transcript.readPage");
  });
});

describe("parseClientQueryRequest: prototype pollution fails closed", () => {
  test("an own __proto__ key inside the envelope is rejected", () => {
    const payload = JSON.parse(
      '{"queryName":"environment.get","input":{},"__proto__":{"polluted":true}}',
    );
    const message = expectValidationError(() => parseClientQueryRequest(payload));
    assert.match(message, /unknown field "__proto__"/);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  });

  test("an own __proto__ key inside the input is rejected", () => {
    const payload = JSON.parse('{"queryName":"environment.get","input":{"__proto__":{"x":1}}}');
    const message = expectValidationError(() => parseClientQueryRequest(payload));
    assert.match(message, /unknown field "__proto__"/);
    assert.equal(({} as Record<string, unknown>).x, undefined);
  });

  test("constructor and prototype keys are rejected like any unknown field", () => {
    for (const key of ["constructor", "prototype"]) {
      const payload = JSON.parse(`{"queryName":"home.get","input":{},"${key}":{"x":1}}`);
      expectValidationError(() => parseClientQueryRequest(payload));
    }
  });
});

describe("parseClientCommandRequest: envelope strictness", () => {
  test("validates every contract command name with its exact input shape", () => {
    assert.deepEqual(COMMAND_NAMES, [
      "core.prompt",
      "core.steer",
      "core.followUp",
      "core.abort",
      "queue.enqueue",
      "runtime.pause",
      "runtime.resume",
      "turn.retry",
      "mode.plan.enter",
      "mode.plan.exit",
      "mode.plan.review.open",
      "mode.plan.review.respond",
      "mode.vibe.enter",
      "mode.vibe.exit",
      "goal.create",
      "goal.replace",
      "goal.show",
      "goal.setBudget",
      "goal.pause",
      "goal.resume",
      "goal.drop",
      "goal.guided.start",
      "loop.enable",
      "loop.pause",
      "loop.disable",
      "session.fork",
      "session.tree.get",
      "session.tree.navigate",
      "operator.invoke",
      "runtime.install",
      "session.resume",
      "session.drop",
      "interaction.respond",
      "models.provider.upsert",
      "models.provider.delete",
      "models.provider.setEnabled",
      "models.roles.set",
      "models.roles.write",
      "models.roles.create",
      "models.roles.delete",
      "models.roleStorage.set",
      "models.fallback.set",
      "models.providerOrder.set",
      "models.yml.write",
      "models.login.start",
      "models.login.logout",
      "models.provider.test",
      "models.provider.probe",
      "models.discovery.refresh",
      "models.cycleOrder.set",
      "plugins.setEnabled",
      "skills.setEnabled",
      "mcp.setEnabled",
      "agents.definition.upsert",
      "agents.definition.delete",
      "agents.definition.configure",
      "workspace.open",
      "workspace.pick",
      "usage.openDashboard",
    ]);
    for (const { name, payload } of COMMAND_ENVELOPES) {
      const parsed = parseClientCommandRequest(payload);
      assert.equal(parsed.commandName, name);
      assert.ok(parsed.requestId.length > 0);
      assert.ok(parsed.idempotencyKey.length > 0);
      assert.ok("input" in parsed);
    }
  });

  test("accepts empty models.roles.set selector and empty probe endpointUrl", () => {
    const cleared = parseClientCommandRequest({
      commandName: "models.roles.set",
      input: { roleId: "default", selector: "" },
      idempotencyKey: "idem-models-clear-1",
      requestId: "req-models-clear-1",
    });
    assert.equal(cleared.commandName, "models.roles.set");
    const probe = parseClientCommandRequest({
      commandName: "models.provider.probe",
      input: { providerId: "ollama", endpointUrl: "" },
      idempotencyKey: "idem-models-probe-empty-1",
      requestId: "req-models-probe-empty-1",
    });
    assert.equal(probe.commandName, "models.provider.probe");
  });

  test("accepts models.provider.upsert thinking efforts and rejects unknown ids", () => {
    const parsed = parseClientCommandRequest({
      commandName: "models.provider.upsert",
      input: {
        id: "acme",
        name: "Acme",
        api: "openai-completions",
        auth: { type: "api-key" },
        models: [{ id: "custom-1", reasoning: true, thinking: ["off", "low", "max"] }],
        modelOverrides: { "catalog-1": { reasoning: true, thinking: ["high", "xhigh"] } },
      },
      idempotencyKey: "idem-models-thinking-1",
      requestId: "req-models-thinking-1",
    });
    assert.equal(parsed.commandName, "models.provider.upsert");
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "models.provider.upsert",
        input: {
          id: "acme",
          name: "Acme",
          api: "openai-completions",
          auth: { type: "api-key" },
          models: [{ id: "custom-1", thinking: ["minimal"] }],
        },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
  });

  test("rejects an unknown commandName and identity-smuggling fields", () => {
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "system.exec",
        input: {},
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    const message = expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "session.drop",
        input: { threadId: "t" },
        idempotencyKey: "k",
        requestId: "r",
        windowId: 1,
      }),
    );
    assert.match(message, /unknown field "windowId"/);
  });

  test("rejects missing, blank, or oversized requestId/idempotencyKey", () => {
    const base = {
      commandName: "session.drop",
      input: { threadId: "t" },
      idempotencyKey: "k",
      requestId: "r",
    };
    expectValidationError(() =>
      parseClientCommandRequest({ ...base, requestId: undefined }),
    );
    expectValidationError(() => parseClientCommandRequest({ ...base, requestId: "   " }));
    expectValidationError(() => parseClientCommandRequest({ ...base, idempotencyKey: "" }));
    expectValidationError(() =>
      parseClientCommandRequest({ ...base, requestId: "x".repeat(MAX_ID_LENGTH + 1) }),
    );
    const ok = parseClientCommandRequest({
      ...base,
      requestId: "x".repeat(MAX_ID_LENGTH),
    });
    assert.equal(ok.requestId.length, MAX_ID_LENGTH);
  });

  test("rejects a non-object input and malformed per-name input shapes", () => {
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "session.drop",
        input: "t",
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    // session.resume/drop: threadId required
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "session.resume",
        input: {},
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "session.resume",
        input: { threadId: "   " },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    // runtime.install: channel must be stable|canary
    for (const channel of ["beta", "", 1, null]) {
      expectValidationError(() =>
        parseClientCommandRequest({
          commandName: "runtime.install",
          input: { channel },
          idempotencyKey: "k",
          requestId: "r",
        }),
      );
    }
    // interaction.respond: decision must be submit|cancel, interactionId required
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "interaction.respond",
        input: { interactionId: "i", decision: "maybe" },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "interaction.respond",
        input: { decision: "submit" },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    // plugins.setEnabled: name required, enabled boolean, scope user|project
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "plugins.setEnabled",
        input: { name: "", enabled: true },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "plugins.setEnabled",
        input: { name: "demo", enabled: "yes" },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "plugins.setEnabled",
        input: { name: "demo", enabled: true, scope: "machine" },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "plugins.setEnabled",
        input: { name: "demo", enabled: true, extra: 1 },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    // skills.setEnabled: same shape contract as plugins.setEnabled
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "skills.setEnabled",
        input: { name: "", enabled: true },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "skills.setEnabled",
        input: { name: "skill", enabled: 1 },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "skills.setEnabled",
        input: { name: "skill", enabled: true, scope: "machine" },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "mcp.setEnabled",
        input: { name: "", enabled: true },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "mcp.setEnabled",
        input: { name: "filesystem", enabled: 1 },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "agents.definition.upsert",
        input: { name: "x", description: "d", systemPrompt: "", scope: "machine" },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "agents.definition.delete",
        input: { name: "x", scope: "bundled" },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
    expectValidationError(() =>
      parseClientCommandRequest({
        commandName: "agents.definition.configure",
        input: { name: "", disabled: true },
        idempotencyKey: "k",
        requestId: "r",
      }),
    );
  });
});

describe("parseClientCommandRequest: interaction.respond value safety", () => {
  const base = {
    commandName: "interaction.respond",
    idempotencyKey: "k",
    requestId: "r",
  };

  test("accepts every valid response value kind", () => {
    for (const value of ["yes", true, ["a", "b"], { note: "x" }, { nested: { deep: [1] } }]) {
      const parsed = parseClientCommandRequest({
        ...base,
        input: { interactionId: "i", decision: "submit", value },
      });
      assert.equal(parsed.commandName, "interaction.respond");
    }
    const cancel = parseClientCommandRequest({
      ...base,
      input: { interactionId: "i", decision: "cancel" },
    });
    assert.equal(cancel.commandName, "interaction.respond");
  });

  test("rejects non-JSON-safe values (numbers, null, undefined, functions)", () => {
    for (const value of [42, 0, null, undefined, () => "x", Symbol("s"), 1n]) {
      expectValidationError(() =>
        parseClientCommandRequest({ ...base, input: { interactionId: "i", decision: "submit", value } }),
      );
    }
  });

  test("rejects NaN/Infinity and non-plain exotic objects", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, new Date(0), new Map()]) {
      expectValidationError(() =>
        parseClientCommandRequest({ ...base, input: { interactionId: "i", decision: "submit", value } }),
      );
    }
  });

  test("rejects reserved keys (__proto__, constructor, prototype) inside the value", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const payload = JSON.parse(
        `{"commandName":"interaction.respond","input":{"interactionId":"i","decision":"submit","value":{"${key}":{"x":1}}},"idempotencyKey":"k","requestId":"r"}`,
      );
      const message = expectValidationError(() => parseClientCommandRequest(payload));
      assert.match(message, /reserved key/);
      assert.equal(({} as Record<string, unknown>).x, undefined);
    }
  });

  test("rejects strings and arrays beyond the size bounds", () => {
    const tooLong = "a".repeat(MAX_TEXT_LENGTH + 1);
    expectValidationError(() =>
      parseClientCommandRequest({ ...base, input: { interactionId: "i", decision: "submit", value: tooLong } }),
    );
    const tooMany = Array.from({ length: MAX_LIST_ITEMS + 1 }, () => "x");
    expectValidationError(() =>
      parseClientCommandRequest({ ...base, input: { interactionId: "i", decision: "submit", value: tooMany } }),
    );
    const nonStringItems = ["x", 1];
    expectValidationError(() =>
      parseClientCommandRequest({ ...base, input: { interactionId: "i", decision: "submit", value: nonStringItems } }),
    );
  });

  test("rejects nesting beyond MAX_VALUE_DEPTH", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < MAX_VALUE_DEPTH + 1; depth += 1) {
      nested = { child: nested };
    }
    expectValidationError(() =>
      parseClientCommandRequest({ ...base, input: { interactionId: "i", decision: "submit", value: nested } }),
    );
  });

  test("rejects a value whose serialized-size proxy exceeds the budget", () => {
    const bulky = Array.from({ length: MAX_LIST_ITEMS }, () => "x".repeat(MAX_TEXT_LENGTH / 100));
    expectValidationError(() =>
      parseClientCommandRequest({ ...base, input: { interactionId: "i", decision: "submit", value: bulky } }),
    );
  });
});

describe("parseSubscriptionScope: closed scope set", () => {
  test("parses every valid scope shape", () => {
    assert.deepEqual(parseSubscriptionScope({ scope: "all" }), { scope: "all" });
    assert.deepEqual(parseSubscriptionScope({ scope: "runtime" }), { scope: "runtime" });
    assert.deepEqual(parseSubscriptionScope({ scope: "thread", threadId: "t-1" }), {
      scope: "thread",
      threadId: "t-1",
    });
    assert.deepEqual(parseSubscriptionScope({ scope: "command", requestId: "r-1" }), {
      scope: "command",
      requestId: "r-1",
    });
  });

  test("rejects unknown scopes and non-object payloads", () => {
    for (const scope of ["allx", "", "auth", 1, null, undefined]) {
      const message = expectValidationError(() => parseSubscriptionScope({ scope }));
      assert.match(message, /unknown scope/);
    }
    for (const payload of [null, undefined, "all", ["all"]]) {
      expectValidationError(() => parseSubscriptionScope(payload));
    }
  });

  test("rejects identity fields and missing selectors per scope", () => {
    expectValidationError(() => parseSubscriptionScope({ scope: "all", windowId: 1 }));
    expectValidationError(() => parseSubscriptionScope({ scope: "runtime", authority: "A" }));
    expectValidationError(() => parseSubscriptionScope({ scope: "thread" }));
    expectValidationError(() => parseSubscriptionScope({ scope: "thread", threadId: "" }));
    expectValidationError(() =>
      parseSubscriptionScope({ scope: "thread", threadId: "x".repeat(MAX_ID_LENGTH + 1) }),
    );
    expectValidationError(() => parseSubscriptionScope({ scope: "command" }));
    expectValidationError(() => parseSubscriptionScope({ scope: "command", requestId: " " }));
  });
});

describe("assertClientQueryResponse: outbound strictness", () => {
  test("accepts well-formed ok and error responses", () => {
    assertClientQueryResponse({ ok: true, queryName: "home.get", result: { ok: true } });
    assertClientQueryResponse({
      ok: false,
      queryName: "home.get",
      error: { code: "UNAVAILABLE", message: "runtime down" },
    });
  });

  test("rejects unknown queryNames, missing result, and unknown fields", () => {
    expectValidationError(() => assertClientQueryResponse({ ok: true, queryName: "telemetry.get", result: {} }));
    expectValidationError(() => assertClientQueryResponse({ ok: true, queryName: "home.get" }));
    expectValidationError(() =>
      assertClientQueryResponse({ ok: true, queryName: "home.get", result: {}, windowId: 1 }),
    );
  });

  test("rejects malformed error payloads", () => {
    expectValidationError(() =>
      assertClientQueryResponse({ ok: false, queryName: "home.get", error: { code: "HACKED", message: "x" } }),
    );
    expectValidationError(() =>
      assertClientQueryResponse({ ok: false, queryName: "home.get", error: { code: "UNAVAILABLE" } }),
    );
    expectValidationError(() =>
      assertClientQueryResponse({ ok: false, queryName: "home.get", error: "UNAVAILABLE" }),
    );
    assertClientQueryResponse({
      ok: false,
      queryName: "session.transcript.read",
      error: { code: "CURSOR_STALE", message: "cursor belongs to another branch" },
    });
  });

  test("session.transcript.read outbound page rejects extra keys and non-plain payloads", () => {
    const result = {
      runtimeEpoch: 1,
      sessionId: "session-1",
      branchLeafId: null,
      items: [],
      headCursor: "opaque-head",
      hasMoreBefore: false,
    };
    assertClientQueryResponse({ ok: true, queryName: "session.transcript.read", result });
    expectValidationError(() =>
      assertClientQueryResponse({ ok: true, queryName: "session.transcript.read", result: { ...result, extra: true } }),
    );
    expectValidationError(() =>
      assertClientQueryResponse({ ok: true, queryName: "session.transcript.read", result: "nope" }),
    );
    const oversized = {
      ...result,
      items: [
        {
          kind: "message",
          itemId: "msg-1",
          parentId: null,
          createdAt: "2026-08-15T12:00:00.000Z",
          role: "user",
          content: [{ type: "text", text: "x".repeat(CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES + 1) }],
        },
      ],
    };
    expectValidationError(() =>
      assertClientQueryResponse({ ok: true, queryName: "session.transcript.read", result: oversized }),
    );
  });

  test("session.transcript.readPage accepts only runtime-independent persisted pages", () => {
    const result = {
      sessionId: "session-1",
      transcriptRevision: "transcript-revision-1",
      branchLeafId: "leaf-1",
      items: [],
      olderCursor: "opaque-older",
      headCursor: "opaque-head",
      hasMoreBefore: true,
    };
    assertClientQueryResponse({ ok: true, queryName: "session.transcript.readPage", result });

    for (const invalid of [
      { ...result, runtimeEpoch: 1 },
      { ...result, transcriptRevision: "" },
      { ...result, transcriptRevision: "x".repeat(MAX_ID_LENGTH + 1) },
      { ...result, sessionId: "" },
      { ...result, branchLeafId: 42 },
      { ...result, headCursor: "" },
      {
        ...result,
        olderCursor: "x".repeat(CONVERSATION_LIMITS.CURSOR_MAX_CHARS + 1),
      },
      { ...result, hasMoreBefore: "yes" },
      { ...result, items: "not-an-array" },
      {
        ...result,
        items: Array.from(
          { length: CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX + 1 },
          (_, index) => ({
            kind: "resetBoundary",
            itemId: `reset-${index}`,
            parentId: null,
            createdAt: "2026-08-15T12:00:00.000Z",
          }),
        ),
      },
    ]) {
      expectValidationError(() =>
        assertClientQueryResponse({
          ok: true,
          queryName: "session.transcript.readPage",
          result: invalid,
        }),
      );
    }
  });
});

describe("assertClientCommandAccepted: outbound strictness", () => {
  const accepted = {
    commandName: "session.resume",
    requestId: "req-1",
    status: "accepted" as const,
    acceptedAt: "2026-08-12T00:00:00.000Z",
  };

  test("accepts a well-formed acknowledgement and rejects deviations", () => {
    assertClientCommandAccepted(accepted);
    expectValidationError(() => assertClientCommandAccepted({ ...accepted, status: "rejected" }));
    expectValidationError(() => assertClientCommandAccepted({ ...accepted, acceptedAt: "" }));
    expectValidationError(() => assertClientCommandAccepted({ ...accepted, requestId: "" }));
    expectValidationError(() =>
      assertClientCommandAccepted({ ...accepted, commandName: "system.exec" }),
    );
    expectValidationError(() => assertClientCommandAccepted({ ...accepted, extra: 1 }));
  });
});

describe("assertClientEvent: outbound strictness", () => {
  const base = {
    authorityEpoch: 1,
    stateVersion: 3,
    cursor: "cursor-1",
    occurredAt: "2026-08-12T00:00:00.000Z",
  };

  test("accepts every contract event kind with its exact payload", () => {
    assertClientEvent({ kind: "snapshot", ...base, snapshot: { version: 1 } });
    assertClientEvent({ kind: "state.changed", ...base });
    assertClientEvent({
      kind: "command.accepted",
      ...base,
      accepted: { commandName: "session.drop", requestId: "req-1", status: "accepted", acceptedAt: "2026-08-12T00:00:00.000Z" },
    });
    assertClientEvent({
      kind: "interaction.required",
      ...base,
      interaction: {
        kind: "confirm",
        interactionId: "i-1",
        sessionId: "session-1",
        leaseGeneration: 1,
        title: "Drop?",
        requestId: "req-1",
        message: "Drop?",
        destructive: true,
      },
    });
    assertClientEvent({
      kind: "interaction.resolved",
      ...base,
      interactionId: "i-1",
      leaseGeneration: 1,
      outcome: "submitted",
    });
    assertClientEvent({
      kind: "command.receipt",
      ...base,
      receipt: { requestId: "req-1", commandName: "session.drop", status: "completed", result: { ok: true }, observedAt: "2026-08-12T00:00:00.000Z" },
    });
    assertClientEvent({
      kind: "runtime.changed",
      ...base,
      runtimeEpoch: 2,
      connection: { status: "connected", classification: "managed", runtimeId: "r-1", backend: "studio-host" },
    });
    assertClientEvent({ kind: "resync.required", ...base, reason: "cursor gap" });
    assertClientEvent({ kind: "diagnostics.changed", ...base });
    assertClientEvent({
      kind: "conversation.changed",
      ...base,
      runtimeEpoch: 1,
      sessionId: "session-1",
      eventSeq: 3,
      update: {
        kind: "conversation.message.started",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
    });
  });

  test("rejects unknown kinds and unknown envelope fields", () => {
    expectValidationError(() => assertClientEvent({ kind: "auth.tampered", ...base }));
    expectValidationError(() => assertClientEvent({ kind: "state.changed", ...base, windowId: 1 }));
  });

  test("rejects malformed base fields (epochs, cursor, timestamp)", () => {
    expectValidationError(() => assertClientEvent({ kind: "state.changed", ...base, authorityEpoch: -1 }));
    expectValidationError(() => assertClientEvent({ kind: "state.changed", ...base, stateVersion: 1.5 }));
    expectValidationError(() => assertClientEvent({ kind: "state.changed", ...base, cursor: "" }));
    expectValidationError(() => assertClientEvent({ kind: "state.changed", ...base, occurredAt: "" }));
  });

  test("rejects malformed nested payloads", () => {
    expectValidationError(() =>
      assertClientEvent({
        kind: "command.receipt",
        ...base,
        receipt: { requestId: "req-1", commandName: "session.drop", status: "hacked", observedAt: "2026-08-12T00:00:00.000Z" },
      }),
    );
    expectValidationError(() =>
      assertClientEvent({
        kind: "interaction.required",
        ...base,
        interaction: {
          kind: "select",
          interactionId: "i-1",
          sessionId: "session-1",
          leaseGeneration: 1,
          title: "Pick",
          requestId: "req-1",
          options: "nope",
          multiple: false,
        },
      }),
    );
    expectValidationError(() =>
      assertClientEvent({ kind: "interaction.resolved", ...base, interactionId: "i-1", leaseGeneration: 1, outcome: "forged" }),
    );
    expectValidationError(() =>
      assertClientEvent({
        kind: "runtime.changed",
        ...base,
        connection: { status: "connected", classification: "root", runtimeId: "r-1" },
      }),
    );
    expectValidationError(() =>
      assertClientEvent({
        kind: "conversation.changed",
        ...base,
        runtimeEpoch: 1,
        sessionId: "session-1",
        eventSeq: 1,
        update: { kind: "conversation.forged", sessionId: "session-1" },
      }),
    );
    expectValidationError(() =>
      assertClientEvent({
        kind: "conversation.changed",
        ...base,
        runtimeEpoch: 1,
        sessionId: "session-1",
        eventSeq: 1,
        update: {
          kind: "conversation.message.started",
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: "msg-1",
          role: "assistant",
          createdAt: "2026-08-15T12:00:00.000Z",
          extra: true,
        },
      }),
    );
    expectValidationError(() =>
      assertClientEvent({
        kind: "conversation.changed",
        ...base,
        runtimeEpoch: 1,
        sessionId: "session-1",
        eventSeq: 1,
        update: {
          kind: "conversation.message.delta",
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: "msg-1",
          blockId: "b1",
          blockType: "text",
          delta: "x".repeat(CONVERSATION_LIMITS.DELTA_MAX_BYTES + 1),
        },
      }),
    );
    expectValidationError(() =>
      assertClientEvent({
        kind: "conversation.changed",
        ...base,
        runtimeEpoch: 1,
        sessionId: "session-1",
        eventSeq: 1,
        update: "nope",
      }),
    );
  });
});
