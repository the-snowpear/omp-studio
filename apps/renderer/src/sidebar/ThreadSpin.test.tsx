import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ThreadSpin } from "./ThreadSpin";

afterEach(cleanup);

describe("ThreadSpin", () => {
  it("keeps the folder-column gutter and names the spinner when running", () => {
    const { rerender, container } = render(<ThreadSpin running />);
    expect(container.querySelector(".t-gutter")).toBeTruthy();
    expect(screen.getByRole("img", { name: "运行中" }).className).toContain("t-spin");
    rerender(<ThreadSpin running={false} />);
    expect(container.querySelector(".t-gutter")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "运行中" })).toBeNull();
  });
});
