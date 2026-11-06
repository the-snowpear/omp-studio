/**
 * Builds the real renderer (apps/renderer, read-only) on the contract fixture
 * transport into public/live/, so a page can embed the actual product UI instead
 * of a picture of it. Uses the repo's own Vite and plugins.
 * Usage: npm run live
 */
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SITE = realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const REPO = path.resolve(SITE, "..");
const NM = path.join(REPO, "node_modules");
const RENDERER = path.join(REPO, "apps", "renderer");
const OUT = path.join(SITE, "public", "live");
const load = (p) => import(pathToFileURL(p).href);

const vite = await load(path.join(NM, "vite", "dist", "node", "index.js"));
const react = (await load(path.join(NM, "@vitejs", "plugin-react", "dist", "index.js"))).default;

await rm(OUT, { recursive: true, force: true });
await vite.build({
  configFile: false,
  root: RENDERER,
  base: "./",
  // The renderer's public/ carries brand logos and the icon; the graphics vendor
  // plugin is omitted on purpose (24 MB of 3D viewer the embed never opens).
  publicDir: path.join(RENDERER, "public"),
  logLevel: "warn",
  cacheDir: path.join(SITE, "node_modules", ".vite-live"),
  plugins: [react()],
  build: {
    outDir: OUT,
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    target: "es2022",
    chunkSizeWarningLimit: 100_000,
    rollupOptions: { input: { app: path.join(RENDERER, "preview-app-harness.html") } },
  },
});
console.log("LIVE-DONE", OUT);
