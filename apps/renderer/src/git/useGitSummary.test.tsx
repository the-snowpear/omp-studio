import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientEvent, QueryResult, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { useGitSummary } from "./useGitSummary";

afterEach(cleanup);
const workspaceId = "same-project-id" as WorkspaceId;
const repository: QueryResult<"git.repository.summary"> = { workspaceId, isRepository: true, branch: "main", detached: false, ahead: 0, behind: 0, changedFiles: 0, sampledAt: "2026-11-10T00:00:00Z" };

it("clears a recovered Git error and never displays a previous target's summary", async () => {
  let notify!: (event: ClientEvent) => void;
  const query = vi.fn().mockRejectedValueOnce(new Error("Git offline")).mockResolvedValue(repository);
  const first = { query, subscribe: (_scope: unknown, listener: typeof notify) => { notify = listener; return () => {}; } } as unknown as StudioClient;
  const view = renderHook(({ client }) => useGitSummary(client, workspaceId), { initialProps: { client: first } });
  await waitFor(() => expect(view.result.current.error).toContain("Git offline"));
  act(() => notify({ kind: "git.repository.changed", repository: { workspaceId, reason: "external" } } as ClientEvent));
  await waitFor(() => expect(view.result.current.repository?.branch).toBe("main"));
  expect(view.result.current.error).toBeUndefined();
  let finish!: (value: typeof repository) => void;
  const second = { query: () => new Promise(resolve => { finish = resolve; }), subscribe: () => () => {} } as unknown as StudioClient;
  view.rerender({ client: second });
  expect(view.result.current.repository).toBeUndefined(); expect(view.result.current.error).toBeUndefined();
  await act(async () => finish({ ...repository, branch: "remote" }));
  expect(view.result.current.repository?.branch).toBe("remote");
});
