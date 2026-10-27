import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import type { AgentSession } from "../../session/agent-session";

/** Private sideband: reuses the live session's AuthStorage; never a Bridge read model. */
export function createStudioAuthBroker(session: AgentSession): { close(): void } {
  const file = process.env.OMP_STUDIO_AUTH_BROKER_FILE;
  if (!file || process.env.OMP_AUTH_BROKER_URL) return { close() {} };
  const token = randomBytes(32).toString("base64url");
  const handle = startAuthBroker({ storage: session.modelRegistry.authStorage, bind: "127.0.0.1:0", bearerTokens: [token], disableRefresher: true });
  const contents = JSON.stringify({ url: handle.url, token });
  let closed = false;
  const published = fs.writeFile(file, contents, { mode: 0o600 });
  void published.catch(() => {});
  return { close() {
    if (closed) return; closed = true;
    void handle.close();
    void published.then(async () => { if (await fs.readFile(file, "utf8").catch(() => "") === contents) await fs.rm(file, { force: true }); }).catch(() => {});
  } };
}
