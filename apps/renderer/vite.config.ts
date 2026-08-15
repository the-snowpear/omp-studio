import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// P0 renderer: a pure browser build with no host-specific coupling. The
// relative base keeps the same bundle loadable from any origin the shell
// later serves it from (including file:// during early desktop bring-up).
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    rollupOptions: {
      output: {
        // Keep the entry under the 500 kB warning: React, xterm, and the
        // Studio client stay on their own cacheable vendor chunks.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@xterm")) return "xterm";
          if (id.includes("@codemirror") || id.includes("@lezer") || /node_modules[/\\]codemirror[/\\]/.test(id)) {
            return "codemirror";
          }
          if (id.includes("@omp-studio")) return "studio-client";
          if (/node_modules[/\\](?:react-dom|react|scheduler)[/\\]/.test(id)) return "react";
          return "vendor";
        },
      },
    },
  },
});
