import { expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { createShellModelLoader, type ShellModelScope } from "./shellModelLoader";
const scope = (key: string): ShellModelScope => ({ authority: key, workspace: key, runtime: key, environment: key });

it("shares concurrent shell loads and publishes projects before slow history", async () => {
  let finish!: (value: unknown) => void;
  const history = new Promise(resolve => { finish = resolve; });
  const query = vi.fn(async (name: string) => name === "history.list" ? history : { name });
  const loader = createShellModelLoader({ query } as unknown as StudioClient);
  const publish = vi.fn(), settled = vi.fn();
  const first = loader.load(scope("epoch-1"), "workbench", publish, settled);
  const second = loader.load(scope("epoch-1"), "workbench", vi.fn(), vi.fn());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(query.mock.calls.filter(([name]) => name === "projects.list")).toHaveLength(1);
  expect(publish).toHaveBeenCalledWith({ workspaces: { name: "projects.list" } });
  expect(settled).toHaveBeenCalledOnce();
  expect(query.mock.calls.some(([name]) => name === "home.get" || name === "diagnostics.get")).toBe(false);
  finish({ entries: [] }); await Promise.all([first, second]);
  await loader.load(scope("epoch-1"), "workbench", vi.fn(), vi.fn());
  expect(query.mock.calls.filter(([name]) => name === "projects.list")).toHaveLength(1);
});

it("keeps Host projects usable during Runtime preparation without loading Runtime domains", async () => {
  const query = vi.fn(async () => ({}));
  const loader = createShellModelLoader({ query } as unknown as StudioClient);
  await loader.load({ ...scope("host"), connecting: true }, "workbench", vi.fn(), vi.fn());
  expect(query.mock.calls).toHaveLength(2);
  await loader.load({ ...scope("host"), runtime: "ready", environment: "ready" }, "workbench", vi.fn(), vi.fn());
  expect(query.mock.calls).toHaveLength(5);
});

it("keeps new Runtime generations separate and fetches optional pages on demand", async () => {
  const query = vi.fn(async (name: string) => ({ name }));
  const loader = createShellModelLoader({ query } as unknown as StudioClient);
  await Promise.all([loader.load(scope("epoch-1"), "home", vi.fn(), vi.fn()), loader.page(scope("epoch-1"), "home", vi.fn()), loader.load(scope("epoch-2"), "workbench", vi.fn(), vi.fn())]);
  expect(query.mock.calls.filter(([name]) => name === "home.get")).toHaveLength(1);
  expect(query.mock.calls.filter(([name]) => name === "history.list")).toHaveLength(2);
  await loader.page(scope("epoch-2"), "diagnostics", vi.fn());
  expect(query.mock.calls.filter(([name]) => name === "diagnostics.get")).toHaveLength(1);
});

it("does not commit cancelled results and lets the replacement view join the same request", async () => {
  let finish!: (value: unknown) => void;
  const gate = new Promise(resolve => { finish = resolve; });
  const query = vi.fn(() => gate);
  const loader = createShellModelLoader({ query } as unknown as StudioClient);
  const current = vi.fn();
  const first = loader.load(scope("same"), "workbench", () => false, vi.fn());
  const second = loader.load(scope("same"), "workbench", current, vi.fn());
  finish({ ready: true });
  await Promise.all([first, second]);
  expect(current).toHaveBeenCalledTimes(5);
  expect(query).toHaveBeenCalledTimes(5);
  await loader.load(scope("same"), "workbench", vi.fn(), vi.fn());
  expect(query).toHaveBeenCalledTimes(5);
});

it("refreshes only workspace and Runtime-specific data when switching resident sessions", async () => {
  const query = vi.fn(async (name: string) => ({ name }));
  const loader = createShellModelLoader({ query } as unknown as StudioClient);
  const a = { ...scope("authority-1"), workspace: "workspace-a", workspaceId: "a" as never };
  const b = { ...a, workspace: "workspace-b", workspaceId: "b" as never, runtime: "resident-b" };
  await loader.load(a, "workbench", vi.fn(), vi.fn());
  await loader.load(b, "workbench", vi.fn(), vi.fn());
  expect(query.mock.calls.filter(([name]) => name === "projects.list")).toHaveLength(1);
  expect(query.mock.calls.filter(([name]) => name === "environment.get")).toHaveLength(1);
  expect(query.mock.calls.filter(([name]) => name === "commands.getManifest")).toHaveLength(2);
  expect(query.mock.calls.filter(([name]) => name === "history.list")).toHaveLength(2);
  expect(query).toHaveBeenCalledWith("history.list", expect.objectContaining({ workspaceId: "b" }));
});
