import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_MODE_STORAGE_KEY, PREVIEW_MODE_SWITCH_ENABLED, readStoredPreviewMode } from "./mode";

afterEach(() => {
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
});

describe("preview release defaults", () => {
  it("hides the switch and treats empty storage as off", () => {
    expect(PREVIEW_MODE_SWITCH_ENABLED).toBe(false);
    window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
    expect(readStoredPreviewMode()).toBe(false);
  });
});
