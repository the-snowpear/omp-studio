import type { CompressionState } from "@omp-studio/studio-protocol";
export function previewCompression(applied = false): CompressionState {
  return { phase: applied ? "complete" : "ready", days: 7, ...(!applied ? { token: "00000000-0000-4000-8000-000000000004", expiresAt: Date.now() + 300000 } : {}), summary: {
    supported: true, method: "ntfs", scanned: 24, skippedLive: 2, sessions: 2, candidates: 3, compressed: applied ? 3 : 0,
    bytes: 8388608, allocatedBefore: 8388608, allocatedAfter: applied ? 2097152 : 0, truncated: false, errors: [],
    files: [{ sessionId: "demo-archive-queue", name: "sessions/omp-studio/queue.jsonl", bytes: 4194304, allocated: 4194304 }, { sessionId: "demo-archive-browser", name: "sessions/omp-studio/browser.jsonl", bytes: 2097152, allocated: 2097152 }, { sessionId: "demo-archive-browser", name: "sessions/omp-studio/browser/subagents/reviewer.jsonl", bytes: 2097152, allocated: 2097152 }],
  } };
}
