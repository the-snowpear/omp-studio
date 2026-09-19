import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
