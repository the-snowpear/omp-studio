import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityLine } from "./ActivityLine";
import { WORKING_LABEL } from "./activityStatus";

afterEach(cleanup);

describe("ActivityLine", () => {
  it("shows only working while waiting for the first assistant event", () => {
    render(<ActivityLine status={{ phase: "waiting", label: WORKING_LABEL }} startedAt={Date.now()} />);
    const line = document.querySelector(".activity-line");
    expect(line?.getAttribute("data-phase")).toBe("waiting");
    expect(screen.getByRole("status").textContent?.replace(/\s+/g, " ").trim()).toBe(WORKING_LABEL);
    expect(screen.queryByRole("button", { name: "停止当前运行" })).toBeNull();
  });

  it("reveals elapsed time and the live operation after the model starts responding", () => {
    render(
      <ActivityLine
        status={{ phase: "tool", label: "正在读取", detail: "App.tsx" }}
        startedAt={Date.now()}
      />,
    );
    const spoken = screen.getByRole("status").textContent ?? "";
    expect(spoken).toContain(WORKING_LABEL);
    expect(spoken).toContain("0s");
    expect(spoken).toContain("正在读取");
    expect(spoken).toContain("App.tsx");
    expect(screen.queryByText("停止")).toBeNull();
  });
});
