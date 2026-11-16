import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { WorktreeLaunchGate } from "./SessionWorktreesPane";
import { waitReceipt } from "../hostError";

vi.mock("../preview/PreviewContext", () => ({ usePreviewMode: () => ({ preview: false }) }));
vi.mock("../hostError", async original => ({ ...await original<typeof import("../hostError")>(), waitReceipt: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function setup() {
  const command = vi.fn(async (kind: string) => ({ requestId: kind }));
  const client = { command } as unknown as StudioClient;
  const context = { available: true, sessionId: "session-1", capabilities: { capabilities: [{ id: "worktrees.session.startPolicy", grade: "supported" }] } } as never;
  const onGateChange = vi.fn();
  vi.mocked(waitReceipt).mockResolvedValue({ result: { eligible: true, policy: "ask" } });
  return { command, client, context, onGateChange, visible: true };
}

it("allows closing and reopening a failed choice without pretending the Runtime accepted it", async () => {
  const props = setup();
  render(<WorktreeLaunchGate {...props} />);
  await screen.findByRole("dialog");
  props.command.mockRejectedValueOnce(Error("runtime lost (OUTCOME_UNKNOWN)"));
  fireEvent.click(screen.getByRole("button", { name: "创建并进入" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "关闭工作区选择" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(props.onGateChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "显示工作区选择" }));
  expect(screen.getByRole("alert").textContent).toContain("OUTCOME_UNKNOWN");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("can dismiss a pending continue command and retry after its failure", async () => {
  const props = setup();
  render(<WorktreeLaunchGate {...props} />);
  await screen.findByRole("dialog");
  let fail!: (error: Error) => void;
  vi.mocked(waitReceipt).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  fireEvent.click(screen.getByRole("button", { name: "留在当前工作区" }));
  await waitFor(() => expect(fail).toBeDefined());
  expect(screen.getByRole("status").textContent).toContain("正在确认");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => fail(Error("Runtime disconnected")));
  fireEvent.click(screen.getByRole("button", { name: "显示工作区选择" }));
  fireEvent.click(screen.getByRole("button", { name: "留在当前工作区" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(props.onGateChange).toHaveBeenLastCalledWith(false);
});

it("reopens an already created worktree when switching to it fails", async () => {
  const props = setup();
  const onOpenWorkspace = vi.fn()
    .mockRejectedValueOnce(new Error("Workspace could not be opened"))
    .mockResolvedValueOnce(undefined);
  render(<WorktreeLaunchGate {...props} onOpenWorkspace={onOpenWorkspace} />);
  await screen.findByRole("dialog");
  vi.mocked(waitReceipt).mockResolvedValueOnce({ result: { workspaceId: "workspace-created" } });
  fireEvent.click(screen.getByRole("button", { name: "创建并进入" }));
  await screen.findByText("Workspace could not be opened");
  fireEvent.click(screen.getByRole("button", { name: "重试打开已创建的 Worktree" }));
  await waitFor(() => expect(props.onGateChange).toHaveBeenLastCalledWith(false));
  expect(props.command.mock.calls.filter(([kind]) => kind === "worktrees.session.create")).toHaveLength(1);
  expect(onOpenWorkspace).toHaveBeenCalledTimes(2);
  expect(onOpenWorkspace).toHaveBeenLastCalledWith("workspace-created");
});

it("offers the created worktree again after the Runtime disconnects during the switch", async () => {
  const props = setup();
  let failOpen!: (error: Error) => void;
  const onOpenWorkspace = vi.fn(() => new Promise<void>((_resolve, reject) => { failOpen = reject; }));
  const view = render(<WorktreeLaunchGate {...props} onOpenWorkspace={onOpenWorkspace} />);
  await screen.findByRole("dialog");
  vi.mocked(waitReceipt).mockResolvedValueOnce({ result: { workspaceId: "workspace-created" } });
  fireEvent.click(screen.getByRole("button", { name: "创建并进入" }));
  await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledWith("workspace-created"));
  view.rerender(<WorktreeLaunchGate {...props} onOpenWorkspace={onOpenWorkspace} context={{ ...props.context as object, available: false } as never} />);
  await act(async () => failOpen(new Error("Runtime disconnected")));
  vi.mocked(waitReceipt).mockResolvedValueOnce({ result: { eligible: false, policy: "create" } });
  view.rerender(<WorktreeLaunchGate {...props} onOpenWorkspace={onOpenWorkspace} />);
  await screen.findByRole("button", { name: "重试打开已创建的 Worktree" });
  onOpenWorkspace.mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole("button", { name: "重试打开已创建的 Worktree" }));
  await waitFor(() => expect(props.onGateChange).toHaveBeenLastCalledWith(false));
  expect(props.command.mock.calls.filter(([kind]) => kind === "worktrees.session.create")).toHaveLength(1);
  expect(onOpenWorkspace).toHaveBeenCalledTimes(2);
});

it("removes the modal when the Runtime becomes unavailable", async () => {
  const props = setup();
  const view = render(<WorktreeLaunchGate {...props} />);
  await screen.findByRole("dialog");
  view.rerender(<WorktreeLaunchGate {...props} context={{ ...props.context as object, available: false } as never} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(props.onGateChange).toHaveBeenLastCalledWith(false);
});
