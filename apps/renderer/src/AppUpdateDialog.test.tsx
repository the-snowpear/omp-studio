import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppUpdateDialog } from "./AppUpdateDialog";

afterEach(cleanup);

it("allows signed hot downloads without an exposed download URL and applies only when ready", async () => {
  const download = vi.fn().mockResolvedValue(false);
  const apply = vi.fn().mockResolvedValue(false);
  const props = { update: { currentVersion: "0.1.3", version: "0.1.4", plan: "hot" as const }, onClose: vi.fn(), onDownloadAndInstall: download, onApply: apply };
  const { rerender } = render(<AppUpdateDialog {...props} />);
  const button = screen.getByRole("button", { name: "下载并安装" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(download).toHaveBeenCalledOnce());
  expect(apply).not.toHaveBeenCalled();
  rerender(<AppUpdateDialog {...props} readyToApply />);
  fireEvent.click(screen.getByRole("button", { name: "应用并重启" }));
  await waitFor(() => expect(apply).toHaveBeenCalledOnce());
});
