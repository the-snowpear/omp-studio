import { afterEach, describe, expect, it } from "vitest";
import {
  AVATAR_INPUT_MAX_BYTES,
  DEFAULT_OPERATOR_PROFILE,
  DISPLAY_NAME_MAX,
  __resetOperatorProfileForTests,
  __setAvatarDiskForTests,
  avatarInitial,
  avatarSrcFromBytes,
  getOperatorProfile,
  normalizeDisplayName,
  parseOperatorProfile,
  persistOperatorAvatar,
  processAvatarFile,
  assertAvatarImageFile,
  updateOperatorProfile,
  type ProcessedAvatar,
} from "./operatorProfile";

afterEach(() => {
  __setAvatarDiskForTests(null);
  __resetOperatorProfileForTests(null);
});

const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9, 0x00, 0x00,
]);

describe("operatorProfile", () => {
  it("normalizes display names and falls back to Studio", () => {
    expect(normalizeDisplayName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
    expect(normalizeDisplayName("   ")).toBe("Studio");
    expect(normalizeDisplayName("x".repeat(DISPLAY_NAME_MAX + 8))).toHaveLength(DISPLAY_NAME_MAX);
    expect(avatarInitial("ada")).toBe("A");
    expect(avatarInitial("  ")).toBe("S");
  });

  it("parses stored names and ignores a leftover data-URL avatar in localStorage", () => {
    expect(parseOperatorProfile(null)).toEqual({ displayName: DEFAULT_OPERATOR_PROFILE.displayName });
    expect(parseOperatorProfile("{")).toEqual({ displayName: DEFAULT_OPERATOR_PROFILE.displayName });
    expect(parseOperatorProfile(JSON.stringify({
      displayName: " Ada ",
      avatarDataUrl: "data:image/png;base64,QQ==",
    }))).toEqual({ displayName: "Ada" });
  });

  it("persists a name change without writing the avatar into localStorage", () => {
    updateOperatorProfile({ displayName: "Ada" });
    expect(getOperatorProfile().displayName).toBe("Ada");
    expect(JSON.parse(window.localStorage.getItem("omp.operatorProfile") ?? "{}")).toEqual({ displayName: "Ada" });
  });

  it("writes processed avatar bytes through the desktop store and can clear them", async () => {
    let stored: ProcessedAvatar | null = null;
    __setAvatarDiskForTests({
      saveAvatar: async (input) => {
        stored = input;
        return { ok: true };
      },
      loadAvatar: async () => stored,
      clearAvatar: async () => { stored = null; },
    });
    await persistOperatorAvatar({ mime: "image/jpeg", bytes: JPEG });
    expect(stored).toEqual({ mime: "image/jpeg", bytes: JPEG });
    expect(getOperatorProfile().avatarSrc).toBe(avatarSrcFromBytes({ mime: "image/jpeg", bytes: JPEG }));
    await persistOperatorAvatar(null);
    expect(stored).toBeNull();
    expect(getOperatorProfile().avatarSrc).toBe("");
  });

  it("rejects non-image and oversized uploads before decoding", async () => {
    await expect(processAvatarFile(new File(["x"], "notes.txt", { type: "text/plain" }))).rejects.toThrow("请选择图片文件。");
    const huge = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: AVATAR_INPUT_MAX_BYTES + 1 });
    await expect(processAvatarFile(huge)).rejects.toThrow("图片太大");
    expect(() => assertAvatarImageFile(new File(["x"], "photo.png", { type: "" }))).not.toThrow();
    expect(() => assertAvatarImageFile(new File(["x"], "photo", { type: "" }))).toThrow("请选择图片文件。");
  });
});
