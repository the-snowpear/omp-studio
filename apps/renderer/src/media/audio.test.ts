import { afterEach, expect, it, vi } from "vitest";
import { checkAudioDuration, normalizeAudio } from "./audio";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("rejects an excessive compressed duration before allocating a decoder and revokes the URL", async () => {
  const element = document.createElement("audio"); Object.defineProperty(element, "duration", { value: 601 });
  vi.spyOn(element, "load").mockImplementation(() => {}); vi.spyOn(document, "createElement").mockReturnValue(element);
  const revokeObjectURL = vi.fn(); vi.stubGlobal("URL", { createObjectURL: () => "blob:fixture", revokeObjectURL });
  const decoder = vi.fn(); vi.stubGlobal("OfflineAudioContext", decoder);
  const result = normalizeAudio(new Blob(["tiny-compressed"])); const rejection = expect(result).rejects.toThrow("10 minutes");
  element.dispatchEvent(new Event("loadedmetadata")); await rejection; expect(decoder).not.toHaveBeenCalled(); expect(revokeObjectURL).toHaveBeenCalledWith("blob:fixture");
});
it("aborted duration probing releases its object URL without starting playback", async () => {
  const element = document.createElement("audio"); vi.spyOn(element, "load").mockImplementation(() => {}); const play = vi.spyOn(element, "play"); vi.spyOn(document, "createElement").mockReturnValue(element);
  const revokeObjectURL = vi.fn(); vi.stubGlobal("URL", { createObjectURL: () => "blob:fixture", revokeObjectURL });
  const controller = new AbortController(); const result = checkAudioDuration(new Blob(["audio"]), controller.signal); const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" }); controller.abort(); await rejection;
  expect(revokeObjectURL).toHaveBeenCalledOnce(); expect(play).not.toHaveBeenCalled();
});
