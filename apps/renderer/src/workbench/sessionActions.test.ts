import { expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { SessionHistoryEntry, StudioClient, ThreadId, WorkspaceId } from "@omp-studio/client-contract";
import { partialSessionDeletionNotice, resumePreparedHistoryEntry } from "./sessionActions";

function setup() {
  const commands: Record<string, unknown> = {};
  let changed: (() => void) | undefined;
  const entry = { sessionId: "restored-copy", threadId: "issued-restored-thread" } as SessionHistoryEntry;
  const query = vi.fn(async () => ({ entries: [entry], total: 1 }));
  const command = vi.fn(async () => ({ requestId: "resume-request" }));
  const onState = vi.fn((listener: () => void) => { changed = listener; return () => {}; });
  const client = { query, command, getState: () => ({ commands }), subscribe: () => () => {}, onState } as unknown as StudioClient;
  return { client, query, command, onState, entry, finish(receipt: unknown) { commands["resume-request"] = receipt; changed?.(); } };
}

it("consumes the prepared handle before listing history in the new workspace", async () => {
  const f = setup();
  const result = resumePreparedHistoryEntry(f.client, "opaque-prepared-thread" as ThreadId, "destination" as WorkspaceId, 200, "not catalogued");
  await waitFor(() => expect(f.onState).toHaveBeenCalled());
  expect(f.command).toHaveBeenCalledWith("session.resume", { threadId: "opaque-prepared-thread" });
  expect(f.query).not.toHaveBeenCalled();
  f.finish({ status: "completed", result: { sessionId: "restored-copy" } });
  expect(await result).toBe(f.entry);
  expect(f.query).toHaveBeenCalledWith("history.list", { workspaceId: "destination", limit: 200 });
});

it("does not open destination history after a failed native resume", async () => {
  const f = setup();
  const result = resumePreparedHistoryEntry(f.client, "opaque-prepared-thread" as ThreadId, "destination" as WorkspaceId, 200, "not catalogued");
  const failure = expect(result).rejects.toMatchObject({ message: "Original worker retained" });
  await waitFor(() => expect(f.onState).toHaveBeenCalled());
  f.finish({ status: "failed", error: { code: "UNAVAILABLE", message: "Original worker retained" } });
  await failure;
  expect(f.query).not.toHaveBeenCalled();
});

it("reformats a persistent deletion notice without translating the Host's original reason", () => {
  const saved = { title: "用户会话", details: "native-purge-partial: history timeout" };
  const english = partialSessionDeletionNotice(saved.title, saved.details, false);
  const chinese = partialSessionDeletionNotice(saved.title, saved.details, true);
  expect(english).toContain('Deleted "用户会话"');
  expect(chinese).toContain("已删除会话「用户会话」");
  expect(english).toContain(saved.details);
  expect(chinese).toContain(saved.details);
  expect(partialSessionDeletionNotice(saved.title, saved.details, false)).toBe(english);
});
