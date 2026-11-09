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

const stepCommand = process.env["STEP_STUDIO_RUNTIME_CMD"] ?? "step";
const parts = stepCommand.split(" ");
const rpc = new StepRpc(
  { command: parts[0]!, args: [...parts.slice(1), "--mode", "rpc"], cwd },
  event => {
    const connection = activeConnection;
    if (connection === undefined) return;
    if (event["type"] === "message_update" && typeof event["delta"] === "string") {
      stateVersion += 1;
      connection.event(
        {
          kind: "conversation.message.delta",
          sessionId: String(lastState["sessionId"] ?? "step-session"),
          turnId: "t1",
          messageId: String(event["messageId"] ?? "m1"),
          blockId: "b1",
          blockType: "text",
          delta: event["delta"],
        },
        stateVersion,
      );
    }
    if (event["type"] === "agent_settled" && pendingPromptId !== undefined) {
      connection.receipt(pendingPromptId, "completed", { ok: true });
      pendingPromptId = undefined;
    }
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
