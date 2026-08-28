import { describe, expect, it } from "vitest";

import { createSerialTaskQueue } from "./workspaceActionQueue";

describe("createSerialTaskQueue", () => {
  it("runs workspace actions in enqueue order and continues after failure", async () => {
    const queue = createSerialTaskQueue();
    const events: string[] = [];
    const first = queue.enqueue(async () => {
      events.push("first:start");
      await Promise.resolve();
      events.push("first:end");
      return "first";
    });
    const failed = queue.enqueue(async () => {
      events.push("failed");
      throw new Error("expected");
    });
    const third = queue.enqueue(async () => {
      events.push("third");
      return "third";
    });

    await expect(first).resolves.toBe("first");
    await expect(failed).rejects.toThrow("expected");
    await expect(third).resolves.toBe("third");
    expect(events).toEqual(["first:start", "first:end", "failed", "third"]);
  });
});
