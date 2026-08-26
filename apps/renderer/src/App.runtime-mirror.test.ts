import { describe, expect, it, vi } from "vitest";
import type { OperatorStateSnapshot, StudioPlanSaveAndQuitResult } from "@omp-studio/studio-protocol";

// App imports the terminal surface, but these pure wiring tests never render it.
// Keep xterm's canvas initialization out of jsdom so the test has no noisy stderr.
vi.mock("@xterm/xterm", () => ({ Terminal: class Terminal {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon {} }));

import { canStartPlanSaveAndQuit, planSaveAndQuitNotice, runtimeSettingsPropsOf } from "./App";

const runtimeSnapshot = {
  runtimeSettings: {
    "edit.autoRepair.enabled": true,
    "features.unexpectedStopDetection": "smart",
    "providers.unexpectedStopModel": "qwen3-1.7b",
    extendedContext: true,
    "compaction.asyncEnabled": false,
    "compaction.methodOrder": ["remote", "snapcompact", "handoff", "soft", "shake"],
    "providers.openai-codex.codeMode": "auto",
  },
  compactionSpeculation: "running",
} as OperatorStateSnapshot;

describe("App runtime and plan receipt wiring", () => {
  it("only exposes the Runtime settings writer when the capability is present", () => {
    const onSet = vi.fn();

    expect(runtimeSettingsPropsOf(undefined, false, onSet)).toBeUndefined();
    const readOnly = runtimeSettingsPropsOf(runtimeSnapshot, false, onSet);
    expect(readOnly?.snapshot).toEqual(runtimeSnapshot.runtimeSettings);
    expect(readOnly?.onSet).toBeUndefined();
    expect(runtimeSettingsPropsOf(runtimeSnapshot, true, onSet)?.onSet).toBe(onSet);
  });

  it("blocks a second save/exit request while the first receipt is pending", () => {
    expect(canStartPlanSaveAndQuit(true, false)).toBe(true);
    expect(canStartPlanSaveAndQuit(true, true)).toBe(false);
    expect(canStartPlanSaveAndQuit(false, false)).toBe(false);
  });

  it.each([
    ["started", true, "已创建并切换到新会话"],
    ["started", false, "未能自动切换"],
    ["cancelled", false, "新会话创建已取消"],
    ["failed", false, "新会话创建失败"],
  ] as const)("keeps save/exit receipt outcome honest: %s", (newSession, selected, expected) => {
    const result = {
      saved: true,
      path: "PLAN.md",
      exitedPlan: true,
      newSession,
    } as StudioPlanSaveAndQuitResult;
    const notice = planSaveAndQuitNotice(result, selected);
    expect(notice).toContain("已保存 PLAN.md，Plan 已退出");
    expect(notice).toContain(expected);
  });
});
