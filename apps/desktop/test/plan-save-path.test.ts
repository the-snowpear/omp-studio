import assert from "node:assert/strict";
import { basename, join, sep } from "node:path";
import { describe, test } from "node:test";

import { planSaveRelativeTarget } from "../src/plan-save-path.js";

describe("planSaveRelativeTarget", () => {
  test("maps a file at the workspace root", () => {
    const root = sep === "\\" ? "D:\\work\\project" : "/work/project";
    assert.deepEqual(planSaveRelativeTarget(root, join(root, "PLAN.md")), {
      status: "picked",
      relativePath: "PLAN.md",
    });
  });

  test("maps nested files and normalizes separators to forward slashes", () => {
    const root = sep === "\\" ? "D:\\work\\project" : "/work/project";
    const result = planSaveRelativeTarget(root, join(root, "docs", "plans", "auth.md"));
    assert.deepEqual(result, { status: "picked", relativePath: "docs/plans/auth.md" });
    assert.ok(!result.status.startsWith("outside") && !result.relativePath.includes("\\"));
  });

  test("rejects a sibling directory outside the workspace", () => {
    const parent = sep === "\\" ? "D:\\work" : "/work";
    const root = join(parent, "project");
    const result = planSaveRelativeTarget(root, join(parent, "elsewhere", "PLAN.md"));
    assert.deepEqual(result, { status: "outside-workspace", fileName: "PLAN.md" });
  });

  test("treats picking the workspace directory itself as outside", () => {
    const root = sep === "\\" ? "D:\\work\\project" : "/work/project";
    const result = planSaveRelativeTarget(root, root);
    assert.deepEqual(result, { status: "outside-workspace", fileName: basename(root) });
  });

  if (sep === "\\") {
    test("rejects a path on another drive", () => {
      const result = planSaveRelativeTarget("D:\\work\\project", "C:\\plans\\PLAN.md");
      assert.deepEqual(result, { status: "outside-workspace", fileName: "PLAN.md" });
    });

    test("accepts forward-slash absolute input from the dialog", () => {
      const result = planSaveRelativeTarget("D:/work/project", "D:/work/project/docs/PLAN.md");
      assert.deepEqual(result, { status: "picked", relativePath: "docs/PLAN.md" });
    });
  }
});
