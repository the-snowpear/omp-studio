import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BtwSnapshot } from "@omp-studio/client-contract";
import { BtwStatusLine, btwStatusLabel } from "./BtwStatusLine";

afterEach(cleanup);

function snap(partial: Partial<BtwSnapshot> & Pick<BtwSnapshot, "status">): BtwSnapshot {
  return { ephemeralId: "e1", text: "", ...partial };
}

describe("BtwStatusLine", () => {
  it("labels the four BTW states, including the output-limit failure", () => {
    expect(btwStatusLabel(null)).toBe("待提问");
    expect(btwStatusLabel(snap({ status: "running" }))).toBe("正在回答");
    expect(btwStatusLabel(snap({ status: "completed" }))).toBe("已完成");
    expect(btwStatusLabel(snap({ status: "aborted" }))).toBe("已中止");
    expect(btwStatusLabel(snap({ status: "failed" }))).toBe("失败");
    expect(btwStatusLabel(snap({ status: "failed", error: { code: "OUTPUT_LIMIT", message: "too long" } }))).toBe(
      "超出输出上限",
    );
  });

  it("spins and sweeps while running, then freezes on a terminal state", () => {
    const startedAt = Date.now() - 12_000;
    const { rerender } = render(<BtwStatusLine snapshot={snap({ status: "running" })} startedAt={startedAt} />);
    const line = document.querySelector(".btw-status");
    expect(line?.getAttribute("data-status")).toBe("running");
    expect(screen.getByRole("status").textContent).toContain("正在回答");
    expect(screen.getByRole("status").textContent).toContain("12s");
    expect(document.querySelector(".btw-status-glyph")).not.toBeNull();

    rerender(<BtwStatusLine snapshot={snap({ status: "completed" })} startedAt={startedAt} />);
    expect(document.querySelector(".btw-status")?.getAttribute("data-status")).toBe("completed");
    expect(screen.getByRole("status").textContent).toContain("已完成");
    expect(screen.getByRole("status").textContent).toMatch(/\d+s/);
  });

  it("hides the glyph in the compact capsule variant", () => {
    render(<BtwStatusLine snapshot={snap({ status: "aborted" })} startedAt={Date.now()} compact />);
    expect(document.querySelector(".btw-status")?.classList.contains("compact")).toBe(true);
    expect(document.querySelector(".btw-status-glyph")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("已中止");
  });
});
