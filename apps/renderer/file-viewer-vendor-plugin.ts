import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export function fileViewerVendorPlugin(): Plugin {
  const root = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
  return {
    name: "omp-file-viewer-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (request, response, next) => {
        const path = resolve(root, decodeURIComponent((request.url ?? "").split("?")[0]!).replace(/^\//, ""));
        if (!path.startsWith(root + sep) || !/^(cmaps|standard_fonts|wasm)[/\\]/.test(relative(root, path))) { next(); return; }
        response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        createReadStream(path).on("error", () => { response.statusCode = 404; response.end(); }).pipe(response);
      });
    },
    async generateBundle() {
      for (const folder of ["cmaps", "standard_fonts", "wasm"]) for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
        if (entry.isFile()) this.emitFile({ type: "asset", fileName: `pdfjs/${folder}/${entry.name}`, source: await readFile(join(root, folder, entry.name)) });
      }
      this.emitFile({ type: "asset", fileName: "pdfjs/LICENSE", source: await readFile(join(root, "LICENSE")) });
    },
  };
}
