/**
 * Shared helpers for the OMP Studio desktop perf audit probes.
 *
 * Everything here is measurement-only: the probes never modify product source,
 * never touch the user's real profile, and always launch Electron with an
 * isolated `--user-data-dir` plus an isolated `%APPDATA%` / `%LOCALAPPDATA%`.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, totalmem, freemem, arch, platform, release, hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..", "..");
export const BENCH_ROOT = join(REPO_ROOT, "outputs", "perf-audit", "bench");
export const RAW_ROOT = join(BENCH_ROOT, "raw");
export const ELECTRON_EXE = join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe");
export const APP_DIR = join(REPO_ROOT, "apps", "desktop");
export const HOOK_PATH = join(REPO_ROOT, "scripts", "perf-audit", "lib", "main-hook.cjs");
export const RENDERER_DIST_INDEX = join(REPO_ROOT, "apps", "renderer", "dist", "index.html");

export function ensureDirs() {
  for (const dir of [BENCH_ROOT, RAW_ROOT]) mkdirSync(dir, { recursive: true });
}

export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
  return path;
}

export function median(values) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

export function mean(values) {
  const list = values.filter((v) => Number.isFinite(v));
  if (list.length === 0) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

export function percentile(values, p) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const rank = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[rank];
}

export function summarize(values) {
  const list = values.filter((v) => Number.isFinite(v));
  if (list.length === 0) return { n: 0, median: null, mean: null, p95: null, max: null, min: null };
  return {
    n: list.length,
    median: round(median(list)),
    mean: round(mean(list)),
    p95: round(percentile(list, 95)),
    min: round(Math.min(...list)),
    max: round(Math.max(...list)),
  };
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/* ------------------------------------------------------------------ */
/* host / environment                                                  */
/* ------------------------------------------------------------------ */

function runCapture(file, args, options = {}) {
  try {
    return execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 20000, ...options }).trim();
  } catch {
    return "";
  }
}

export function cpuModel() {
  const model = (cpus()[0] || {}).model;
  return model === undefined ? "unknown" : model.trim();
}

export function collectHostCpu() {
  return cpus().map((c) => ({ ...c.times }));
}

/** Busy percentage of the whole host between two `cpus()` snapshots. */
export function hostBusyPercent(before, after) {
  let busy = 0;
  let total = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
    const b = before[i];
    const a = after[i];
    const idleDelta = a.idle - b.idle;
    const totalDelta = a.user - b.user + (a.nice - b.nice) + (a.sys - b.sys) + (a.irq - b.irq) + idleDelta;
    busy += totalDelta - idleDelta;
    total += totalDelta;
  }
  return total === 0 ? null : round((busy / total) * 100, 2);
}

export function collectGpuAdapters() {
  const raw = runCapture("powershell.exe", [
    "-NoProfile",
    "-Command",
    "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM,VideoProcessor | ConvertTo-Json -Compress",
  ]);
  if (raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      name: item.Name,
      driverVersion: item.DriverVersion,
      adapterRamBytes: item.AdapterRAM,
      videoProcessor: item.VideoProcessor,
    }));
  } catch {
    return [{ raw }];
  }
}

export function collectOsInfo() {
  const osCaption = runCapture("powershell.exe", [
    "-NoProfile",
    "-Command",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture | ConvertTo-Json -Compress)",
  ]);
  let os = null;
  try {
    os = JSON.parse(osCaption);
  } catch {
    os = { caption: null, raw: osCaption };
  }
  return { platform: platform(), release: release(), arch: arch(), hostname: hostname(), os };
}

export function collectEnvironment() {
  const gitHead = runCapture("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"]);
  const gitShort = runCapture("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"]);
  const gitSubject = runCapture("git", ["-C", REPO_ROOT, "log", "-1", "--format=%cI %s"]);
  const gitDirty = runCapture("git", ["-C", REPO_ROOT, "status", "--porcelain"]);
  const electronPkg = JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", "electron", "package.json"), "utf8"));
  let playwrightVersion = null;
  try {
    playwrightVersion = JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", "playwright", "package.json"), "utf8")).version;
  } catch {
    playwrightVersion = null;
  }
  const stat = existsSync(RENDERER_DIST_INDEX) ? statSync(RENDERER_DIST_INDEX) : undefined;
  const desktopMain = join(APP_DIR, "dist", "src", "main.js");
  const desktopStat = existsSync(desktopMain) ? statSync(desktopMain) : undefined;
  return {
    capturedAt: new Date().toISOString(),
    hostname: hostname(),
    os: collectOsInfo(),
    cpu: { model: cpuModel(), cores: cpus().length, logicalProcessors: cpus().length },
    memoryGiB: round(totalmem() / 1024 ** 3, 2),
    freeMemoryGiB: round(freemem() / 1024 ** 3, 2),
    gpuAdapters: collectGpuAdapters(),
    node: process.version,
    electron: electronPkg.version,
    playwright: playwrightVersion,
    build: {
      mode: "dev-unpackaged (app.isPackaged=false, electron.exe not renamed)",
      rendererDistIndexMtime: stat ? stat.mtime.toISOString() : null,
      desktopMainMtime: desktopStat ? desktopStat.mtime.toISOString() : null,
      rendererEntry: resolve(REPO_ROOT, "apps", "renderer", "dist", "index.html"),
    },
    git: {
      head: gitHead,
      shortHead: gitShort,
      lastCommit: gitSubject,
      dirty: gitDirty === "" ? "clean" : gitDirty.split("\n"),
      dirtyCount: gitDirty === "" ? 0 : gitDirty.split("\n").length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* process hygiene                                                     */
/* ------------------------------------------------------------------ */

export function listElectronProcesses() {
  const out = runCapture("tasklist", ["/FI", "IMAGENAME eq electron.exe", "/FO", "CSV", "/NH"]);
  if (out === "" || /INFO:/i.test(out)) return [];
  return out
    .split(/\r?\n/)
    .map((line) => line.split('","').map((cell) => cell.replace(/^"|"$/g, "")))
    .filter((cells) => cells.length >= 2 && /electron\.exe/i.test(cells[0]))
    .map((cells) => ({ image: cells[0], pid: Number(cells[1]), session: cells[2], memory: cells[4] }));
}

export async function killStrayElectrons({ waitMs = 15000 } = {}) {
  const before = listElectronProcesses();
  for (const proc of before) {
    try {
      execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (listElectronProcesses().length === 0) return { killed: before, remaining: 0 };
    await sleep(200);
  }
  return { killed: before, remaining: listElectronProcesses().length };
}

/** Kill one process tree and wait until it is really gone. */
export async function killTree(pid, { waitMs = 20000 } = {}) {
  if (pid === undefined) return { pid, exited: true };
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {
    // already gone
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const alive = listElectronProcesses().some((p) => p.pid === pid);
    if (!alive) return { pid, exited: true };
    await sleep(150);
  }
  return { pid, exited: false };
}

/* ------------------------------------------------------------------ */
/* electron launch                                                     */
/* ------------------------------------------------------------------ */

export function isolatedDirs(tag) {
  const root = join(BENCH_ROOT, "tmp", tag);
  return {
    root,
    userData: join(root, "userdata"),
    appData: join(root, "appdata"),
    localAppData: join(root, "localappdata"),
    hookLog: join(root, "main-hook.jsonl"),
    logs: join(root, "logs"),
  };
}

export function prepareIsolatedDirs(tag, { fresh }) {
  const dirs = isolatedDirs(tag);
  if (fresh) rmSync(dirs.root, { recursive: true, force: true });
  for (const dir of [dirs.userData, dirs.appData, dirs.localAppData, dirs.logs]) mkdirSync(dir, { recursive: true });
  if (fresh) rmSync(dirs.hookLog, { force: true });
  return dirs;
}

export function hookEnv(dirs, extra = {}) {
  return {
    ...process.env,
    // Unquoted on purpose: Node's NODE_OPTIONS parser does not strip quotes.
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${HOOK_PATH.replace(/\\/g, "/")}`].filter(Boolean).join(" "),
    OMP_PERF_HOOK_LOG: dirs.hookLog,
    APPDATA: dirs.appData,
    LOCALAPPDATA: dirs.localAppData,
    ...extra,
  };
}

export function readHookEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function hookMark(events, name) {
  const found = events.filter((e) => e.name === name);
  return found.length === 0 ? undefined : found[found.length - 1];
}

/* ------------------------------------------------------------------ */
/* renderer-side collection                                            */
/* ------------------------------------------------------------------ */

/**
 * Installed as a page function: waits for a run of `needed` consecutive
 * animation frames without DOM mutations (after the root has children) and
 * reports the timestamps in `performance.now()` milliseconds.
 */
export async function measureQuietFrames(page, { needed = 3, maxMs = 8000 } = {}) {
  return page.evaluate(
    async ({ needed: need, maxMs: limit }) => {
      const root = document.getElementById("root") || document.body;
      const result = {
        observed: 0,
        frameCount: 0,
        quietStreak: 0,
        quietStart: null,
        quietEnd: null,
        maxFrameGapMs: 0,
        frameGaps: [],
        rootChildCountAtEnd: 0,
        timedOut: false,
      };
      const start = performance.now();
      const frames = [];
      let mutationsSinceFrame = 0;
      const observer = new MutationObserver((list) => {
        mutationsSinceFrame += list.length;
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      let last = start;
      await new Promise((done) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          done();
        };
        const tick = (ts) => {
          const gap = ts - last;
          last = ts;
          frames.push({ t: ts, mutations: mutationsSinceFrame, children: root.childElementCount });
          mutationsSinceFrame = 0;
          if (ts - start > limit) {
            result.timedOut = true;
            finish();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const poll = setInterval(() => {
          let streak = 0;
          let streakStartIndex = null;
          for (let i = 0; i < frames.length; i += 1) {
            if (frames[i].mutations === 0 && frames[i].children > 0) {
              if (streak === 0) streakStartIndex = i;
              streak += 1;
              if (streak >= need) {
                result.quietStart = frames[streakStartIndex].t;
                result.quietEnd = frames[i].t;
                result.quietStreak = streak;
                clearInterval(poll);
                finish();
                return;
              }
            } else {
              streak = 0;
              streakStartIndex = null;
            }
          }
        }, 50);
      });
      result.observed = frames.length;
      result.frameCount = frames.length;
      result.rootChildCountAtEnd = root.childElementCount;
      let maxGap = 0;
      const gaps = [];
      for (let i = 1; i < frames.length; i += 1) {
        const gap = frames[i].t - frames[i - 1].t;
        gaps.push(Math.round(gap * 100) / 100);
        if (gap > maxGap) maxGap = gap;
      }
      result.maxFrameGapMs = Math.round(maxGap * 100) / 100;
      result.frameGaps = gaps;
      result.firstFrameAt = frames.length > 0 ? Math.round(frames[0].t * 100) / 100 : null;
      return result;
    },
    { needed, maxMs },
  );
}

/** Navigation timing + paint + LCP entries, in renderer clock and epoch. */
export async function collectRendererTimings(page) {
  return page.evaluate(async () => {
    const origin = performance.timeOrigin;
    const nav = performance.getEntriesByType("navigation")[0];
    const paints = performance.getEntriesByType("paint").map((entry) => ({ name: entry.name, startTime: entry.startTime }));
    const lcpEntries = await new Promise((done) => {
      const entries = [];
      let observer;
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            entries.push({
              startTime: entry.startTime,
              size: entry.size,
              url: entry.url === "" ? undefined : entry.url,
              element: entry.element && entry.element.tagName ? entry.element.tagName : undefined,
            });
          }
        });
        observer.observe({ type: "largest-contentful-paint", buffered: true });
      } catch {
        done([]);
        return;
      }
      setTimeout(() => {
        try {
          observer.disconnect();
        } catch {
          /* ignore */
        }
        done(entries);
      }, 250);
    });
    const navigation = nav
      ? {
          startTime: nav.startTime,
          redirectStart: nav.redirectStart,
          domInteractive: nav.domInteractive,
          domContentLoadedEventStart: nav.domContentLoadedEventStart,
          domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
          loadEventStart: nav.loadEventStart,
          loadEventEnd: nav.loadEventEnd,
          duration: nav.duration,
          transferSize: nav.transferSize,
          encodedBodySize: nav.encodedBodySize,
          decodedBodySize: nav.decodedBodySize,
        }
      : null;
    const paint = {};
    for (const entry of paints) paint[entry.name] = Math.round(entry.startTime * 100) / 100;
    const lcp = lcpEntries.length === 0 ? null : lcpEntries[lcpEntries.length - 1];
    return {
      timeOrigin: origin,
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      navigation,
      paint: {
        firstPaint: paint["first-paint"] ?? null,
        firstContentfulPaint: paint["first-contentful-paint"] ?? null,
        lcpStartTime: lcp ? Math.round(lcp.startTime * 100) / 100 : null,
        lcpEpoch: lcp ? Math.round(origin + lcp.startTime) : null,
        lcpElement: lcp ? lcp.element : undefined,
      },
      dclEpoch: nav ? Math.round(origin + nav.domContentLoadedEventEnd) : null,
      loadEpoch: nav ? Math.round(origin + nav.loadEventEnd) : null,
      fcpEpoch: paint["first-contentful-paint"] !== undefined ? Math.round(origin + paint["first-contentful-paint"]) : null,
      paintEpoch: paint["first-paint"] !== undefined ? Math.round(origin + paint["first-paint"]) : null,
      navStartEpoch: Math.round(origin),
    };
  });
}

/** Resource timing summary, with an explicit JS breakdown. */
export async function collectResourceSummary(page) {
  return page.evaluate(() => {
    const entries = performance.getEntriesByType("resource").map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
      duration: Math.round(entry.duration * 100) / 100,
      startTime: Math.round(entry.startTime * 100) / 100,
      responseEnd: Math.round(entry.responseEnd * 100) / 100,
    }));
    const isScript = (e) => e.initiatorType === "script" || /\.m?js(\?|$)/i.test(e.name);
    const scripts = entries.filter(isScript);
    const sum = (list, key) => list.reduce((acc, item) => acc + (Number.isFinite(item[key]) ? item[key] : 0), 0);
    return {
      totalResources: entries.length,
      totalTransferBytes: sum(entries, "transferSize"),
      totalEncodedBodyBytes: sum(entries, "encodedBodySize"),
      totalDecodedBodyBytes: sum(entries, "decodedBodySize"),
      scriptCount: scripts.length,
      scriptTransferBytes: sum(scripts, "transferSize"),
      scriptEncodedBytes: sum(scripts, "encodedBodySize"),
      scriptDecodedBytes: sum(scripts, "decodedBodySize"),
      scriptDurationSumMs: Math.round(sum(scripts, "duration") * 100) / 100,
      largestScripts: scripts
        .slice()
        .sort((a, b) => b.decodedBodySize - a.decodedBodySize)
        .slice(0, 15)
        .map((e) => ({ name: e.name.replace(/^.*\/dist\//, ""), transferSize: e.transferSize, decodedBodySize: e.decodedBodySize, duration: e.duration })),
      entries,
    };
  });
}

/** CDP Performance.getMetrics as a flat object. */
export async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const flat = {};
  for (const metric of metrics) flat[metric.name] = metric.value;
  return flat;
}

/**
 * DOM snapshot used to discover stable selectors for the interaction probe.
 * Read-only: it serialises what the renderer currently shows.
 */
export async function snapshotDom(page) {
  return page.evaluate(() => {
    const describe = (el) =>
      el === null || el === undefined
        ? null
        : {
            tag: el.tagName ? el.tagName.toLowerCase() : null,
            id: el.id || null,
            role: el.getAttribute ? el.getAttribute("role") : null,
            ariaLabel: el.getAttribute ? el.getAttribute("aria-label") : null,
            dataTestId: el.getAttribute ? el.getAttribute("data-testid") : null,
            title: el.getAttribute ? el.getAttribute("title") : null,
            text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) || null,
            className: typeof el.className === "string" ? el.className.slice(0, 120) : null,
          };
    const buttons = Array.from(document.querySelectorAll("button,[role='button'],a")).slice(0, 120).map(describe);
    const inputs = Array.from(document.querySelectorAll("textarea,input,[contenteditable='true'],[role='textbox']")).slice(0, 40).map(describe);
    const scrollables = Array.from(document.querySelectorAll("*"))
      .filter((el) => el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 100)
      .slice(0, 20)
      .map((el) => ({ ...describe(el), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    return {
      url: location.href,
      title: document.title,
      bodyTextLength: (document.body && document.body.innerText ? document.body.innerText.length : 0) || 0,
      bodyTextSample: (document.body && document.body.innerText ? document.body.innerText : "").replace(/\s+/g, " ").slice(0, 800),
      buttons,
      inputs,
      scrollables,
      rootChildren: document.getElementById("root") ? document.getElementById("root").childElementCount : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* bundle bytes + reload cost                                          */
/* ------------------------------------------------------------------ */

export function collectBundleStats() {
  const dist = join(REPO_ROOT, "apps", "renderer", "dist");
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({ path: full.replace(dist + sep, "").replaceAll("\\", "/"), bytes: statSync(full).size });
    }
  };
  walk(dist);
  const js = files.filter((file) => /\.m?js$/.test(file.path));
  const css = files.filter((file) => /\.css$/.test(file.path));
  const indexHtml = existsSync(join(dist, "index.html")) ? readFileSync(join(dist, "index.html"), "utf8") : "";
  const referenced = Array.from(indexHtml.matchAll(/(?:src|href)="\.?\/?([^"]+)"/g)).map((match) => match[1]);
  const referencedBytes = referenced.map((ref) => {
    const match = files.find((file) => file.path === ref.replace(/^\.\//, ""));
    return { ref, bytes: match ? match.bytes : null };
  });
  return {
    dist,
    fileCount: files.length,
    jsFileCount: js.length,
    jsTotalBytes: js.reduce((acc, file) => acc + file.bytes, 0),
    cssTotalBytes: css.reduce((acc, file) => acc + file.bytes, 0),
    largestJs: js
      .slice()
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 15),
    entryReferenced: referencedBytes,
  };
}

/**
 * Re-load the already loaded document with CDP attached *before* navigation so
 * the Performance domain counters cover a whole document load, and count real
 * transferred bytes with the Network domain. Renderer documents load from
 * `file://`, and Chromium exposes no Resource Timing entries for that scheme,
 * so this is the only way to get per-document byte counts.
 */
export async function measureReloadCost(page) {
  const cdp = await page.context().newCDPSession(page);
  const requests = new Map();
  const finished = [];
  cdp.on("Network.responseReceived", (event) => {
    requests.set(event.requestId, {
      url: event.response.url,
      type: event.type,
      status: event.response.status,
      fromDiskCache: event.response.fromDiskCache === true,
      mimeType: event.response.mimeType,
    });
  });
  cdp.on("Network.loadingFinished", (event) => {
    const request = requests.get(event.requestId);
    if (request === undefined) return;
    finished.push({ ...request, encodedDataLength: event.encodedDataLength });
  });
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  // Long tasks + frame gaps for the reloaded document.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: [
      "window.__perfAuditLongTasks = [];",
      "try {",
      "  new PerformanceObserver((list) => {",
      "    for (const entry of list.getEntries()) window.__perfAuditLongTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name });",
      "  }).observe({ type: 'longtask', buffered: true });",
      "} catch (error) { window.__perfAuditLongTasks = [{ error: String(error) }]; }",
      "(() => {",
      "  const frames = []; let last = performance.now();",
      "  function tick(ts) { frames.push(ts - last); last = ts; if (performance.now() < 15000) requestAnimationFrame(tick); }",
      "  requestAnimationFrame(tick);",
      "  window.__perfAuditFrameGaps = frames;",
      "})();",
    ].join("\n"),
  });
  const reloadStarted = Date.now();
  await page.reload({ waitUntil: "load", timeout: 60000 });
  const reloadLoadMs = Date.now() - reloadStarted;
  await sleep(1200);
  const metrics = await cdpMetrics(cdp);
  const documentTiming = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paints = performance.getEntriesByType("paint").map((entry) => ({ name: entry.name, startTime: entry.startTime }));
    return {
      navigation: nav ? { domContentLoadedEventEnd: nav.domContentLoadedEventEnd, loadEventEnd: nav.loadEventEnd, duration: nav.duration } : null,
      paint: Object.fromEntries(paints.map((entry) => [entry.name, entry.startTime])),
      longTasks: window.__perfAuditLongTasks || [],
      frameGaps: (window.__perfAuditFrameGaps || []).map((gap) => Math.round(gap * 100) / 100),
    };
  });
  await cdp.detach().catch(() => {});
  const scripts = finished.filter((item) => item.type === "Script" || /\.m?js(\?|$)/i.test(item.url));
  const sumBy = (list, key) => list.reduce((acc, item) => acc + (Number.isFinite(item[key]) ? item[key] : 0), 0);
  return {
    reloadLoadMs,
    metrics,
    documentTiming,
    network: {
      requestCount: finished.length,
      encodedTotalBytes: sumBy(finished, "encodedDataLength"),
      scriptCount: scripts.length,
      scriptEncodedBytes: sumBy(scripts, "encodedDataLength"),
      fromDiskCacheCount: finished.filter((item) => item.fromDiskCache).length,
      resources: finished.map((item) => ({
        url: item.url.replace(/^.*\/dist\//, ""),
        type: item.type,
        status: item.status,
        encodedDataLength: item.encodedDataLength,
        fromDiskCache: item.fromDiskCache,
      })),
    },
  };
}

export { spawn };
