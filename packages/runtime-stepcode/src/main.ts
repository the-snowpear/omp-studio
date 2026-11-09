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
const runtimeEpoch = Number(arg("--bridge-runtime-epoch") ?? "0");
const cwd = arg("--cwd") ?? process.cwd();

if (endpoint === undefined || tokenFile === undefined) {
  console.error("runtime-stepcode: --bridge-endpoint and --bridge-token-file are required");
  process.exit(2);
}

const token = readFileSync(tokenFile, "utf8").trim();
const runtimeInstanceId = randomUUID();

// The spike advertises only what it implements. Everything else is declared
// unavailable so the shell hides it instead of offering a dead control.
const capabilities = [
  { id: "agent.send", grade: "stable", version: 1, evidence: "spike" },
  { id: "session.model", grade: "stable", version: 1, evidence: "spike" },
  { id: "session.thinking", grade: "stable", version: 1, evidence: "spike" },
  { id: "interaction.approve", grade: "stable", version: 1, evidence: "spike" },
  { id: "usage.read", grade: "stable", version: 1, evidence: "spike" },
  { id: "tui.transfer", grade: "unavailable", version: 1, evidence: "spike" },
  { id: "vibe.mode", grade: "unavailable", version: 1, evidence: "spike" },
  { id: "omfg.commit", grade: "unavailable", version: 1, evidence: "spike" },
  { id: "prewalk", grade: "unavailable", version: 1, evidence: "spike" },
  { id: "operator", grade: "unavailable", version: 1, evidence: "spike" },
  { id: "tan", grade: "unavailable", version: 1, evidence: "spike" },
] as const;

const capabilityManifest = {
  profile: "limited" as const,
  generatedAt: new Date().toISOString(),
  hash: sha256(JSON.stringify(capabilities)),
  capabilities,
};

const commandManifestHash = sha256(JSON.stringify(["core.prompt", "core.abort", "runtime.shutdown"]));

let stateVersion = 0;

const server = createServer(socket => {
  const connection = new BridgeConnection(socket, runtimeEpoch);
  let rpc: StepRpc | undefined;

  socket.on("error", () => {
    // A dropped socket only ends this connection; the runtime stays alive.
  });

  connection.onFrame(body => {
    if (body["type"] === "studio.hello") {
      connection.send({
        type: "studio.hello.result",
        requestId: body["requestId"],
        selectedProtocolVersion: PROTOCOL_VERSION,
        runtimeVersion: "0.0.0-spike",
        upstreamVersion: "step-code",
        upstreamCommit: "spike",
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
      const command = process.env["STEP_STUDIO_RUNTIME_CMD"] ?? "step";
      const parts = command.split(" ");
      rpc = new StepRpc(
        { command: parts[0]!, args: [...parts.slice(1), "--mode", "rpc"], cwd },
        event => {
          if (event["type"] === "message_update" && typeof event["delta"] === "string") {
            stateVersion += 1;
            connection.event(
              {
                kind: "conversation.message.delta",
                sessionId: "spike",
                turnId: "t1",
                messageId: String(event["messageId"] ?? "m1"),
                blockId: "b1",
                blockType: "text",
                delta: event["delta"],
              },
              stateVersion,
            );
          }
          if (event["type"] === "agent_settled") {
            connection.receipt(requestId, "completed", { ok: true });
          }
        },
      );
      rpc.prompt(String(operation["text"] ?? ""));
      return;
    }

    if (operation["kind"] === "core.abort") {
      rpc?.abort();
      connection.receipt(requestId, "completed", { aborted: true });
      return;
    }

    if (operation["kind"] === "runtime.snapshot") {
      connection.send({
        type: "studio.snapshot",
        requestId,
        snapshot: {
          runtimeId: runtimeInstanceId,
          runtimeEpoch,
          stateVersion,
          sessionId: "spike",
          isStreaming: false,
          isCompacting: false,
          activeMode: "normal",
          approvalMode: "always-ask",
          pendingMessages: 0,
          activeCommandIds: [],
          agentsRevision: 0,
          jobsRevision: 0,
          agents: [],
          jobs: [],
        },
        commandManifestHash,
        capabilityHash: capabilityManifest.hash,
        lastEventSeq: 0,
        terminalReceipts: [],
      });
      return;
    }

    if (operation["kind"] === "runtime.shutdown") {
      rpc?.kill();
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
