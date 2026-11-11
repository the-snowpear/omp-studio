// Measure the production website, including native image resources and process RSS.
import { preview } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadPlaywright } from "./perf-audit/lib/collect.mjs";

const root = resolve(import.meta.dirname, "..");
const phase = process.argv[2] ?? "after";
const output = resolve(root, "output/playwright/review-data", `website-${phase}`);
await mkdir(output, { recursive: true });
const server = await preview({ root: resolve(root, "website"), configFile: false,
  build: { outDir: "dist" }, preview: { host: "127.0.0.1", port: 0 } });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const cdp = await page.context().newCDPSession(page);
const browserCdp = await browser.newBrowserCDPSession();
const snapshots = [];
try {
  await page.route("https://api.github.com/**", route => route.abort());
  await page.addInitScript(() => {
    const state = window.reviewImages = { htmlDecoded: 0, decodedPixelBytes: 0,
      bitmapsCreated: 0, bitmapsClosed: 0, activeBitmaps: 0, peakBitmaps: 0, activePixelBytes: 0, peakPixelBytes: 0 };
    const decoded = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await decoded.call(this);
      if (this.src.includes("/media/seq/chat/")) { state.htmlDecoded++; state.decodedPixelBytes += this.naturalWidth * this.naturalHeight * 4; }
    };
    const sizes = new WeakMap();
    const create = window.createImageBitmap;
    window.createImageBitmap = async (...args) => {
      const bitmap = await Reflect.apply(create, window, args);
      const size = bitmap.width * bitmap.height * 4;
      sizes.set(bitmap, size); state.bitmapsCreated++; state.activeBitmaps++; state.activePixelBytes += size;
      state.peakBitmaps = Math.max(state.peakBitmaps, state.activeBitmaps);
      state.peakPixelBytes = Math.max(state.peakPixelBytes, state.activePixelBytes);
      return bitmap;
    };
    const close = ImageBitmap.prototype.close;
    ImageBitmap.prototype.close = function () {
      const size = sizes.get(this);
      if (size !== undefined) { sizes.delete(this); state.bitmapsClosed++; state.activeBitmaps--; state.activePixelBytes -= size; }
      return close.call(this);
    };
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}a/`, { waitUntil: "load" });
  await page.waitForTimeout(7000);
  const region = await page.evaluate(() => {
    const trigger = window.gsap?.core.globals().ScrollTrigger?.getAll().find(item => item.trigger?.classList.contains("passage"));
    const element = document.querySelector(".passage");
    return trigger ? { start: trigger.start, end: trigger.end } : { start: element.offsetTop, end: element.offsetTop + element.offsetHeight - innerHeight };
  });
  async function capture(name) {
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const images = await page.evaluate(() => ({ ...window.reviewImages }));
    const processes = (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo.filter(proc => proc.type === "renderer");
    let rendererRssBytes;
    if (process.platform === "win32") {
      const script = `$ProgressPreference='SilentlyContinue'; Get-Process -Id ${processes.map(proc => proc.id).join(",")} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | Select-Object -ExpandProperty Sum`;
      rendererRssBytes = Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true }).trim());
    }
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    snapshots.push({ name, images, heapBytes: heap.usedSize, rendererRssBytes });
  }
  await capture("initial");
  for (const [name, fraction] of [["start", 0.08], ["middle", 0.55], ["end", 0.95], ["seek-back", 0.2]]) {
    await page.evaluate(top => scrollTo(0, top), region.start + (region.end - region.start) * fraction);
    await page.waitForTimeout(1500);
    await capture(name);
  }
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(1500); await capture("left-passage");
  const report = { phase, revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    chromium: browser.version(), region, errors, snapshots,
    maxObservedRendererRssBytes: Math.max(...snapshots.map(sample => sample.rendererRssBytes ?? 0)),
    limitations: ["Image pixel bytes are resource sizes, not process RSS.", "RSS is sampled at stops; browsers may evict decoded HTML image caches.", "GitHub release requests are disabled for a stable offline snapshot."] };
  const path = resolve(root, "output/playwright/review-data", `website-${phase}.json`);
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ path, errors, snapshots }, null, 2));
} finally { await browser.close(); await new Promise(done => server.httpServer.close(done)); }
