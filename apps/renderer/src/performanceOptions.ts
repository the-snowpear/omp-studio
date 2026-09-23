/** Internal build-time rollback switches; never persisted as user settings. */
export const performanceOptions = Object.freeze({
  boundedMermaid: import.meta.env.VITE_OMP_BOUNDED_MERMAID === "1",
  highlightWorker: import.meta.env.VITE_OMP_HIGHLIGHT_WORKER === "1",
  backgroundPublishing: import.meta.env.VITE_OMP_BACKGROUND_PUBLISHING === "1",
});
