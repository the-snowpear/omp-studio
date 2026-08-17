import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

// #region agent log
/** Dev-only: renderer CSP blocks 127.0.0.1:7773, so same-origin ingest is written here and forwarded. */
function debugIngestPlugin(): Plugin {
  const ingestPath = "/ingest/2bbaa919-e4cf-4b69-9c53-c2287627953f";
  const logFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../debug-b21151.log");
  return {
    name: "debug-ingest-b21151",
    configureServer(server) {
      server.middlewares.use(ingestPath, (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            appendFileSync(logFile, `${body.trim()}\n`);
          } catch {
            /* ignore */
          }
          fetch("http://127.0.0.1:7773/ingest/2bbaa919-e4cf-4b69-9c53-c2287627953f", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b21151" },
            body,
          }).catch(() => {});
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}
// #endregion

// P0 renderer: a pure browser build with no host-specific coupling. The
// relative base keeps the same bundle loadable from any origin the shell
// later serves it from (including file:// during early desktop bring-up).
export default defineConfig({
  plugins: [react(), debugIngestPlugin()],
  base: "./",
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  build: {
    rollupOptions: {
      output: {
        // Keep the entry under the 500 kB warning: React, xterm, and the
        // Studio client stay on their own cacheable vendor chunks.
        // Mermaid is only imported lazily for fenced "mermaid" blocks, so its
        // whole dependency tree rides its own chunk instead of inflating vendor.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@xterm")) return "xterm";
          if (id.includes("@codemirror") || id.includes("@lezer") || /node_modules[/\\]codemirror[/\\]/.test(id)) {
            return "codemirror";
          }
          const mermaidPackages = [
            "mermaid",
            "@mermaid-js",
            "d3",
            "dagre",
            "dagre-d3",
            "graphlib",
            "cytoscape",
            "khroma",
            "dompurify",
            "katex",
            "dayjs",
            "@braintree",
            "non-layered-tidy-tree-layout",
            "@iconify",
            "langium",
            "stylis",
            "ts-dedent",
            "uuid",
            "delaunator",
            "internmap",
            "robust-predicates",
          ];
          const pkg = id.split(/node_modules[/\\]/)[1] ?? "";
          if (mermaidPackages.some((name) => pkg.startsWith(name))) return "mermaid";
          if (id.includes("@omp-studio")) return "studio-client";
          if (/node_modules[/\\](?:react-dom|react|scheduler)[/\\]/.test(id)) return "react";
          return "vendor";
        },
      },
    },
  },
});
