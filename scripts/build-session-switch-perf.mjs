/** Isolated production build of the same read-only switching harness used by Vite dev. */
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  root: join(root, "apps/renderer"),
  configFile: join(root, "apps/renderer/vite.config.ts"),
  build: {
    target: "es2022",
    outDir: join(root, "outputs/perf/session-switch-production"),
    emptyOutDir: false,
    rollupOptions: { input: { sessionSwitch: join(root, "apps/renderer/session-switch-perf.html") } },
  },
});
