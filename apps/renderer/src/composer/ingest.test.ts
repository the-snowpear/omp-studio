import { describe, expect, it } from "vitest";

import { fileToPromptImage } from "./ingest";

function pngFile(bytes: Uint8Array, size: number): File {
  const payload = Uint8Array.from(bytes);
  const file = new File([payload.buffer], "shot.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: size });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => Uint8Array.from(bytes).buffer,
  });
  return file;
}

describe("fileToPromptImage", () => {
  it("reads an image whose reported size exceeds 8MB", async () => {
    const bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
    const image = await fileToPromptImage(pngFile(bytes, 8 * 1024 * 1024 + 1));
    expect(image).toEqual({
      type: "image",
      mimeType: "image/png",
      data: btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47)),
    });
  });
});
