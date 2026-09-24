/** Internal build-time rollback switches; never persisted as user settings. */
export const performanceOptions = Object.freeze({
  boundedMermaid: import.meta.env.VITE_OMP_BOUNDED_MERMAID !== "0",
  // Production/file benchmarks improve; React dev instrumentation makes the
  // asynchronous second render more costly. Keep that build's old default.
  highlightWorker: import.meta.env.VITE_OMP_HIGHLIGHT_WORKER === "1"
    || (import.meta.env.PROD && import.meta.env.VITE_OMP_HIGHLIGHT_WORKER !== "0"),
  backgroundPublishing: import.meta.env.VITE_OMP_BACKGROUND_PUBLISHING !== "0",
});
