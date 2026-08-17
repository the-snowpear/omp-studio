import { describe, expect, it } from "vitest";

import { claimTransientToast, isTransientStatusNotice, transientStatusFamily } from "./transientStatusNotice";

describe("transientStatusNotice", () => {
  it("classifies the /fast service-tier notice and the matching command error", () => {
    expect(isTransientStatusNotice(
      "The current model has no service-tier control for /fast to toggle.",
      "priority",
    )).toBe(true);
    expect(transientStatusFamily(
      "The current model has no service-tier control for fast mode",
    )).toBe("fast-tier");
  });

  it("classifies the Prewalk noop notice and the matching command error", () => {
    expect(isTransientStatusNotice(
      "Prewalk: target sub2api-go/mimo-v2.5 already matches the active model and thinking level; nothing to switch.",
      "prewalk",
    )).toBe(true);
    expect(transientStatusFamily(
      "Prewalk target already matches the active model and thinking level",
    )).toBe("prewalk-noop");
  });

  it("leaves other Fast / Prewalk notices in the transcript", () => {
    expect(isTransientStatusNotice(
      "Priority/fast mode rejected for this model; retried without it. Fast mode is now off.",
      "priority",
    )).toBe(false);
    expect(isTransientStatusNotice(
      "Prewalk: switched to sub2api-go/mimo-v2.5 after first edit call.",
      "prewalk",
    )).toBe(false);
  });

  it("suppresses a duplicate toast from the notice+error pair", () => {
    const first = claimTransientToast("fast-tier", undefined, 1_000);
    expect(first.show).toBe(true);
    const second = claimTransientToast("fast-tier", first.next, 1_400);
    expect(second.show).toBe(false);
    const later = claimTransientToast("fast-tier", first.next, 4_000);
    expect(later.show).toBe(true);
  });
});
