import { describe, expect, it } from "vitest";
import { isNewConversationSurface, shouldShowConversationWelcome } from "./welcomeGate";

const emptyIdle = {
  preview: false,
  compacting: false,
  rowCount: 0,
  hydrateStatus: "idle" as const,
};

describe("welcomeGate", () => {
  it("opens the welcome surface when there is no session and hydrate is unavailable", () => {
    const input = { ...emptyIdle, hydrateStatus: "unavailable" as const };
    expect(isNewConversationSurface(input)).toBe(true);
    expect(shouldShowConversationWelcome(input)).toBe(true);
  });

  it("keeps a selected session that failed to hydrate on the honest empty shell", () => {
    const input = { ...emptyIdle, selectedSessionId: "sess-1", hydrateStatus: "unavailable" as const };
    expect(isNewConversationSurface(input)).toBe(false);
    expect(shouldShowConversationWelcome(input)).toBe(false);
  });

  it("opens the welcome surface when hydrate is still idle and no session is selected", () => {
    expect(isNewConversationSurface(emptyIdle)).toBe(true);
    expect(shouldShowConversationWelcome(emptyIdle)).toBe(true);
  });

  it("opens the welcome surface for an empty ready session with no selection", () => {
    const input = { ...emptyIdle, hydrateStatus: "ready" as const };
    expect(isNewConversationSurface(input)).toBe(true);
    expect(shouldShowConversationWelcome(input)).toBe(true);
  });

  it("still welcomes a selected session whose empty transcript is ready", () => {
    const input = { ...emptyIdle, selectedSessionId: "sess-1", hydrateStatus: "ready" as const };
    expect(isNewConversationSurface(input)).toBe(false);
    expect(shouldShowConversationWelcome(input)).toBe(true);
  });

  it("forces welcome while session.create is in flight", () => {
    const input = {
      ...emptyIdle,
      sessionCreating: true,
      compacting: false,
      hydrateStatus: "unavailable" as const,
      rowCount: 3,
    };
    expect(isNewConversationSurface(input)).toBe(true);
    expect(shouldShowConversationWelcome(input)).toBe(true);
  });

  it("does not welcome while compacting", () => {
    const input = { ...emptyIdle, compacting: true, hydrateStatus: "ready" as const };
    expect(isNewConversationSurface(input)).toBe(false);
    expect(shouldShowConversationWelcome(input)).toBe(false);
  });
});
