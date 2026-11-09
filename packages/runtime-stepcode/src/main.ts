import { readFileSync } from "node:fs";
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

const capabilities = [
  { id: "agent.send", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "session.model", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "session.thinking", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "interaction.approve", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "usage.read", grade: "stable", version: 1, evidence: "runtime-stepcode" },
  { id: "tui.transfer", grade: "unavailable", version: 1, evidence: "runtime-stepcode" },
  { id: "vibe.mode", grade: "unavailable", version: 1, evidence: "runtime-stepcode" },
  { id: "omfg.commit", grade: "unavailable", version: 1, evidence: "runtime-stepcode" },
  { id: "prewalk", grade: "unavailable", version: 1, evidence: "runtime-stepcode" },
  { id: "operator", grade: "unavailable", version: 1, evidence: "runtime-stepcode" },
  { id: "tan", grade: "unavailable", version: 1, evidence: "runtime-stepcode" },
] as const;

const capabilityManifest = {
  profile: "limited" as const,
  generatedAt: new Date().toISOString(),
  hash: sha256(JSON.stringify(capabilities)),
  capabilities,
};

const commandManifestHash = sha256(JSON.stringify(["core.prompt", "core.abort", "runtime.snapshot", "runtime.shutdown"]));

let stateVersion = 0;
let activeConnection: BridgeConnection | undefined;
let pendingPromptId: string | undefined;
let lastState: Record<string, unknown> = {};
let turnSeq = 0;
let messageSeq = 0;
let currentTurnId = "t0";
let openMessage: { id: string; role: string } | undefined;
let turnError: string | undefined;

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

/** Close the in-flight prompt request with its terminal outcome. */
function settlePrompt(error: string | undefined): void {
  if (pendingPromptId === undefined) return;
  const requestId = pendingPromptId;
  pendingPromptId = undefined;
  if (error === undefined) activeConnection?.receipt(requestId, "completed", { ok: true });
  else activeConnection?.failedReceipt(requestId, error);
}

const stepCommand = process.env["STEP_STUDIO_RUNTIME_CMD"] ?? "step";
const parts = stepCommand.split(" ");
const rpc = new StepRpc(
  {
    command: parts[0]!,
    // Live frames are opt-in upstream; without them the RPC stream carries only
    // lifecycle events and the renderer would never see text as it streams.
    args: [...parts.slice(1), "--mode", "rpc", "--include-live-events"],
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
      const createdAt = new Date(Number(message?.["timestamp"] ?? Date.now())).toISOString();

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

async function buildSnapshot(): Promise<Record<string, unknown>> {
  try {
    lastState = await rpc.request("get_state");
  } catch {
    // A CLI that cannot answer get_state still gets a minimal snapshot.
  }
  return {
    runtimeId: runtimeInstanceId,
    runtimeEpoch,
    stateVersion,
    sessionId: String(lastState["sessionId"] ?? "step-session"),
    isStreaming: Boolean(lastState["isStreaming"] ?? false),
    isCompacting: Boolean(lastState["isCompacting"] ?? false),
    activeMode: "normal",
    approvalMode: "always-ask",
    pendingMessages: Number(lastState["pendingMessageCount"] ?? 0),
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}

const server = createServer(socket => {
  const connection = new BridgeConnection(socket, runtimeEpoch);
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

    if (operation["kind"] === "core.abort") {
      rpc.abort();
      if (pendingPromptId !== undefined) {
        pendingPromptId = undefined;
        emit({ kind: "conversation.turn.aborted", sessionId: sessionId(), turnId: currentTurnId }, true);
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
          lastEventSeq: 0,
          terminalReceipts: [],
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
