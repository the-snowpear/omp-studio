import { describe, expect, it } from "vitest";

import { BACKGROUND_LIMITS } from "./backgroundSettings";
import {
  canAddUpload,
  createMemoryBackgroundLibrary,
  probeBackgroundLibrary,
  uploadBytes,
  type BackgroundAssetMeta,
} from "./backgroundLibrary";

function meta(id: string, bytes: number): BackgroundAssetMeta {
  return {
    id,
    kind: "image",
    name: `${id}.png`,
    mime: "image/png",
    bytes,
    createdAt: 1,
    luma: 0.5,
    avgColor: "#808080",
    fingerprint: id,
  };
}

describe("background library", () => {
  it("stores and removes metadata and blobs together", async () => {
    const library = createMemoryBackgroundLibrary();
    const blob = new Blob(["x"], { type: "image/png" });
    await library.put(meta("a", 1), blob);
    expect((await library.list()).map((row) => row.id)).toEqual(["a"]);
    expect(await library.readBlob("a")).toBe(blob);
    await library.remove("a");
    expect(await library.list()).toEqual([]);
    expect(await library.readBlob("a")).toBeNull();
  });

  it("probes availability without throwing", async () => {
    const library = createMemoryBackgroundLibrary();
    expect(await probeBackgroundLibrary(library)).toBe(true);
    const broken = {
      ...library,
      list: async (): Promise<readonly BackgroundAssetMeta[]> => { throw new Error("nope"); },
    };
    expect(await probeBackgroundLibrary(broken)).toBe(false);
  });

  it("computes usage and enforces count and byte caps", () => {
    expect(uploadBytes([meta("a", 10), meta("b", 32)])).toBe(42);
    expect(canAddUpload([], 1)).toBe("ok");
    const many = Array.from({ length: BACKGROUND_LIMITS.count }, (_, index) => meta(`u${index}`, 1));
    expect(canAddUpload(many, 1)).toBe("library-full");
    const heavy = [meta("huge", BACKGROUND_LIMITS.totalBytes)];
    expect(canAddUpload(heavy, 1)).toBe("library-full");
  });
});
