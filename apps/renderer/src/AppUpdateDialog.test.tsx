import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppUpdateDialog } from "./AppUpdateDialog";

afterEach(cleanup);

it("prepares signed updates without an exposed URL and restarts only when ready", async () => {
  const download = vi.fn().mockResolvedValue(false);
  const apply = vi.fn().mockResolvedValue(false);
  const props = { update: { currentVersion: "0.1.3", version: "0.1.4", reason: "restart-update" }, onClose: vi.fn(), onDownloadAndInstall: download, onApply: apply };
  const { rerender } = render(<AppUpdateDialog {...props} />);
  const button = screen.getByRole("button", { name: "下载更新" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(download).toHaveBeenCalledOnce());
  expect(apply).not.toHaveBeenCalled();
  rerender(<AppUpdateDialog {...props} readyToApply />);
  fireEvent.click(screen.getByRole("button", { name: "重启更新" }));
  await waitFor(() => expect(apply).toHaveBeenCalledOnce());
});

it("offers skipping for desktop updates but not for Runtime-only updates", () => {
  const props = { update: { component: "runtime" as const, currentVersion: "18.0.0-studio.1", version: "18.0.0-studio.2" }, onClose: vi.fn(), onSkip: vi.fn() };
  const { rerender } = render(<AppUpdateDialog {...props} />);
  expect(screen.queryByRole("button", { name: "跳过此版本" })).toBeNull();
  rerender(<AppUpdateDialog {...props} update={{ component: "app", currentVersion: "0.1.5", version: "0.1.6" }} />);
  expect(screen.getByRole("button", { name: "跳过此版本" })).toBeTruthy();
});

it("shows restart blockers as a waiting status and retries application without downloading", async () => {
  const download = vi.fn(), apply = vi.fn().mockResolvedValue(false);
  render(<AppUpdateDialog update={{ currentVersion: "0.1.5", version: "0.1.6" }} readyToApply applyNotice="请处理待确认的交互后重试" onClose={vi.fn()} onDownloadAndInstall={download} onApply={apply} />);
  expect(screen.getByRole("status").textContent).toContain("待确认的交互");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/下载失败/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重启更新" }));
  await waitFor(() => expect(apply).toHaveBeenCalledOnce());
  expect(download).not.toHaveBeenCalled();
});

it("uses a restart status without download progress while applying", async () => {
  let finishApply!: (value: boolean) => void;
  const apply = vi.fn(() => new Promise<boolean>(resolve => { finishApply = resolve; }));
  render(<AppUpdateDialog update={{ currentVersion: "0.1.5", version: "0.1.6" }} readyToApply receivedBytes={50} totalBytes={100} onClose={vi.fn()} onApply={apply} />);
  fireEvent.click(screen.getByRole("button", { name: "重启更新" }));
  expect(screen.getByRole("status").textContent).toBe("正在重启…");
  expect(screen.queryByText(/正在下载/)).toBeNull();
  expect(screen.queryByText("50%")).toBeNull();
  expect((screen.getByRole("button", { name: "正在重启…" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finishApply(false));
});

it("labels checks, downloads and application errors by their stage", () => {
  const props = { update: { currentVersion: "0.1.5", version: "0.1.6" }, onClose: vi.fn() };
  const { rerender } = render(<AppUpdateDialog {...props} applyError="Installer unavailable" />);
  expect(screen.getByRole("alert").textContent).toBe("应用更新失败: Installer unavailable");
  expect(screen.queryByText(/下载失败/)).toBeNull();
  rerender(<AppUpdateDialog {...props} checkError="HTTP 403" />);
  expect(screen.getByRole("alert").textContent).toBe("检查更新失败: HTTP 403");
  rerender(<AppUpdateDialog {...props} downloadError="Connection reset" />);
  expect(screen.getByRole("alert").textContent).toBe("下载失败: Connection reset");
});

it("explains Runtime compatibility and disables downloading until the blocker clears", async () => {
  const download = vi.fn().mockResolvedValue(false);
  const update = { component: "runtime" as const, currentVersion: "18.10.4-studio.8", version: "18.12.6-studio.1", blockedReason: "Runtime 至少需要桌面 0.1.11，请先更新桌面" };
  const props = { update, onClose: vi.fn(), onDownloadAndInstall: download };
  const { rerender } = render(<AppUpdateDialog {...props} />);
  expect(screen.getByRole("status").textContent).toContain("请先更新桌面");
  const button = screen.getByRole("button", { name: "下载更新" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(download).not.toHaveBeenCalled();
  expect(screen.queryByText(/下载失败/)).toBeNull();
  rerender(<AppUpdateDialog {...props} update={{ ...update, blockedReason: undefined }} />);
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(download).toHaveBeenCalledOnce());
});

it("simulates preparation and restarting locally in preview", async () => {
  vi.useFakeTimers();
  const download = vi.fn(), apply = vi.fn();
  try {
    render(<AppUpdateDialog preview update={{ currentVersion: "0.1.5", version: "0.1.6" }} onClose={vi.fn()} onApply={apply} onDownloadAndInstall={download} />);
    fireEvent.click(screen.getByRole("button", { name: "下载更新" }));
    await act(async () => vi.advanceTimersByTime(1600));
    fireEvent.click(screen.getByRole("button", { name: "重启更新" }));
    expect(screen.getByRole("status").textContent).toBe("正在重启…");
    await act(async () => vi.advanceTimersByTime(600));
    expect(screen.getByText(/已模拟重启更新/)).toBeTruthy();
    expect(download).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
