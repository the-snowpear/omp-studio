import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Must stay in lockstep with apps/desktop/src/security.ts RENDERER_CSP.
// file:// loads do not reliably get webRequest CSP headers, so the packaged
// index.html carries the policy as a meta tag. `frame-ancestors` is enforced
// by the desktop response header because browsers ignore it in meta CSP.
// Vite dev still needs HMR.
const PACKAGED_RENDERER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

function packagedCspPlugin() {
  return {
    name: "omp-packaged-csp",
    apply: "build" as const,
    transformIndexHtml(html: string) {
      if (html.includes("Content-Security-Policy")) return html;
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${PACKAGED_RENDERER_CSP}" />`,
      );
    },
  };
}

// P0 renderer: a pure browser build with no host-specific coupling. The
// relative base keeps the same bundle loadable from any origin the shell
// later serves it from (including file:// during early desktop bring-up).
export default defineConfig({
  plugins: [react(), packagedCspPlugin()],
  base: "./",
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
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
