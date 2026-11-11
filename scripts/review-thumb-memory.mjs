// Native IndexedDB measurements with the real thumbnail store and an isolated Chromium profile.
// PLAYWRIGHT_MODULE may point at an external, pinned Playwright installation.
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadPlaywright } from "./perf-audit/lib/collect.mjs";

const root = resolve(import.meta.dirname, "..");
const phase = process.argv[2] ?? "after";
const { chromium } = await loadPlaywright();
const server = await createServer({ root: resolve(root, "apps/renderer"), configFile: false,
  logLevel: "error", server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "memory-probe", configureServer(vite) {
    vite.middlewares.use("/review-memory.html", (_req, res) => {
      res.setHeader("content-type", "text/html"); res.end("<!doctype html><body>IndexedDB memory probe</body>");
    });
  }}] });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
const samples = [];
try {
  await page.goto(`${server.resolvedUrls.local[0]}review-memory.html`);
  await page.evaluate(async () => {
    window.probeStore = (await import("/src/conversation/userMessageThumbs.ts")).createIndexedDbThumbStore();
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("omp-studio-ui", 2);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("user-message-thumbs", { keyPath: "id" });
        store.createIndex("sessionId", "sessionId", { unique: false });
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("user-message-thumbs", "readwrite");
      const store = transaction.objectStore("user-message-thumbs");
      for (let index = 0; index < 1000; index++) {
        const itemId = `message-${String(index).padStart(4, "0")}`;
        const data = btoa(String(index).padStart(12, "0")) + "A".repeat(65520);
        store.put({ id: `memory-session\u0000${itemId}`, sessionId: "memory-session", itemId,
          images: [{ label: "shot.png", image: { type: "image", mimeType: "image/png", data } }] });
      }
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    window.probeIds = Array.from({ length: 100 }, (_, index) => `message-${String(index).padStart(4, "0")}`);
  });
  await cdp.send("HeapProfiler.enable");
  for (let run = 0; run < 5; run++) {
    await page.evaluate(() => { window.probeThumbs = undefined; });
    await cdp.send("HeapProfiler.collectGarbage");
    const before = await cdp.send("Runtime.getHeapUsage");
    const load = await page.evaluate(async () => {
      const started = performance.now();
      window.probeThumbs = await window.probeStore.load("memory-session", window.probeIds);
      const thumbnails = Object.values(window.probeThumbs).flat();
      return { ms: performance.now() - started, loadedItems: Object.keys(window.probeThumbs).length,
        loadedImages: thumbnails.length, base64Bytes: thumbnails.reduce((sum, thumb) => sum + thumb.image.data.length, 0) };
    });
    const observed = await cdp.send("Runtime.getHeapUsage");
    await cdp.send("HeapProfiler.collectGarbage");
    const retained = await cdp.send("Runtime.getHeapUsage");
    samples.push({ ...load, observedHeapDeltaBytes: observed.usedSize - before.usedSize,
      retainedHeapDeltaBytes: retained.usedSize - before.usedSize });
  }
  await page.evaluate(() => { window.probeThumbs = undefined; });
  await cdp.send("HeapProfiler.collectGarbage");
  const dropBefore = await cdp.send("Runtime.getHeapUsage");
  let settled = false, peak = dropBefore.usedSize;
  const dropping = page.evaluate(async () => {
    const started = performance.now(); await window.probeStore.dropSession("memory-session");
    return { ms: performance.now() - started };
  }).finally(() => { settled = true; });
  while (!settled) {
    peak = Math.max(peak, (await cdp.send("Runtime.getHeapUsage")).usedSize);
    await new Promise(done => setTimeout(done, 10));
  }
  const drop = await dropping;
  await cdp.send("HeapProfiler.collectGarbage");
  const remaining = await page.evaluate(async () => Object.keys(await window.probeStore.load("memory-session", window.probeIds)).length);
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const report = { phase, revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    chromium: browser.version(), storedItems: 1000, requestedItems: 100, base64BytesPerImage: 65536,
    samples, load: Object.fromEntries(Object.keys(samples[0]).map(key => [key, median(samples.map(sample => sample[key]))])),
    drop: { ...drop, observedPeakHeapDeltaBytes: peak - dropBefore.usedSize, remainingItems: remaining },
    limitations: ["Native IndexedDB; image-shaped storage payloads are not decoded or displayed.", "The deletion peak is observed through CDP at approximately 10ms intervals."] };
  const path = resolve(root, "output/playwright/review-data", `thumbs-${phase}.json`);
  await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ path, load: report.load, drop: report.drop }, null, 2));
} finally { await browser.close(); await server.close(); }
