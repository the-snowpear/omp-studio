import { describe, expect, it, vi } from "vitest";

import { createMemoryBackgroundLibrary, type BackgroundAssetMeta } from "./backgroundLibrary";
import {
  BACKGROUND_LIMITS,
} from "./backgroundSettings";
import {
  backgroundFileKind,
  backgroundFingerprint,
  importBackgroundFile,
  validateBackgroundFile,
  type MeasuredBackground,
} from "./backgroundImport";

function fakeFile(name: string, type: string, size: number, lastModified = 1): File {
  return { name, type, size, lastModified } as unknown as File;
}

function measured(overrides: Partial<MeasuredBackground> = {}): MeasuredBackground {
  return {
    blob: new Blob(["payload"], { type: "image/png" }),
    width: 640,
    height: 360,
    luma: 0.32,
    avgColor: "#445566",
    thumbDataUrl: "data:image/webp;base64,AAAA",
    ...overrides,
  };
}

function existingMeta(file: File): BackgroundAssetMeta {
  return {
    id: "existing",
    kind: "image",
    name: file.name,
    mime: file.type,
    bytes: 100,
    createdAt: 1,
    luma: 0.4,
    avgColor: "#112233",
    fingerprint: backgroundFingerprint(file),
  };
}

describe("background import", () => {
  it("classifies by MIME and falls back to extensions when the type is empty", () => {
    expect(backgroundFileKind(fakeFile("a.png", "image/png", 1))).toBe("image");
    expect(backgroundFileKind(fakeFile("a.mp4", "video/mp4", 1))).toBe("video");
    expect(backgroundFileKind(fakeFile("a.webp", "", 1))).toBe("image");
    expect(backgroundFileKind(fakeFile("a.mkv", "video/x-matroska", 1))).toBeUndefined();
    expect(backgroundFileKind(fakeFile("a.txt", "", 1))).toBeUndefined();
  });

  it("rejects unsupported and oversized files before decoding", () => {
    expect(validateBackgroundFile(fakeFile("a.mkv", "video/x-matroska", 10)))
      .toEqual({ ok: false, code: "unsupported-type" });
    expect(validateBackgroundFile(fakeFile("huge.png", "image/png", BACKGROUND_LIMITS.imageBytes + 1)))
      .toEqual({ ok: false, code: "too-large" });
    expect(validateBackgroundFile(fakeFile("huge.mp4", "video/mp4", BACKGROUND_LIMITS.videoBytes + 1)))
      .toEqual({ ok: false, code: "too-large" });
    expect(validateBackgroundFile(fakeFile("empty.png", "image/png", 0)))
      .toEqual({ ok: false, code: "decode-failed" });
  });

  it("imports through injected decoders and stores metadata plus bytes", async () => {
    const library = createMemoryBackgroundLibrary();
    const file = fakeFile("wall.png", "image/png", 1234, 42);
    const result = await importBackgroundFile(file, {
      library,
      uploads: [],
      deps: {
        measureImage: async () => measured(),
        now: () => 777,
        randomId: () => "new-id",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deduped).toBe(false);
    expect(result.meta).toMatchObject({
      id: "new-id",
      kind: "image",
      name: "wall.png",
      bytes: expect.any(Number),
      createdAt: 777,
      luma: 0.32,
      avgColor: "#445566",
    });
    const rows = await library.list();
    expect(rows).toHaveLength(1);
    expect(await library.readBlob("new-id")).not.toBeNull();
  });

  it("dedupes the same file by name, size, and modification time", async () => {
    const library = createMemoryBackgroundLibrary();
    const file = fakeFile("wall.png", "image/png", 1234, 42);
    const measureImage = vi.fn(async () => measured());
    const result = await importBackgroundFile(file, {
      library,
      uploads: [existingMeta(file)],
      deps: { measureImage },
    });
    expect(result).toEqual({ ok: true, meta: existingMeta(file), deduped: true });
    expect(measureImage).not.toHaveBeenCalled();
  });

  it("refuses to decode when the library is full", async () => {
    const library = createMemoryBackgroundLibrary();
    const uploads = Array.from({ length: BACKGROUND_LIMITS.count }, (_, index) => ({
      ...existingMeta(fakeFile(`w${index}.png`, "image/png", 1)),
      id: `u${index}`,
      fingerprint: `f${index}`,
    }));
    const measureImage = vi.fn(async () => measured());
    const result = await importBackgroundFile(fakeFile("new.png", "image/png", 10), {
      library,
      uploads,
      deps: { measureImage },
    });
    expect(result).toEqual({ ok: false, code: "library-full" });
    expect(measureImage).not.toHaveBeenCalled();
  });

  it("maps storage quota failures to a clear code", async () => {
    const library = createMemoryBackgroundLibrary();
    const put = vi.spyOn(library, "put").mockRejectedValue(new DOMException("full", "QuotaExceededError"));
    const result = await importBackgroundFile(fakeFile("wall.png", "image/png", 10), {
      library,
      uploads: [],
      deps: { measureImage: async () => measured() },
    });
    expect(result).toEqual({ ok: false, code: "quota" });
    expect(put).toHaveBeenCalled();
  });

  it("returns decode-failed when the decoder throws", async () => {
    const library = createMemoryBackgroundLibrary();
    const result = await importBackgroundFile(fakeFile("bad.png", "image/png", 10), {
      library,
      uploads: [],
      deps: { measureImage: async () => { throw new Error("boom"); } },
    });
    expect(result).toEqual({ ok: false, code: "decode-failed" });
  });
});
