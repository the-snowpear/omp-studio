/** Bun-only fixture writer. Writes synthetic native sessions to an explicitly supplied empty profile. */
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "../omp-patch/vendor/oh-my-pi/packages/coding-agent/src/session/session-manager.ts";

const [workspaceArg, directoryArg, manifestArg, countArg = "384", turnsArg = "80"] = process.argv.slice(2);
if (!workspaceArg || !directoryArg || !manifestArg) throw new Error("Expected workspace, new session directory, manifest, [count], [turns]");
const workspace = resolve(workspaceArg), directory = resolve(directoryArg);
const count = Number(countArg), turns = Number(turnsArg);
if (!Number.isInteger(count) || count < 2 || count > 1000 || !Number.isInteger(turns) || turns < 1 || turns > 1000) throw new Error("Fixture size is out of bounds");
// The caller creates a new isolated profile. Never merge fixtures into an existing session directory.
await mkdir(directory, { recursive: false });
const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}: this is bounded, synthetic text for an offline conversation-switch measurement. It contains no user conversation, repository content, or credentials. Switching should release the old view while retaining only the draft, layout, and scalar reading anchor.\n\n`).join("");
const text = `## Synthetic archive\n\n${paragraphs}\n- Archive read through the real Host\n- No prompt or tool command is sent\n\n\`\`\`ts\nconst sample = { offline: true, bounded: true };\n\`\`\`\n`;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const sessions = [];
const now = Date.now();
for (let index = count - 1; index >= 0; index--) {
  const title = `Native performance session ${String(index + 1).padStart(3, "0")}`;
  const manager = SessionManager.create(workspace, directory, undefined, { studioOrigin: "studio-host" });
  try {
    for (let turn = 0; turn < turns; turn++) {
      manager.appendMessage({ role: "user", content: `Synthetic request ${turn + 1}: inspect the offline fixture without executing anything.`, timestamp: now - (turns - turn) * 1000 });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `${text}\n\n${turn === turns - 1 ? `Fixture complete: ${title}` : `Synthetic turn ${turn + 1}`}` }], api: "openai-completions", provider: "test", model: "fixture", usage, stopReason: "stop", timestamp: now - (turns - turn) * 1000 + 500 });
    }
    await manager.flush();
    await manager.setSessionName(title, "user");
    await manager.flush();
    const file = manager.getSessionFile();
    if (!file) throw new Error("Fixture did not create a native transcript");
    sessions.push({ index, title, sessionId: manager.getSessionId(), bytes: (await stat(file)).size, messages: turns * 2 });
    await manager.close();
    // A deterministic newest-first catalog, independent of write speed.
    await utimes(file, new Date(now - index * 1000), new Date(now - index * 1000));
  } finally { await manager.close(); }
}
sessions.sort((a, b) => a.index - b.index);
const manifest = { version: 1, kind: "synthetic-native-archives", count, turns, bytes: sessions.reduce((sum, item) => sum + item.bytes, 0), sessions };
await writeFile(resolve(manifestArg), JSON.stringify(manifest, null, 2), { flag: "wx" });
console.log(JSON.stringify({ count, messagesPerSession: turns * 2, bytes: manifest.bytes }));
