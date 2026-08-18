import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetAskConfirmationNoticeForTests,
  clearAskConfirmationNotice,
  notifyAskConfirmation,
} from "./desktopNotice";

afterEach(() => {
  __resetAskConfirmationNoticeForTests();
  Reflect.deleteProperty(globalThis, "ompStudioChrome");
});

describe("notifyAskConfirmation", () => {
  it("shows one Windows notice per interaction lease and ignores repeats", async () => {
    const notify = vi.fn(async () => undefined);
    globalThis.ompStudioChrome = { notify } as unknown as NonNullable<typeof globalThis.ompStudioChrome>;
    notifyAskConfirmation("ia-1", 1, "Need inertia?");
    notifyAskConfirmation("ia-1", 1, "Need inertia?");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ title: "等待确认", body: "Need inertia?" });
    notifyAskConfirmation("ia-1", 2, "Need inertia?");
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("allows a new notice after the matching lease is resolved", async () => {
    const notify = vi.fn(async () => undefined);
    globalThis.ompStudioChrome = { notify } as unknown as NonNullable<typeof globalThis.ompStudioChrome>;
    notifyAskConfirmation("ia-1", 1, "Need inertia?");
    clearAskConfirmationNotice("ia-1", 1);
    notifyAskConfirmation("ia-1", 1, "Need inertia?");
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
