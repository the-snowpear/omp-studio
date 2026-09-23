import { HighlightPool } from "./pool";

export const highlightPool = new HighlightPool({
  cores: typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency,
  createWorker: () => new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" }),
});
const dispose = () => highlightPool.dispose();
if (typeof window !== "undefined") window.addEventListener("pagehide", dispose, { once: true });
import.meta.hot?.dispose(() => { window.removeEventListener("pagehide", dispose); dispose(); });
