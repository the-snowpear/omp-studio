/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientEvent, GitRepositoryReadModel, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { useGitRepository } from "./useGitRepository";

const execution = vi.hoisted(() => ({ syncRevision: 0 }));
vi.mock("../workspaces/ExecutionTargets", () => ({ useExecutionTarget: () => execution }));
afterEach(async () => { cleanup(); await Promise.resolve(); execution.syncRevision = 0; });

const workspace = "workspace" as WorkspaceId;
function repository(workspaceId = workspace, branch = "main"): GitRepositoryReadModel {
  return { workspaceId, isRepository: true, branch, detached: false, unborn: false, ahead: 0, behind: 0, stashCount: 0, changes: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  const listeners = new Set<(event: ClientEvent) => void>();
  const query = vi.fn(async (_name: string, input: { workspaceId: WorkspaceId }) => repository(input.workspaceId));
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_scope: unknown, listener: (event: ClientEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); unsubscribe(); };
  });
  const client = { query, subscribe } as unknown as StudioClient;
  return {
    client, query, subscribe, unsubscribe,
    changed(workspaceId = workspace) {
      for (const listener of listeners) listener({ kind: "git.repository.changed", repository: { workspaceId, reason: "external" } } as ClientEvent);
    },
  };
}
function Consumer({ client, workspaceId = workspace, name }: { client: StudioClient; workspaceId?: WorkspaceId; name: string }) {
  const result = useGitRepository(client, workspaceId);
  return <section>
    <output data-testid={name}>{result.error ?? result.repository?.branch ?? "empty"}</output>
    <span data-testid={`${name}-loading`}>{String(result.loading)}</span>
    <button onClick={() => { void result.refresh(); }}>Refresh {name}</button>
  </section>;
}

it("shares the initial read and subscription across consumers and StrictMode replay", async () => {
  const f = fixture();
  const initial = deferred<GitRepositoryReadModel>();
  f.query.mockReturnValueOnce(initial.promise);
  const view = render(<StrictMode><Consumer client={f.client} name="tree" /><Consumer client={f.client} name="composer" /></StrictMode>);
  await waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
  expect(f.subscribe).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("tree-loading").textContent).toBe("true");
  await act(async () => initial.resolve(repository()));
  expect(screen.getByTestId("tree").textContent).toBe("main");
  expect(screen.getByTestId("composer").textContent).toBe("main");

  view.rerender(<StrictMode><Consumer client={f.client} name="tree" /></StrictMode>);
  await act(async () => f.changed());
  expect(f.unsubscribe).not.toHaveBeenCalled();
  expect(f.query).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => {});
  expect(f.unsubscribe).toHaveBeenCalledTimes(1);
});

it("discards an older fetch and reads once more for changes received during it", async () => {
  const f = fixture();
  const oldRead = deferred<GitRepositoryReadModel>();
  const latestRead = deferred<GitRepositoryReadModel>();
  f.query.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(latestRead.promise);
  render(<><Consumer client={f.client} name="tree" /><Consumer client={f.client} name="composer" /></>);
  await waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
  act(() => { f.changed(); f.changed(); });
  expect(f.query).toHaveBeenCalledTimes(1);
  await act(async () => oldRead.resolve(repository(workspace, "stale")));
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("tree").textContent).toBe("empty");
  expect(screen.getByTestId("composer-loading").textContent).toBe("true");
  await act(async () => latestRead.resolve(repository(workspace, "latest")));
  expect(screen.getByTestId("tree").textContent).toBe("latest");
  expect(screen.getByTestId("composer").textContent).toBe("latest");
  act(() => f.changed("another-workspace" as WorkspaceId));
  expect(f.query).toHaveBeenCalledTimes(2);
});

it("keeps workspace and execution-client changes isolated and releases the last consumer", async () => {
  const local = fixture();
  const remote = fixture();
  const oldRead = deferred<GitRepositoryReadModel>();
  const remoteRead = deferred<GitRepositoryReadModel>();
  local.query.mockReturnValueOnce(oldRead.promise);
  remote.query.mockReturnValueOnce(remoteRead.promise);
  const view = render(<Consumer client={local.client} name="tree" />);
  await waitFor(() => expect(local.query).toHaveBeenCalledTimes(1));
  view.rerender(<Consumer client={remote.client} name="tree" />);
  await act(async () => oldRead.resolve(repository(workspace, "local-old")));
  expect(local.unsubscribe).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("tree").textContent).toBe("empty");
  await act(async () => remoteRead.resolve(repository(workspace, "remote")));
  expect(screen.getByTestId("tree").textContent).toBe("remote");

  const nextWorkspace = "next-workspace" as WorkspaceId;
  const nextRead = deferred<GitRepositoryReadModel>();
  remote.query.mockReturnValueOnce(nextRead.promise);
  view.rerender(<Consumer client={remote.client} workspaceId={nextWorkspace} name="tree" />);
  expect(screen.getByTestId("tree").textContent).toBe("empty");
  await act(async () => nextRead.resolve(repository(nextWorkspace, "other-project")));
  expect(remote.unsubscribe).toHaveBeenCalledTimes(1);
  expect(remote.query).toHaveBeenLastCalledWith("git.repository.get", { workspaceId: nextWorkspace });
  expect(screen.getByTestId("tree").textContent).toBe("other-project");

  view.unmount();
  await act(async () => {});
  expect(remote.unsubscribe).toHaveBeenCalledTimes(2);
  remote.query.mockResolvedValueOnce(repository(workspace, "remote-reopened"));
  render(<Consumer client={remote.client} name="tree" />);
  await waitFor(() => expect(screen.getByTestId("tree").textContent).toBe("remote-reopened"));
  expect(remote.query).toHaveBeenCalledTimes(3);
});

it("shares manual refresh, preserves useful errors and resynchronizes once per key", async () => {
  const f = fixture();
  const consumers = () => <><Consumer client={f.client} name="tree" /><Consumer client={f.client} name="composer" /></>;
  const view = render(consumers());
  await waitFor(() => expect(screen.getByTestId("tree").textContent).toBe("main"));
  const failedRead = deferred<GitRepositoryReadModel>();
  f.query.mockReturnValueOnce(failedRead.promise);
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh tree" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh composer" }));
  });
  await waitFor(() => expect(f.query).toHaveBeenCalledTimes(2));
  await act(async () => failedRead.reject({ message: "SSH connection unavailable" }));
  expect(screen.getByTestId("tree").textContent).toBe("SSH connection unavailable");
  expect(screen.getByTestId("composer").textContent).toBe("SSH connection unavailable");
  expect(screen.getByTestId("tree-loading").textContent).toBe("false");

  const synchronizedRead = deferred<GitRepositoryReadModel>();
  const recoveredRead = deferred<GitRepositoryReadModel>();
  f.query.mockReturnValueOnce(synchronizedRead.promise).mockReturnValueOnce(recoveredRead.promise);
  execution.syncRevision = 1;
  view.rerender(consumers());
  await waitFor(() => expect(f.query).toHaveBeenCalledTimes(3));
  // A second sync during an outstanding read must not join its stale result.
  execution.syncRevision = 2;
  view.rerender(consumers());
  await act(async () => synchronizedRead.resolve(repository(workspace, "before-resync")));
  expect(f.query).toHaveBeenCalledTimes(4);
  expect(screen.getByTestId("tree").textContent).toBe("SSH connection unavailable");
  await act(async () => recoveredRead.resolve(repository(workspace, "recovered")));
  expect(screen.getByTestId("tree").textContent).toBe("recovered");
  expect(screen.getByTestId("composer").textContent).toBe("recovered");
  expect(f.subscribe).toHaveBeenCalledTimes(1);
});
