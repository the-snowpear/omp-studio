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
