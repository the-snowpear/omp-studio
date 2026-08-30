import { describe, expect, it } from "vitest";
import { isNewConversationSurface, shouldShowConversationWelcome, type ConversationWelcomeInput } from "./welcomeGate";

const BASE: ConversationWelcomeInput = {
  preview: false,
  compacting: false,
  rowCount: 0,
  hydrateStatus: "ready",
};

describe("welcomeGate new-session handoff", () => {
  it("keeps the welcome through the post-create hydrate window", () => {
    // session.create 回执落地后 engine 按 identity 重建，hydrateStatus 依次经过
    // idle / loading 才到 ready；中途任一状态把欢迎页撤下都会闪一次骨架。
    for (const hydrateStatus of ["idle", "loading", "ready"] as const) {
      expect(isNewConversationSurface({ ...BASE, hydrateStatus })).toBe(true);
      expect(shouldShowConversationWelcome({ ...BASE, hydrateStatus })).toBe(true);
    }
  });

  it("still gates on compacting and selected sessions", () => {
    expect(shouldShowConversationWelcome({ ...BASE, hydrateStatus: "loading", compacting: true })).toBe(false);
    const selected: ConversationWelcomeInput = { ...BASE, hydrateStatus: "loading", selectedSessionId: "s1" };
    expect(isNewConversationSurface(selected)).toBe(false);
    expect(shouldShowConversationWelcome(selected)).toBe(false);
  });
});
