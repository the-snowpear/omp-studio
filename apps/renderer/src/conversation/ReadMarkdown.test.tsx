import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ToolBody } from "./ToolBody";

afterEach(cleanup);

it("renders native Markdown read previews while keeping untagged reads as source", () => {
  const tool = { toolCallId: "read-1", toolName: "read", status: "succeeded" as const, arguments: { path: "example.md" }, result: { type: "toolResult" as const, toolCallId: "read-1", toolName: "read", isError: false, data: { contentType: "text/markdown", preview: ["# Heading", "Hello **world**"] } } };
  const view = render(<ToolBody tool={tool} />);
  expect(view.container.querySelector("h1")?.textContent).toBe("Heading");
  expect(view.container.querySelector("strong")?.textContent).toBe("world");
  view.rerender(<ToolBody tool={{ ...tool, result: { ...tool.result, data: { preview: ["# Heading"] } } }} />);
  expect(view.container.querySelector("h1")).toBeNull();
  expect(view.container.querySelector(".tc-code")?.textContent).toContain("# Heading");
});
