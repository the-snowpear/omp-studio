import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityLine } from "./ActivityLine";

describe("ActivityLine", () => {
  it("shows a pre-response send operation under the optimistic user row", () => {
    render(<ActivityLine status={{ phase: "waiting", label: "Starting OMP" }} />);
    expect(screen.getByRole("status").textContent).toContain("working");
    expect(screen.getByRole("status").textContent).toContain("Starting OMP");
  });
});
