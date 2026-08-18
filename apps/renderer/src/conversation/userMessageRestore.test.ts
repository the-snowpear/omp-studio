import { describe, expect, it, vi } from "vitest";
import {
  executeUserMessageBranch,
  executeUserMessageRestore,
  userMessageRestoreDisabledReason,
} from "./userMessageRestore";

const idle = {
  preview: false,
  running: false,
  compacting: false,
  resyncRequired: false,
  sessionCreating: false,
  gated: false,
  canNavigateTree: true,
};

describe("userMessageRestoreDisabledReason", () => {
  it("allows restore when idle and session.tree is available", () => {
    expect(userMessageRestoreDisabledReason(idle)).toBeUndefined();
  });

  it("blocks running, compacting, and resync", () => {
    expect(userMessageRestoreDisabledReason({ ...idle, running: true })).toBe("进行中");
    expect(userMessageRestoreDisabledReason({ ...idle, compacting: true })).toBe("压缩中");
    expect(userMessageRestoreDisabledReason({ ...idle, resyncRequired: true })).toBe("同步中");
  });

  it("does not require session.tree in preview", () => {
    expect(
      userMessageRestoreDisabledReason({
        ...idle,
        preview: true,
        gated: true,
        canNavigateTree: false,
      }),
    ).toBeUndefined();
  });
});

describe("executeUserMessageRestore", () => {
  it("preview restore fills composer and never navigates", async () => {
    const navigate = vi.fn(async () => ({ text: "from-host" }));
    const restorePreview = vi.fn(() => true);
    const fillComposer = vi.fn();
    const clearQueued = vi.fn();
    const reload = vi.fn(async () => undefined);
    await expect(
      executeUserMessageRestore({
        preview: true,
        itemId: "u1",
        text: "hello",
        confirm: () => true,
        restorePreview,
        navigate,
        reload,
        fillComposer,
        clearQueued,
      }),
    ).resolves.toBe("ok");
    expect(navigate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(restorePreview).toHaveBeenCalledWith("u1");
    expect(fillComposer).toHaveBeenCalledWith({ text: "hello" });
    expect(clearQueued).toHaveBeenCalled();
  });

  it("real restore navigates then reloads then overwrites composer from the receipt", async () => {
    const order: string[] = [];
    const navigate = vi.fn(async () => {
      order.push("navigate");
      return {
        text: "from-runtime",
        images: [{ type: "image" as const, mimeType: "image/png" as const, data: "aaa" }],
      };
    });
    const restorePreview = vi.fn(() => true);
    const reload = vi.fn(async () => {
      order.push("reload");
    });
    const fillComposer = vi.fn(() => {
      order.push("fill");
    });
    const clearQueued = vi.fn();
    await expect(
      executeUserMessageRestore({
        preview: false,
        itemId: "u1",
        text: "hello",
        confirm: () => true,
        restorePreview,
        navigate,
        reload,
        fillComposer,
        clearQueued,
      }),
    ).resolves.toBe("ok");
    expect(restorePreview).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("u1");
    expect(order).toEqual(["navigate", "reload", "fill"]);
    expect(fillComposer).toHaveBeenCalledWith({
      text: "from-runtime",
      images: [{ type: "image", mimeType: "image/png", data: "aaa" }],
    });
  });

  it("cancelled confirm never navigates", async () => {
    const navigate = vi.fn(async () => ({ text: "from-host" }));
    await expect(
      executeUserMessageRestore({
        preview: false,
        itemId: "u1",
        text: "hello",
        confirm: () => false,
        restorePreview: () => true,
        navigate,
        reload: async () => undefined,
        fillComposer: () => {},
        clearQueued: () => {},
      }),
    ).resolves.toBe("cancelled");
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("executeUserMessageBranch", () => {
  it("preview branch crops locally and never calls Host", async () => {
    const branch = vi.fn(async () => ({ text: "from-host", sessionId: "new" }));
    const restorePreview = vi.fn(() => true);
    const fillComposer = vi.fn();
    const selectSession = vi.fn(async () => true);
    const stashComposerFill = vi.fn();
    const onPreviewDone = vi.fn();
    await expect(
      executeUserMessageBranch({
        preview: true,
        itemId: "u1",
        text: "hello",
        confirm: () => true,
        restorePreview,
        branch,
        selectSession,
        reload: async () => undefined,
        fillComposer,
        stashComposerFill,
        clearQueued: () => {},
        onPreviewDone,
      }),
    ).resolves.toBe("ok");
    expect(branch).not.toHaveBeenCalled();
    expect(selectSession).not.toHaveBeenCalled();
    expect(restorePreview).toHaveBeenCalledWith("u1");
    expect(fillComposer).toHaveBeenCalledWith({ text: "hello" });
    expect(onPreviewDone).toHaveBeenCalled();
  });

  it("real branch stashes fill then selects the new session", async () => {
    const order: string[] = [];
    const branch = vi.fn(async () => {
      order.push("branch");
      return { text: "from-runtime", sessionId: "sess-new" };
    });
    const stashComposerFill = vi.fn((sessionId: string) => {
      order.push(`stash:${sessionId}`);
    });
    const selectSession = vi.fn(async () => {
      order.push("select");
      return true;
    });
    const fillComposer = vi.fn(() => {
      order.push("fill");
    });
    await expect(
      executeUserMessageBranch({
        preview: false,
        itemId: "u1",
        text: "hello",
        confirm: () => true,
        restorePreview: () => true,
        branch,
        selectSession,
        reload: async () => {
          order.push("reload");
        },
        fillComposer,
        stashComposerFill,
        clearQueued: () => {},
      }),
    ).resolves.toBe("ok");
    expect(order).toEqual(["branch", "stash:sess-new", "select"]);
    expect(fillComposer).not.toHaveBeenCalled();
    expect(stashComposerFill).toHaveBeenCalledWith("sess-new", { text: "from-runtime" });
  });
});
