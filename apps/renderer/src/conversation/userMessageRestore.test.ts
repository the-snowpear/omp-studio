import { describe, expect, it, vi } from "vitest";
import {
  executeUserMessageBranch,
  executeUserMessageRestore,
  userMessageRestoreDisabledReason,
} from "./userMessageRestore";

describe("historical user-message actions", () => {
  it("does not require an already-running conversation when the tree target can be activated", () => {
    expect(userMessageRestoreDisabledReason({
      preview: false,
      running: false,
      compacting: false,
      resyncRequired: false,
      sessionCreating: false,
      gated: false,
      canNavigateTree: true,
    })).toBeUndefined();
  });

  it("restores through the supplied historical-session navigator after confirmation", async () => {
    const navigate = vi.fn(async () => ({ text: "历史消息" }));
    const reload = vi.fn(async () => {});
    const fillComposer = vi.fn();
    const clearQueued = vi.fn();

    await expect(executeUserMessageRestore({
      preview: false,
      itemId: "message-1",
      text: "fallback",
      confirm: () => true,
      restorePreview: () => false,
      navigate,
      reload,
      fillComposer,
      clearQueued,
    })).resolves.toBe("ok");

    expect(navigate).toHaveBeenCalledWith("message-1");
    expect(reload).toHaveBeenCalledOnce();
    expect(fillComposer).toHaveBeenCalledWith({ text: "历史消息" });
  });

  it("selects the branched historical session and preserves its composer fill", async () => {
    const branch = vi.fn(async () => ({ sessionId: "branched", text: "历史消息" }));
    const selectSession = vi.fn(async () => true);
    const stashComposerFill = vi.fn();

    await expect(executeUserMessageBranch({
      preview: false,
      itemId: "message-2",
      text: "fallback",
      confirm: () => true,
      restorePreview: () => false,
      branch,
      selectSession,
      reload: vi.fn(async () => {}),
      fillComposer: vi.fn(),
      stashComposerFill,
      clearQueued: vi.fn(),
    })).resolves.toBe("ok");

    expect(branch).toHaveBeenCalledWith("message-2");
    expect(stashComposerFill).toHaveBeenCalledWith("branched", { text: "历史消息" });
    expect(selectSession).toHaveBeenCalledWith("branched");
  });
});
