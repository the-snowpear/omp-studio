import { expect, it } from "vitest";
import { GraphicLeasePool } from "./graphic-pool";
it("limits live previews and never starts a hidden queued preview", async () => {
  const pool = new GraphicLeasePool(1, 2);
  const starts: string[] = [];
  const first = pool.request(() => starts.push("first"));
  const hidden = pool.request(() => starts.push("hidden"));
  pool.request(() => starts.push("next"));
  expect(() => pool.request(() => starts.push("overflow"))).toThrow();
  await Promise.resolve();
  expect(starts).toEqual(["first"]);
  hidden();
  first();
  await Promise.resolve();
  expect(starts).toEqual(["first", "next"]);
});
