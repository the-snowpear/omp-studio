import { createInterface } from "node:readline";
import { join } from "node:path";
import { Settings } from "../omp-patch/vendor/oh-my-pi/packages/coding-agent/src/config/settings";
import { AgentRegistry } from "../omp-patch/vendor/oh-my-pi/packages/coding-agent/src/registry/agent-registry";
import type { AgentSession } from "../omp-patch/vendor/oh-my-pi/packages/coding-agent/src/session/agent-session";
import { StudioManagedBrowserService } from "../omp-patch/vendor/oh-my-pi/packages/coding-agent/src/studio/services/managed-browser-service";
import { createBrowserPrelude } from "../omp-patch/vendor/oh-my-pi/packages/coding-agent/src/tools/browser";
import { releaseTabsForOwner } from "../omp-patch/vendor/oh-my-pi/packages/coding-agent/src/tools/browser/tab-supervisor";
import type { ToolSession } from "../omp-patch/vendor/oh-my-pi/packages/coding-agent/src/tools";

const directory = process.argv[2]!;
const sessionId = process.argv[3]!;
// Registry ownership now reads the SessionManager identity and the view-session surface.
// These offline handles do not start an agent loop or make model requests.
const fixtureSession = (id: string) => ({ sessionId: id, sessionManager: { getSessionId: () => id }, activeToolExecutionUpdates: () => [] }) as unknown as AgentSession;
const rootSession = fixtureSession(sessionId);
const registry = AgentRegistry.global();
const references = [
  registry.register({ id: "smoke-root", displayName: "Root", kind: "main", session: rootSession }),
  registry.register({ id: "smoke-child", displayName: "Child", kind: "sub", parentId: "smoke-root", session: fixtureSession(`${sessionId}-child`) }),
  registry.register({ id: "smoke-isolated", displayName: "Isolated", kind: "sub", parentId: "smoke-child", session: fixtureSession(`${sessionId}-isolated`), history: { isolated: true } }),
];
let service = new StudioManagedBrowserService(rootSession, { enabled: true, directory });
const retired: StudioManagedBrowserService[] = [];
const session: ToolSession = {
  cwd: directory, hasUI: false, getSessionFile: () => null, getSessionSpawns: () => null, getSessionId: () => sessionId, getEvalKernelOwnerId: () => sessionId,
  settings: Settings.isolated({ "browser.enabled": true, "browser.relay": false, "browser.cmux": false, "browser.tern": false, "browser.screenshotDir": directory, "tools.maxTimeout": 0 }),
};
const prelude = createBrowserPrelude(session);
const sessions = {
  root: session,
  child: { ...session, getSessionId: () => `${sessionId}-child`, getEvalKernelOwnerId: () => `${sessionId}-child` },
  isolated: { ...session, cwd: join(directory, "isolated-worktree"), getSessionId: () => `${sessionId}-isolated`, getEvalKernelOwnerId: () => `${sessionId}-isolated` },
};
const pending = new Map<number, AbortController>();
const respond = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
respond({ kind: "ready", ...await service.prepare(sessionId) });
const input = createInterface({ input: process.stdin });
async function execute(request: { id: number; action: string; target?: number; owner?: keyof typeof sessions; parameters?: unknown }): Promise<void> {
  try {
    if (request.action === "stop") {
      await releaseTabsForOwner(sessionId); service.dispose(); for (const previous of retired) previous.dispose(); for (const reference of references) registry.unregister(reference.id, reference); respond({ id: request.id, ok: true }); process.exit(0);
    }
    if (request.action === "rotate") { await releaseTabsForOwner(sessionId); retired.push(service); service = new StudioManagedBrowserService(rootSession, { enabled: true, directory }); respond({ id: request.id, ok: true, result: await service.prepare(sessionId) }); return; }
    if (request.action === "retire") { for (const previous of retired.splice(0)) previous.dispose(); respond({ id: request.id, ok: true }); return; }
    if (request.action === "cancel") { pending.get(request.target!)?.abort(); respond({ id: request.id, ok: true }); return; }
    if (request.action === "release") { respond({ id: request.id, ok: true, result: await releaseTabsForOwner(sessionId) }); return; }
    const controller = new AbortController(); pending.set(request.id, controller);
    const caller = sessions[request.owner ?? "root"];
    const browser = caller === session ? prelude : createBrowserPrelude(caller);
    const result = await browser.invoke(request.parameters, { session: caller, toolCallId: `smoke-${request.id}`, signal: controller.signal });
    respond({ id: request.id, ok: true, result });
  } catch (error) {
    respond({ id: request.id, ok: false, error: String(error).replace(/\/managed\/[a-f0-9]{64}/gu, "/managed/[private]") });
  } finally { pending.delete(request.id); }
}
input.on("line", line => { void execute(JSON.parse(line)); });
input.on("close", () => { service.dispose(); process.exit(0); });
