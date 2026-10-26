import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopUpdateRecovery } from "./DesktopUpdateRecovery";
import { __resetAppUpdateForTests } from "./appUpdate";

beforeEach(() => __resetAppUpdateForTests());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); __resetAppUpdateForTests(); });

it("shows the verified target and requires a separate restart after preparation", async () => {
  const rollbackUpdate = vi.fn().mockResolvedValue({ ok: true });
  const applyUpdate = vi.fn().mockResolvedValue({ ok: true, deferred: true, message: "Finish active sessions" });
  vi.stubGlobal("ompStudioChrome", {
    rollbackUpdate, applyUpdate,
    getUpdateSnapshot: async () => ({ schema: 2, checking: false, rollbackAppVersion: "0.1.4", rollbackAppPending: true, app: { component: "app", currentVersion: "0.1.5", version: "0.1.4", phase: "ready" }, runtime: { component: "runtime", phase: "idle" } }),
  });
  __resetAppUpdateForTests({ rollbackVersion: "0.1.4" });
  render(<DesktopUpdateRecovery preview={false} />);
  expect(screen.getByText(/恢复目标: 0.1.4/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "准备上一版本" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "重启恢复" })).toBeTruthy());
  expect(rollbackUpdate).toHaveBeenCalledOnce();
  expect(applyUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重启恢复" }));
  await waitFor(() => expect(screen.getAllByRole("status").some(node => node.textContent?.includes("Finish active sessions"))).toBe(true));
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByRole("button", { name: "重启恢复" }) as HTMLButtonElement).disabled).toBe(false);
});

it("keeps recovery unavailable without a verified previous version and reports preparation errors", async () => {
  vi.stubGlobal("ompStudioChrome", { rollbackUpdate: vi.fn().mockResolvedValue({ ok: false, message: "Download failed" }), getUpdateSnapshot: vi.fn() });
  render(<DesktopUpdateRecovery preview={false} />);
  expect((screen.getByRole("button", { name: "准备上一版本" }) as HTMLButtonElement).disabled).toBe(true);
  act(() => __resetAppUpdateForTests({ rollbackVersion: "0.1.4" }));
  fireEvent.click(screen.getByRole("button", { name: "准备上一版本" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Download failed"));
});

it("simulates both preview steps without calling desktop APIs", () => {
  const rollbackUpdate = vi.fn(), applyUpdate = vi.fn();
  vi.stubGlobal("ompStudioChrome", { rollbackUpdate, applyUpdate });
  render(<DesktopUpdateRecovery preview />);
  fireEvent.click(screen.getByRole("button", { name: "准备上一版本" }));
  fireEvent.click(screen.getByRole("button", { name: "重启恢复" }));
  expect(screen.getByRole("status").textContent).toContain("演示");
  expect(rollbackUpdate).not.toHaveBeenCalled(); expect(applyUpdate).not.toHaveBeenCalled();
});

it("shows restart progress while applying a prepared recovery", async () => {
  let finishApply!: (result: { ok: boolean; deferred: boolean; message: string }) => void;
  vi.stubGlobal("ompStudioChrome", {
    rollbackUpdate: vi.fn(),
    applyUpdate: () => new Promise(resolve => { finishApply = resolve; }),
  });
  __resetAppUpdateForTests({ rollbackVersion: "0.1.4", rollbackReady: true, readyToApply: true });
  render(<DesktopUpdateRecovery preview={false} />);
  fireEvent.click(screen.getByRole("button", { name: "重启恢复" }));
  expect((screen.getByRole("button", { name: "正在重启…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/正在下载/)).toBeNull();
  await act(async () => finishApply({ ok: true, deferred: true, message: "等待交互完成" }));
  expect(screen.getByRole("button", { name: "重启恢复" })).toBeTruthy();
});
