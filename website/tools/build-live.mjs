/**
 * Builds the real renderer (apps/renderer/website-embed.html) on the contract
 * fixture transport into public/live/, so the website can embed interactive
 * product pages instead of static screenshots. Uses the repo root's Vite & plugins.
 * Usage:
 *   npm run live
 *   node tools/build-live.mjs --if-needed
 *   node tools/build-live.mjs --force
 */
import { existsSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = new Set(process.argv.slice(2));
const ifNeeded = args.has("--if-needed");
const force = args.has("--force");

const SITE = realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const REPO = path.resolve(SITE, "..");
const NM = path.join(REPO, "node_modules");
const RENDERER = path.join(REPO, "apps", "renderer");
const ENTRY = path.join(RENDERER, "website-embed.html");
const OUT = path.join(SITE, "public", "live");
const OUT_ENTRY = path.join(OUT, "website-embed.html");

if (ifNeeded && !force && existsSync(OUT_ENTRY)) {
  process.exit(0);
}

const vitePath = path.join(NM, "vite", "dist", "node", "index.js");
const reactPath = path.join(NM, "@vitejs", "plugin-react", "dist", "index.js");

if (!existsSync(vitePath) || !existsSync(reactPath)) {
  if (ifNeeded) {
    console.warn("[live] skipping live embed build: root node_modules/vite not found (standalone mode)");
    process.exit(0);
  }
  console.error("[live] missing root node_modules/vite or @vitejs/plugin-react; run npm install at repo root");
  process.exit(1);
}

if (!existsSync(ENTRY)) {
  if (ifNeeded) {
    console.warn("[live] skipping live embed build: apps/renderer/website-embed.html not found");
    process.exit(0);
  }
  console.error("[live] missing apps/renderer/website-embed.html");
  process.exit(1);
}

const load = (p) => import(pathToFileURL(p).href);
const vite = await load(vitePath);
const react = (await load(reactPath)).default;

await rm(OUT, { recursive: true, force: true });
await vite.build({
  configFile: false,
  root: RENDERER,
  base: "./",
  // The renderer's public/ carries brand logos and icons; graphicVendorPlugin (~32 MB),
  // fileViewerVendorPlugin (~3.3 MB), and packagedCspPlugin are omitted on purpose.
  publicDir: path.join(RENDERER, "public"),
  logLevel: "warn",
  cacheDir: path.join(SITE, "node_modules", ".vite-live"),
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@oh-my-pi/pi-tui/html-form/data",
        replacement: path.join(REPO, "omp-patch", "vendor", "oh-my-pi", "packages", "tui", "src", "html-form", "data.ts"),
      },
      {
        find: "@oh-my-pi/pi-tui/html-form/model",
        replacement: path.join(REPO, "omp-patch", "vendor", "oh-my-pi", "packages", "tui", "src", "html-form", "model.ts"),
      },
    ],
  },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    target: "es2022",
    chunkSizeWarningLimit: 100_000,
    rollupOptions: {
      input: { app: ENTRY },
    },
  },
});

console.log("LIVE-DONE", OUT);
