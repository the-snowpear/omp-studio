import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
const DISTRIBUTABLE =
  /\.(?:m?js|css|png|jpe?g|svg|woff2?|ttf|bin|wasm|txt|md)$/iu;
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
/** Ship locked executable assets together with the viewer and bundled font notices. */
export function graphicVendorPlugin(): Plugin {
  const source = dirname(
    fileURLToPath(import.meta.resolve("x_ite/x_ite.min.mjs")),
  );
  return {
    name: "omp-graphic-vendor",
    configureServer(server) {
      server.middlewares.use("/graphics-xite/", async (req, res, next) => {
        try {
          const target = resolve(
            source,
            decodeURIComponent((req.url ?? "").split("?")[0]!).replace(
              /^\//u,
              "",
            ),
          );
          if (
            !target.startsWith(source + sep) ||
            !DISTRIBUTABLE.test(target) ||
            !(await stat(target)).isFile()
          ) {
            res.statusCode = 404;
            res.end();
            return;
          }
          const ext = target.split(".").at(-1);
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader(
            "Content-Type",
            ext === "mjs" || ext === "js"
              ? "text/javascript"
              : ext === "css"
                ? "text/css"
                : ext === "png"
                  ? "image/png"
                  : "application/octet-stream",
          );
          createReadStream(target)
            .on("error", () => res.destroy())
            .pipe(res);
        } catch {
          next();
        }
      });
    },
    async generateBundle() {
      for (const file of await files(source)) {
        if (!DISTRIBUTABLE.test(file)) continue;
        this.emitFile({
          type: "asset",
          fileName:
            "graphics-xite/" + relative(source, file).split(sep).join("/"),
          source: await readFile(file),
        });
      }
      const licenses = join(source, "../LICENSES");
      for (const file of await files(licenses))
        this.emitFile({
          type: "asset",
          fileName:
            "graphics-xite/LICENSES/" +
            relative(licenses, file).split(sep).join("/"),
          source: await readFile(file),
        });
    },
  };
}
