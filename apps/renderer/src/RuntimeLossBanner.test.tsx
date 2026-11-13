import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { RuntimeLossBanner } from "./RuntimeLossBanner";
import { ensureRuntimeConnection } from "./runtimeEnsure";

vi.mock("./runtimeEnsure", () => ({ ensureRuntimeConnection: vi.fn() }));
afterEach(cleanup);
it("explains pending startup without offering a duplicate reconnect", () => {
  render(<RuntimeLossBanner runtime={{ status: "connecting", classification: "unavailable" }} />);
  expect(screen.getByRole("status").textContent).toContain("Runtime 正在准备");
  expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();
});

it("presents a conversation whose Runtime has not started as a quiet notice, not a failure", async () => {
  // Regression: an opened history conversation reports unavailable with no
  // failure facts until its first send, and was shown as a red alert.
  vi.mocked(ensureRuntimeConnection).mockResolvedValue({ ok: true, connection: { status: "connected", classification: "managed" } as never });
  const { rerender } = render(<RuntimeLossBanner client={{} as StudioClient} runtime={{ status: "unavailable", classification: "unavailable" }} />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("发送消息时会自动连接");
  fireEvent.click(screen.getByRole("button", { name: "立即连接" }));
  await waitFor(() => expect(ensureRuntimeConnection).toHaveBeenCalledTimes(1));
  // A recorded failure keeps the red alert.
  rerender(<RuntimeLossBanner client={{} as StudioClient} runtime={{ status: "unavailable", classification: "unavailable", unavailableCode: "launch-failed", unavailableReason: "Error: spawn failed" }} />);
  expect(screen.getByRole("alert").textContent).not.toContain("发送消息时会自动连接");
  expect(screen.getByRole("button", { name: "重新连接" })).toBeTruthy();
});

it("shows a failed reconnect reason once when Runtime reports the same failure", async () => {
  const reason = "Studio Bridge disconnected or Runtime exited before startup completed";
  vi.mocked(ensureRuntimeConnection).mockResolvedValue({ ok: false, message: reason });
  render(<RuntimeLossBanner
    client={{} as StudioClient}
    runtime={{ status: "unavailable", classification: "unavailable", unavailableCode: "launch-failed", unavailableReason: `Error: ${reason}` }}
  />);
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "重新连接" }).hasAttribute("disabled")).toBe(false));
  expect(screen.getByRole("alert").textContent?.split(reason)).toHaveLength(2);
});
