import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { DiffDisplayMode } from "../conversation/ChangesPanel";
import { GitPatch } from "./GitPatch";

afterEach(cleanup);

it("switches Git patches between unified and split views while keeping text and old/new line numbers", () => {
  const patch = "diff --git a/sample.ts b/sample.ts\n--- a/sample.ts\n+++ b/sample.ts\n@@ -7,2 +7,3 @@\n unchanged\n-old\n+new\n+++content\n\\ No newline at end of file\n@@ -20 +21 @@\n-last\n+latest\n";
  function Preview() {
    const [split, setSplit] = useState(false);
    return <I18nProvider forcedLanguage="en"><DiffDisplayMode split={split} onSplit={setSplit} /><div className={split ? "diff-split" : ""}><GitPatch patch={patch} split={split} /></div></I18nProvider>;
  }
  render(<Preview />);
  const oldRow = () => screen.getByText("old").closest(".dl")!;
  expect(oldRow().querySelectorAll(".ln")[0]?.textContent).toBe("8");
  expect(oldRow().querySelectorAll(".ln")[1]?.textContent).toBe("");
  expect(screen.getByText("++content").closest(".dl")?.querySelectorAll(".ln")[1]?.textContent).toBe("9");
  expect(screen.getByText("latest").closest(".dl")?.querySelectorAll(".ln")[1]?.textContent).toBe("21");

  fireEvent.click(screen.getByRole("radio", { name: "Split Diff" }));
  expect(screen.getByRole("radio", { name: "Split Diff" }).getAttribute("aria-checked")).toBe("true");
  expect(oldRow().querySelector(".half:first-child")?.textContent).toBe("8old");
  expect(oldRow().querySelector(".half:last-child")?.textContent).toBe("");
  expect(screen.getByText("new").closest(".half")?.previousElementSibling?.textContent).toBe("");
  expect(screen.getAllByText("unchanged")).toHaveLength(2);

  fireEvent.click(screen.getByRole("radio", { name: "Unified Diff" }));
  expect(screen.getByRole("radio", { name: "Unified Diff" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getAllByText("unchanged")).toHaveLength(1);
  expect(oldRow().querySelector(".half")).toBeNull();
});
