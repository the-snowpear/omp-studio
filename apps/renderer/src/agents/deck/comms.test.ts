import { describe, expect, it } from "vitest";
import { swarmMessages } from "./comms";

describe("swarmMessages", () => {
  it("folds a broadcast's legs into one post and points replies to any leg at it", () => {
    const posts = swarmMessages([
      { id: "b1", from: "Main", to: "docs-1", body: "Hold writes to renderer/.", at: 1_000, broadcast: true },
      { id: "b2", from: "Main", to: "lint-1", body: "Hold writes to renderer/.", at: 1_200, broadcast: true },
      { id: "r1", from: "lint-1", to: "Main", body: "Paused.", at: 2_000, replyTo: "b2" },
      // The same words broadcast again much later are a new post.
      { id: "b3", from: "Main", to: "docs-1", body: "Hold writes to renderer/.", at: 60_000, broadcast: true },
    ]);
    expect(posts.map(post => ({ id: post.id, to: post.to, replyTo: post.replyTo }))).toEqual([
      { id: "b1", to: ["docs-1", "lint-1"], replyTo: undefined },
      { id: "r1", to: ["Main"], replyTo: "b1" },
      { id: "b3", to: ["docs-1"], replyTo: undefined },
    ]);
  });
});
