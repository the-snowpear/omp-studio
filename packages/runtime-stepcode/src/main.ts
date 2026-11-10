import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { BridgeConnection, PROTOCOL_VERSION, challengeProof, sha256 } from "./bridge.js";
import { StepRpc } from "./step-rpc.js";

const argv = process.argv.slice(2);

function arg(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const endpoint = arg("--bridge-endpoint");
const tokenFile = arg("--bridge-token-file");
const runtimeEpoch = Number(arg("--bridge-runtime-epoch") ?? "1");
const cwd = arg("--cwd") ?? process.cwd();

if (endpoint === undefined || tokenFile === undefined) {
  console.error("runtime-stepcode: --bridge-endpoint and --bridge-token-file are required");
  process.exit(2);
}

const token = readFileSync(tokenFile, "utf8").trim();
const runtimeInstanceId = randomUUID();

// Only ids the adapter actually implements. Anything absent is treated as
// unavailable by Host and Renderer, which is the honest default: Step Code has
// no OMP operators, agents, jobs or permissions model to expose.
const capabilities = [
  { id: "core.prompt", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "core.steer", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "core.followUp", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "core.abort", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "core.stream", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "runtime.snapshot", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "session.state", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "session.history", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "session.model.set", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "session.models.list", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  {
    id: "conversation.compaction",
    grade: "limited",
    version: 1,
    evidence: "runtime-stepcode",
    limitations: ["completion carries no summary; Step's compaction event does not include one"],
  },
  {
    id: "session.thinking.set",
    grade: "limited",
    version: 1,
    evidence: "runtime-stepcode",
    limitations: ["`auto` has no Step equivalent; it maps to the model's first supported level"],
  },
  {
    id: "session.new",
    grade: "stable",
    version: 1,
    evidence: "runtime-stepcode",
  },
  {
    id: "session.fork",
    grade: "limited",
    version: 1,
    evidence: "runtime-stepcode",
    limitations: ["forks at the latest entry only; the Studio tree/branch surface is not implemented"],
  },
] as const;

const capabilityManifest = {
  profile: "limited" as const,
  generatedAt: new Date().toISOString(),
  hash: sha256(JSON.stringify(capabilities)),
  capabilities,
};

const commandManifestHash = sha256(
  JSON.stringify([
    "core.prompt",
    "core.steer",
    "core.followUp",
    "core.abort",
    "runtime.snapshot",
    "runtime.shutdown",
    "session.model.set",
    "session.thinking.set",
    "session.new",
    "session.fork",
    "session.models.list",
    "session.transcript.read",
  ]),
);

let stateVersion = 0;
let activeConnection: BridgeConnection | undefined;
let pendingPromptId: string | undefined;
let lastState: Record<string, unknown> = {};
let turnSeq = 0;
let messageSeq = 0;
let currentTurnId = "t0";
let openMessage: { id: string; role: string } | undefined;
let turnError: string | undefined;

/**
 * Step timestamps are epoch milliseconds on live messages and ISO strings on
 * persisted entries; `Number()` of an ISO string is NaN and `toISOString()`
 * then throws.
 */
function toIso(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/** Studio block types the conversation contract accepts. */
function blockTypeOf(eventType: string): "text" | "thinking" | undefined {
  if (eventType.startsWith("thinking")) return "thinking";
  if (eventType.startsWith("text")) return "text";
  return undefined;
}

/** Step content blocks -> Studio content blocks. Tool results ride on the assistant item. */
function toStudioBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const entry of content as Array<Record<string, unknown>>) {
    if (entry["type"] === "text" && typeof entry["text"] === "string") {
      blocks.push({ type: "text", text: entry["text"] });
    } else if (entry["type"] === "thinking" && typeof entry["thinking"] === "string") {
      blocks.push({ type: "thinking", text: entry["thinking"] });
    } else if (entry["type"] === "toolCall") {
      blocks.push({
        type: "toolCall",
        toolCallId: String(entry["id"] ?? ""),
        toolName: String(entry["name"] ?? ""),
        arguments: entry["arguments"] ?? {},
      });
    }
  }
  return blocks;
}

function emit(event: Record<string, unknown>, advanceState: boolean): void {
  const connection = activeConnection;
  if (connection === undefined) return;
  if (advanceState) stateVersion += 1;
  connection.event(event, stateVersion);
}

function sessionId(): string {
  return String(lastState["sessionId"] ?? "step-session");
}

/**
 * A failure that must reach the client under its own protocol code: the Host
 * maps `CURSOR_STALE` to a resync, `INTERNAL_ERROR` to a plain failure, and
 * collapsing them loses that distinction.
 */
class BridgeFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BridgeFailure";
  }
}

/** Close the in-flight prompt request with its terminal outcome. */
function settlePrompt(error: string | undefined): void {
  if (pendingPromptId === undefined) return;
  const requestId = pendingPromptId;
  pendingPromptId = undefined;
  if (error === undefined) activeConnection?.receipt(requestId, "completed", { ok: true });
  else activeConnection?.failedReceipt(requestId, error);
}

const stepCommand = process.env["STEP_STUDIO_RUNTIME_CMD"] ?? "step";
// A whole-string path is an executable, not a command plus arguments: Windows
// install paths routinely contain spaces, and splitting those produces a
// command that does not exist.
const parts = existsSync(stepCommand) ? [stepCommand] : stepCommand.split(" ");
// Resume the previous session, so a relaunch continues the conversation instead
// of losing it. Opt-in: the desktop Host spawns this adapter without the
// variable and must keep starting fresh.
const continueSession = process.env["STEP_STUDIO_SESSION"] === "continue";
const rpc = new StepRpc(
  {
    command: parts[0]!,
    // Live frames are opt-in upstream; without them the RPC stream carries only
    // lifecycle events and the renderer would never see text as it streams.
    args: [
      ...parts.slice(1),
      "--mode",
      "rpc",
      "--include-live-events",
      ...(continueSession ? ["--continue"] : []),
    ],
    cwd,
  },
  event => {
    const connection = activeConnection;
    if (connection === undefined) return;
    const type = String(event["type"]);

    if (type === "agent_start") {
      turnSeq += 1;
      currentTurnId = `t${turnSeq}`;
      return;
    }

    if (type === "message_start" || type === "message_end") {
      const message = event["message"] as Record<string, unknown> | undefined;
      const role = String(message?.["role"] ?? "");
      // `custom` entries (runtime-context reminders, activity capabilities) are
      // ignored by the conversation contract; tool results have no public role.
      if (role !== "user" && role !== "assistant") return;
      const createdAt = toIso(message?.["timestamp"]);

      if (type === "message_start") {
        messageSeq += 1;
        openMessage = { id: `m${messageSeq}`, role };
        emit(
          {
            kind: "conversation.message.started",
            sessionId: sessionId(),
            turnId: currentTurnId,
            messageId: openMessage.id,
            role,
            createdAt,
          },
          false,
        );
        return;
      }

      if (openMessage === undefined) return;
      const messageId = openMessage.id;
      openMessage = undefined;
      const stopReason = String(message?.["stopReason"] ?? "stop");
      const errorMessage = message?.["errorMessage"];
      const failed = typeof errorMessage === "string" && stopReason !== "stop";
      if (failed) turnError = errorMessage;
      emit(
        {
          kind: "conversation.message.completed",
          sessionId: sessionId(),
          turnId: currentTurnId,
          messageId,
          item: {
            kind: "message",
            itemId: messageId,
            parentId: null,
            createdAt,
            role,
            content: toStudioBlocks(message?.["content"]),
          },
          ...(failed
            ? {
                error: {
                  message: errorMessage,
                  provider: String(message?.["provider"] ?? "") || undefined,
                  model: String(message?.["model"] ?? "") || undefined,
                },
              }
            : {}),
        },
        true,
      );
      // The failed assistant message is authoritative: Step may auto-retry for
      // minutes afterwards, and the client must not wait for that.
      if (failed) settlePrompt(errorMessage);
      return;
    }

    if (type === "message_update") {
      const update = event["assistantMessageEvent"] as Record<string, unknown> | undefined;
      const updateType = String(update?.["type"] ?? "");
      const blockType = blockTypeOf(updateType);
      const delta = update?.["delta"];
      if (blockType === undefined || typeof delta !== "string" || delta === "") return;
      if (openMessage === undefined) return;
      // A pure delta advances eventSeq only; stateVersion tracks persisted authority.
      emit(
        {
          kind: "conversation.message.delta",
          sessionId: sessionId(),
          turnId: currentTurnId,
          messageId: openMessage.id,
          blockId: `b${String(update?.["contentIndex"] ?? 0)}`,
          blockType,
          delta,
        },
        false,
      );
      return;
    }

    // A compacted context is visible to the user: the transcript shortens and
    // the model forgets. Silence here looks like the app lost messages.
    if (type === "compaction_start") {
      emit(
        { kind: "conversation.compaction.started", sessionId: sessionId(), action: String(event["reason"] ?? "auto") },
        false,
      );
      return;
    }

    if (type === "compaction_end") {
      emit(
        { kind: "conversation.compaction.completed", sessionId: sessionId(), aborted: Boolean(event["aborted"]) },
        true,
      );
      return;
    }

    // Tool execution is the agent's actual work; without these the renderer
    // shows a turn that thinks and answers but never acts.
    if (type === "tool_execution_start") {
      emit(
        {
          kind: "conversation.tool.started",
          sessionId: sessionId(),
          turnId: currentTurnId,
          messageId: openMessage?.id ?? `m${messageSeq}`,
          toolCallId: String(event["toolCallId"] ?? ""),
          toolName: String(event["toolName"] ?? ""),
          arguments: (event["args"] ?? {}) as Record<string, unknown>,
          startedAt: new Date().toISOString(),
        },
        false,
      );
      return;
    }

    if (type === "tool_execution_end") {
      const result = event["result"] as Record<string, unknown> | undefined;
      const content = Array.isArray(result?.["content"]) ? (result["content"] as Array<Record<string, unknown>>) : [];
      emit(
        {
          kind: "conversation.tool.completed",
          sessionId: sessionId(),
          turnId: currentTurnId,
          toolCallId: String(event["toolCallId"] ?? ""),
          result: {
            type: "toolResult",
            toolCallId: String(event["toolCallId"] ?? ""),
            toolName: String(event["toolName"] ?? ""),
            output: content.map(block => String(block["text"] ?? "")).join(""),
            isError: Boolean(result?.["isError"]),
          },
          completedAt: new Date().toISOString(),
        },
        true,
      );
      return;
    }

    if (type === "turn_end") {
      emit({ kind: "conversation.turn.completed", sessionId: sessionId(), turnId: currentTurnId }, true);
      return;
    }

    if (type === "auto_retry_start") {
      // A retry is a fresh attempt: the previous failure must not poison it.
      turnError = undefined;
      openMessage = undefined;
      return;
    }

    if (type === "agent_settled") settlePrompt(turnError);
  },
);

// A CLI that dies mid-turn must not leave the prompt waiting for a receipt
// that can never arrive: the client would sit until its own timeout and
// report an outcome it cannot distinguish from a hang.
rpc.onExit(({ code, signal }) => {
  settlePrompt(`step runtime exited (code=${code ?? "null"} signal=${signal ?? "none"})`);
});

// A CLI that never started must not crash the adapter: the Host would see a
// dead process instead of a runtime that reported why it could not run.
rpc.onSpawnError(error => {
  settlePrompt(`step runtime could not start: ${error.message}`);
});

/** Step thinking levels, minus Studio's `auto`, which has no Step equivalent. */
const STEP_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Refresh the cached state so snapshots and events carry the new session id. */
async function refreshState(): Promise<void> {
  try {
    lastState = await rpc.request("get_state");
  } catch {
    // A CLI that cannot answer get_state keeps its last known state.
  }
}

/**
 * Resolve a selector against the live catalog.
 *
 * Step model ids routinely contain a slash of their own
 * (`zed/claude-haiku-5-5` under provider `local-gateway`), so a canonical
 * `provider/id` selector is ambiguous: splitting on the first slash reads that
 * as provider `zed`. Matching the whole string as an id first, and only then
 * falling back to `provider/id`, accepts both forms the Composer can send.
 */
async function resolveModelSelector(selector: string): Promise<{ provider: string; modelId: string }> {
  const catalog = await rpc.request("get_available_models");
  const models = Array.isArray(catalog["models"]) ? (catalog["models"] as Array<Record<string, unknown>>) : [];
  const byId = models.find(model => model["id"] === selector);
  if (byId !== undefined) return { provider: String(byId["provider"] ?? ""), modelId: selector };
  const slash = selector.indexOf("/");
  if (slash > 0) {
    const provider = selector.slice(0, slash);
    const modelId = selector.slice(slash + 1);
    const match = models.find(model => model["provider"] === provider && model["id"] === modelId);
    if (match !== undefined) return { provider, modelId };
  }
  throw new Error(`model not found: ${selector}`);
}

async function setSessionModel(selector: string, thinking: unknown): Promise<void> {
  const { provider, modelId } = await resolveModelSelector(selector);
  await rpc.request("set_model", { provider, modelId });
  // `thinking` pins a level alongside the switch; omitted keeps the target
  // model's own default.
  if (typeof thinking === "string") await setThinkingLevel(thinking);
  await refreshState();
}

async function setThinkingLevel(level: string): Promise<void> {
  if (!STEP_THINKING_LEVELS.has(level)) {
    if (level !== "auto") throw new Error(`unsupported thinking level: ${level}`);
    // `auto` has no Step equivalent: take the model's first supported level.
    const catalog = await rpc.request("get_available_thinking_levels");
    const levels = Array.isArray(catalog["levels"]) ? (catalog["levels"] as string[]) : [];
    if (levels.length === 0) throw new Error("model reports no thinking levels");
    await rpc.request("set_thinking_level", { level: levels[0] });
    await refreshState();
    return;
  }
  await rpc.request("set_thinking_level", { level });
  await refreshState();
}

/** Fork at the current leaf; the Studio tree surface is not implemented. */
async function forkSession(): Promise<void> {
  const entries = await rpc.request("get_entries");
  const leafId = entries["leafId"];
  if (typeof leafId !== "string" || leafId === "") throw new Error("session has no entry to fork from");
  await rpc.request("fork", { entryId: leafId });
  await refreshState();
}

/**
 * One page of the active branch. Step exposes no pagination cursor, so the
 * head cursor is a generation token and any other cursor is stale.
 */
async function readTranscript(cursor: unknown, limit: unknown): Promise<Record<string, unknown>> {
  const entries = await rpc.request("get_entries");
  const list = Array.isArray(entries["entries"]) ? (entries["entries"] as Array<Record<string, unknown>>) : [];
  const leafId = typeof entries["leafId"] === "string" ? (entries["leafId"] as string) : null;
  const headCursor = `step-1:${String(leafId ?? "empty")}`;
  if (typeof cursor === "string" && cursor !== "" && cursor !== headCursor) {
    throw new BridgeFailure("CURSOR_STALE", "transcript cursor does not match the active session");
  }
  const max = typeof limit === "number" && limit > 0 ? limit : list.length;
  const items: Array<Record<string, unknown>> = [];
  for (const entry of list.slice(Math.max(0, list.length - max))) {
    // The conversation contract ignores model/thinking changes, custom
    // entries, labels and branch summaries.
    if (entry["type"] !== "message") continue;
    const message = entry["message"] as Record<string, unknown> | undefined;
    const role = String(message?.["role"] ?? "");
    if (role !== "user" && role !== "assistant") continue;
    const itemId = String(entry["id"] ?? "");
    items.push({
      kind: "message",
      itemId,
      parentId: typeof entry["parentId"] === "string" ? entry["parentId"] : null,
      createdAt: toIso(entry["timestamp"]),
      role,
      content: toStudioBlocks(message?.["content"]),
    });
  }
  return {
    runtimeEpoch,
    sessionId: sessionId(),
    branchLeafId: leafId,
    items,
    headCursor,
    hasMoreBefore: false,
  };
}

async function buildSnapshot(): Promise<Record<string, unknown>> {
  try {
    lastState = await rpc.request("get_state");
  } catch {
    // A CLI that cannot answer get_state still gets a minimal snapshot.
  }
  const model = lastState["model"] as Record<string, unknown> | undefined;
  const provider = typeof model?.["provider"] === "string" ? (model["provider"] as string) : undefined;
  const modelId = typeof model?.["id"] === "string" ? (model["id"] as string) : undefined;
  const thinkingLevel = typeof lastState["thinkingLevel"] === "string" ? (lastState["thinkingLevel"] as string) : undefined;
  return {
    runtimeId: runtimeInstanceId,
    runtimeEpoch,
    stateVersion,
    sessionId: String(lastState["sessionId"] ?? "step-session"),
    isStreaming: Boolean(lastState["isStreaming"] ?? false),
    isCompacting: Boolean(lastState["isCompacting"] ?? false),
    activeMode: "normal",
    approvalMode: "always-ask",
    ...(provider !== undefined && modelId !== undefined
      ? {
          model: {
            selector: `${provider}/${modelId}`,
            provider,
            id: modelId,
            ...(thinkingLevel === undefined ? {} : { thinking: thinkingLevel }),
            ...(thinkingLevel === undefined ? {} : { configuredThinking: thinkingLevel }),
          },
        }
      : {}),
    pendingMessages: Number(lastState["pendingMessageCount"] ?? 0),
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}

// Terminal outcomes outlive any one socket: a reconnect must be able to
// recover a receipt the dropped connection never delivered.
const terminalReceipts: Array<Record<string, unknown>> = [];

const server = createServer(socket => {
  // One runtime serves one Host. A second connection means the previous one is
  // stale; keeping it would orphan whichever client the single event slot
  // points at.
  activeConnection?.close();
  const connection = new BridgeConnection(socket, runtimeEpoch, terminalReceipts);
  activeConnection = connection;

  socket.on("error", () => {
    // A dropped socket only ends this connection; the runtime stays alive.
  });

  connection.onFrame(body => {
    if (body["type"] === "studio.hello") {
      connection.send({
        type: "studio.hello.result",
        requestId: body["requestId"],
        selectedProtocolVersion: PROTOCOL_VERSION,
        runtimeVersion: "0.0.0-step-bridge",
        upstreamVersion: "step-code",
        upstreamCommit: "0.1.0",
        runtimeInstanceId,
        runtimeEpoch,
        capabilityManifest,
        commandManifestHash,
        stateVersion,
        challengeProof: challengeProof(token, String(body["challenge"]), runtimeInstanceId),
      });
      return;
    }

    if (body["type"] !== "studio.request") return;
    const requestId = String(body["requestId"]);
    const operation = body["operation"] as Record<string, unknown> | undefined;
    if (operation === undefined) return;

    if (operation["kind"] === "core.prompt") {
      connection.receipt(requestId, "accepted");
      pendingPromptId = requestId;
      rpc.request("prompt", { message: String(operation["text"] ?? "") }, 120_000).catch(error => {
        if (pendingPromptId === requestId) pendingPromptId = undefined;
        connection.failedReceipt(requestId, String(error));
      });
      return;
    }

    if (operation["kind"] === "core.steer" || operation["kind"] === "core.followUp") {
      const type = operation["kind"] === "core.steer" ? "steer" : "follow_up";
      // Queueing is synchronous upstream, so this answers `completed` — only
      // `core.prompt` stays `accepted`, because its turn outlives the reply.
      rpc.request(type, { message: String(operation["text"] ?? "") }).then(
        () => connection.receipt(requestId, "completed", { queued: true }),
        error => connection.failedReceipt(requestId, String(error)),
      );
      return;
    }

    if (operation["kind"] === "session.model.set") {
      void setSessionModel(String(operation["selector"] ?? ""), operation["thinking"]).then(
        () => connection.receipt(requestId, "completed", { ok: true }),
        error => connection.failedReceipt(requestId, String(error), error instanceof BridgeFailure ? error.code : undefined),
      );
      return;
    }

    if (operation["kind"] === "session.thinking.set") {
      void setThinkingLevel(String(operation["level"] ?? "")).then(
        () => connection.receipt(requestId, "completed", { ok: true }),
        error => connection.failedReceipt(requestId, String(error), error instanceof BridgeFailure ? error.code : undefined),
      );
      return;
    }

    if (operation["kind"] === "session.new") {
      // Step calls this `new_session`: it mints a fresh session id and drops the
      // transcript. The mapping counters reset with it, so entry ids from the
      // old session cannot leak into the new one.
      void rpc.request("new_session", {}).then(async () => {
        turnSeq = 0;
        messageSeq = 0;
        currentTurnId = "t0";
        openMessage = undefined;
        await refreshState();
        connection.receipt(requestId, "completed", { ok: true });
      }, error => connection.failedReceipt(requestId, String(error)));
      return;
    }

    if (operation["kind"] === "session.fork") {
      void forkSession().then(
        () => connection.receipt(requestId, "completed", { ok: true }),
        error => connection.failedReceipt(requestId, String(error), error instanceof BridgeFailure ? error.code : undefined),
      );
      return;
    }

    if (operation["kind"] === "session.models.list") {
      void rpc.request("get_available_models").then(
        catalog => {
          const models = Array.isArray(catalog["models"]) ? (catalog["models"] as Array<Record<string, unknown>>) : [];
          connection.receipt(requestId, "completed", {
            models: models.map(model => {
              const provider = String(model["provider"] ?? "");
              const id = String(model["id"] ?? "");
              return {
                provider,
                id,
                selector: `${provider}/${id}`,
                ...(typeof model["name"] === "string" ? { name: model["name"] } : {}),
                ...(typeof model["reasoning"] === "boolean" ? { reasoning: model["reasoning"] } : {}),
                ...(typeof model["contextWindow"] === "number" ? { contextWindow: model["contextWindow"] } : {}),
                ...(typeof model["maxTokens"] === "number" ? { maxTokens: model["maxTokens"] } : {}),
                ...(typeof model["api"] === "string" ? { api: model["api"] } : {}),
              };
            }),
          });
        },
        error => connection.failedReceipt(requestId, String(error)),
      );
      return;
    }

    if (operation["kind"] === "session.transcript.read") {
      void readTranscript(operation["cursor"], operation["limit"]).then(
        page => connection.receipt(requestId, "completed", page),
        error => connection.failedReceipt(requestId, String(error), error instanceof BridgeFailure ? error.code : undefined),
      );
      return;
    }

    if (operation["kind"] === "core.abort") {
      rpc.abort();
      if (pendingPromptId !== undefined) {
        // Settle the turn the Host is still waiting on. Clearing the id without
        // answering leaves that request without a terminal receipt until the
        // prompt RPC times out, which is minutes later.
        emit({ kind: "conversation.turn.aborted", sessionId: sessionId(), turnId: currentTurnId }, true);
        connection.receipt(pendingPromptId, "completed", { aborted: true });
        pendingPromptId = undefined;
      }
      connection.receipt(requestId, "completed", { aborted: true });
      return;
    }

    if (operation["kind"] === "runtime.snapshot") {
      void buildSnapshot().then(snapshot => {
        connection.send({
          type: "studio.snapshot",
          requestId,
          snapshot,
          commandManifestHash,
          capabilityHash: capabilityManifest.hash,
          // Reporting 0 here resets the Host's projection watermark and turns
          // the next event into a gap, which forces a resync.
          lastEventSeq: connection.lastEventSeq,
          terminalReceipts: connection.terminalReceipts,
        });
      });
      return;
    }

    if (operation["kind"] === "runtime.shutdown") {
      rpc.kill();
      connection.receipt(requestId, "completed");
      connection.event({ kind: "runtime.shutdownComplete" }, stateVersion);
      socket.end();
      server.close();
      return;
    }

    connection.receipt(requestId, "rejected");
  });
});

server.listen(endpoint, () => {
  console.error(`runtime-stepcode listening on ${endpoint}`);
});

// The session id only exists after the CLI has created its session; the first
// snapshot read is what makes conversation events carry a real id.
void rpc.request("get_state").then(state => {
  lastState = state;
}).catch(() => {
  // A CLI without get_state still streams events under the placeholder id.
});
