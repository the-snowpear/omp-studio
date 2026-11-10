import { parentPort, workerData } from "node:worker_threads";
import { resolve } from "node:path";
import { SessionArchiveCacheBudget, SessionArchiveIndex, StudioSessionArchiveReader } from "./session-archive-reader.js";
import type { ArchiveWorkerMethod } from "./session-archive-pool.js";

const port = parentPort!;
const budget = new SessionArchiveCacheBudget();
const index = new SessionArchiveIndex();
const readers = new Map<string, StudioSessionArchiveReader>();
const secret = Buffer.from(workerData.cursorSecret);
type Request = { id: number; cwd: string; method: ArchiveWorkerMethod; args: unknown[]; controller: AbortController };
const pending = new Map<number, Request>();
const queue: Request[] = [];
let running = false;
function reader(cwd: string) {
  const key = resolve(cwd);
  let current = readers.get(key);
  if (!current) current = new StudioSessionArchiveReader({ ...workerData, allowedCwd: key, cursorSecret: secret, cacheBudget: budget, index });
  readers.delete(key); readers.set(key, current);
  while (readers.size > 8) { const [key, value] = readers.entries().next().value!; value.clearCache(); readers.delete(key); }
  return current;
}
function priority(method: ArchiveWorkerMethod) { return method === "readPage" ? 0 : method === "prefetch" ? 2 : 1; }
async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      queue.sort((a, b) => priority(a.method) - priority(b.method));
      const request = queue.shift()!;
      let value: unknown, error: { name: string; message: string; code?: string } | undefined;
      try {
        request.controller.signal.throwIfAborted();
        const target = reader(request.cwd);
        const args = request.method === "readPage" ? [...request.args, request.controller.signal] : request.args;
        value = await (target[request.method] as (...args: unknown[]) => Promise<unknown>).apply(target, args);
      } catch (cause) {
        const failure = cause as Error & { code?: string };
        error = { name: failure.name, message: failure.message, ...(typeof failure.code === "string" ? { code: failure.code } : {}) };
      }
      pending.delete(request.id);
      port.postMessage({ id: request.id, ...(error ? { error } : { value }), stats: { ...budget.diagnostics(), indexedSessions: index.sessions.size, workerHeapBytes: process.memoryUsage().heapUsed } });
    }
  } finally { running = false; }
}
port.on("message", (message: Omit<Request, "controller"> | { abort: number }) => {
  if ("abort" in message) { pending.get(message.abort)?.controller.abort(); return; }
  const request = { ...message, controller: new AbortController() };
  pending.set(request.id, request); queue.push(request); void drain();
});
