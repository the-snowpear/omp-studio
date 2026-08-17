import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ThreadWaitChip } from "./ThreadWaitChip";

afterEach(cleanup);

describe("ThreadWaitChip", () => {
  it("renders 待确认 / 待审核 / 待回答 on the far-right capsule", () => {
    const { rerender } = render(<ThreadWaitChip kind="approval" />);
    expect(screen.getByRole("status", { name: "待确认" }).className).toContain("t-wait");
    rerender(<ThreadWaitChip kind="plan" />);
    expect(screen.getByRole("status", { name: "待审核" })).toBeTruthy();
    rerender(<ThreadWaitChip kind="ask" />);
    expect(screen.getByRole("status", { name: "待回答" })).toBeTruthy();
  });
});
