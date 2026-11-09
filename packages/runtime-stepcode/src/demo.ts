import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

type BridgeClientModule = typeof import("../../studio-host/dist/src/bridge-client.js");

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const prompt = process.argv.slice(2).join(" ") || "hello";

const dir = mkdtempSync(join(tmpdir(), "step-studio-demo-"));
const token = randomUUID();
const tokenFile = join(dir, "token");
writeFileSync(tokenFile, token);
const socketPath = join(dir, "bridge.sock");
const fakeStep = here("../../test/fake-step.mjs");

const runtime = spawn(
  process.execPath,
  [
    here("./main.js"),
    "--mode", "studio-host",
    "--bridge-endpoint", socketPath,
    "--bridge-token-file", tokenFile,
    "--bridge-runtime-epoch", "1",
    "--cwd", dir,
  ],
  {
    env: { ...process.env, STEP_STUDIO_RUNTIME_CMD: process.env.STEP_STUDIO_RUNTIME_CMD ?? `${process.execPath} ${fakeStep}` },
    stdio: ["ignore", "ignore", "inherit"],
  },
);

try {
  for (let i = 0; i < 500 && !existsSync(socketPath); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const { StudioBridgeClient } = (await import(
    pathToFileURL(resolve(process.cwd(), "../studio-host/dist/src/bridge-client.js")).href
  )) as BridgeClientModule;

  const client = new StudioBridgeClient({
    endpoint: socketPath,
    token,
    requestTimeoutMs: 30_000,
    onEvent: event => {
      const payload = event.event as { kind?: string; delta?: string };
      if (payload.kind === "conversation.message.delta" && typeof payload.delta === "string") {
        process.stdout.write(payload.delta);
      }
    },
  });

  const hello = await client.connect();
  const snapshot = await client.requestSnapshot();
  console.log(`connected: profile=${hello.capabilityManifest.profile} runtime=${hello.runtimeVersion}`);
  console.log(`session: ${snapshot.snapshot.sessionId}`);
  process.stdout.write(`> ${prompt}\n`);

  try {
    const receipt = await client.invoke({
      type: "studio.request",
      requestId: randomUUID(),
      runtimeEpoch: hello.runtimeEpoch,
      operation: { kind: "core.prompt", text: prompt },
    });
    console.log(`\n[${receipt.status}]${receipt.error ? ` ${receipt.error.message}` : ""}`);
  } catch (error) {
    console.log(`\n[error] ${String(error)}`);
  }
  client.disconnect();
} finally {
  runtime.kill();
}
