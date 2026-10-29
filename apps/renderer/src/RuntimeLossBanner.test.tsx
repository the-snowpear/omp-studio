import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RuntimeLossBanner } from "./RuntimeLossBanner";
afterEach(cleanup);
it("explains pending startup without offering a duplicate reconnect", () => {
  render(<RuntimeLossBanner runtime={{ status: "connecting", classification: "unavailable" }} />);
  expect(screen.getByRole("status").textContent).toContain("Runtime 正在准备");
  expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();
});
