import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it("enables Worker highlighting by default only in production, with explicit rollback in either build", async () => {
  vi.stubEnv("PROD", false); vi.stubEnv("VITE_OMP_HIGHLIGHT_WORKER", "");
  expect((await import("./performanceOptions")).performanceOptions.highlightWorker).toBe(false);
  vi.resetModules(); vi.stubEnv("PROD", true);
  expect((await import("./performanceOptions")).performanceOptions.highlightWorker).toBe(true);
  vi.resetModules(); vi.stubEnv("VITE_OMP_HIGHLIGHT_WORKER", "0");
  expect((await import("./performanceOptions")).performanceOptions.highlightWorker).toBe(false);
  vi.resetModules(); vi.stubEnv("PROD", false); vi.stubEnv("VITE_OMP_HIGHLIGHT_WORKER", "1");
  expect((await import("./performanceOptions")).performanceOptions.highlightWorker).toBe(true);
});
it("rolls Mermaid and hidden publishing back independently", async () => {
  vi.stubEnv("VITE_OMP_BOUNDED_MERMAID", "0"); vi.stubEnv("VITE_OMP_BACKGROUND_PUBLISHING", "1");
  expect((await import("./performanceOptions")).performanceOptions).toMatchObject({ boundedMermaid: false, backgroundPublishing: true });
  vi.resetModules(); vi.stubEnv("VITE_OMP_BOUNDED_MERMAID", "1"); vi.stubEnv("VITE_OMP_BACKGROUND_PUBLISHING", "0");
  expect((await import("./performanceOptions")).performanceOptions).toMatchObject({ boundedMermaid: true, backgroundPublishing: false });
});
