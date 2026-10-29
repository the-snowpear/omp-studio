#!/usr/bin/env node
/**
 * Startup phase probe for OMP Studio (Electron).
 *
 * Measures, for each launch:
 *   spawn -> OS process creation -> main hook load -> app ready -> window
 *   created -> ready-to-show -> renderer navigation start -> FCP / LCP /
 *   DOMContentLoaded / load -> "first screen interactive" (3 consecutive
 *   animation frames with zero DOM mutations after the root is populated).
 *
 * Two channels are recorded on purpose:
 *   - the main-process hook (NODE_OPTIONS --require, timestamps from inside
 *     Electron) is authoritative for the phase boundaries;
 *   - the Playwright side gives the wall-clock spawn instant and the renderer
 *     entries, so the two can be cross-checked. Playwright connect overhead
 *     only affects the `spawn -> process creation` line, which is reported
 *     with that caveat.
 *
 * Usage:
 *   node scripts/perf-audit/startup-probe.mjs --runs 3 --scenario both
 *   PERF_AUDIT_REPORT=outputs/perf-audit/bench/raw/startup.json node ... 
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { _electron as electron } from "playwright";

import {
  APP_DIR,
  BENCH_ROOT,
  ELECTRON_EXE,
  REPO_ROOT,
  RAW_ROOT,
  collectBundleStats,
  readHookEvents as readHookEventsLib,
  collectEnvironment,
  collectHostCpu,
  collectRendererTimings,
  collectResourceSummary,
  cdpMetrics,
  ensureDirs,
  hookEnv,
  hookMark,
  hostBusyPercent,
  killStrayElectrons,
  killTree,
  listElectronProcesses,
  measureQuietFrames,
  measureReloadCost,
  prepareIsolatedDirs,
  readHookEvents,
  round,
  sleep,
  snapshotDom,
  summarize,
  writeJson,
} from "./lib/collect.mjs";

let ELECTRON = ELECTRON_EXE;
let NATIVE_TAG = "";

function parseArgs(argv) {
  const args = { runs: 3, scenario: "both", keep: false, dumpDom: false, native: true, nativeOnly: false, exe: null, tag: "", timeout: 120000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--runs") args.runs = Number(argv[++i]);
    else if (arg === "--scenario") args.scenario = argv[++i];
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--dump-dom") args.dumpDom = true;
    else if (arg === "--no-native") args.native = false;
    else if (arg === "--native-only") args.nativeOnly = true;
    else if (arg === "--exe") args.exe = argv[++i];
    else if (arg === "--tag") args.tag = argv[++i];
    else if (arg === "--timeout") args.timeout = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const HOOK_STAGES = [
  "hook-load",
  "hook-registered",
  "app-ready",
  "window-created",
  "ready-to-show",
  "window-show",
  "did-start-loading",
  "dom-ready",
  "did-finish-load",
];

function hookEpoch(events, name) {
  const mark = hookMark(events, name);
  return mark === undefined ? null : mark.epoch;
}

function delta(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return round(to - from, 2);
}

async function readMainState(app) {
  return app.evaluate(async ({ app: electronApp }) => {
    const metrics = electronApp.getAppMetrics();
    let gpuFeatureStatus = null;
    try {
      gpuFeatureStatus = electronApp.getGPUFeatureStatus();
    } catch (error) {
      gpuFeatureStatus = { error: String((error && error.message) || error) };
    }
    let gpuInfoBasic = null;
    try {
      gpuInfoBasic = await electronApp.getGPUInfo("basic");
    } catch (error) {
      gpuInfoBasic = { error: String((error && error.message) || error) };
    }
    const windows = electronApp
      .getAppMetrics()
      .map((entry) => ({ pid: entry.pid, type: entry.type, creationTime: entry.creationTime }));
    return {
      pid: process.pid,
      appPath: electronApp.getAppPath(),
      appVersion: electronApp.getVersion(),
      isPackaged: electronApp.isPackaged,
      locale: electronApp.getLocale(),
      systemVersion: process.getSystemVersion(),
      chrome: process.versions.chrome,
      v8: process.versions.v8,
      node: process.versions.node,
      totalMemoryKb: electronApp.getAppMetrics().length,
      processes: metrics.map((entry) => ({
        pid: entry.pid,
        type: entry.type,
        creationTime: entry.creationTime,
        cpuPercent: entry.cpu ? entry.cpu.percentCPUUsage : null,
        idleWakeupsPerSecond: entry.cpu ? entry.cpu.idleWakeupsPerSecond : null,
        workingSetSizeKb: entry.memory ? entry.memory.workingSetSize : null,
      })),
      browserCreationTime: metrics.length > 0 ? metrics[0].creationTime : null,
      gpuFeatureStatus,
      gpuInfoBasic,
      rendererCount: windows.filter((entry) => entry.type === "Tab" || entry.type === "Renderer").length,
    };
  });
}

async function runOnce({ scenario, runIndex, dirs, timeout }) {
  const hostBefore = collectHostCpu();
  const hookLog = dirs.hookLog;
  const launchStartedAt = Date.now();
  let electronApp;
  let page;
  const run = {
    scenario,
    runIndex,
    launchStartedAt,
    isolated: dirs,
    errors: [],
    warnings: [],
  };
  try {
    electronApp = await electron.launch({
      executablePath: ELECTRON,
      args: [APP_DIR, `--user-data-dir=${dirs.userData}`],
      cwd: BENCH_ROOT.replace(/\\outputs\\perf-audit\\bench$/, ""),
      env: hookEnv(dirs),
      timeout,
    });
    run.playwrightLaunchMs = round(Date.now() - launchStartedAt, 2);
    page = await electronApp.firstWindow({ timeout });
    run.firstWindowMs = round(Date.now() - launchStartedAt, 2);

    await page.waitForLoadState("load", { timeout: Math.max(15000, timeout / 2) }).catch((error) => {
      run.warnings.push(`load state wait failed: ${String((error && error.message) || error).slice(0, 200)}`);
    });
    const quiet = await measureQuietFrames(page, { needed: 3, maxMs: 8000 });
    run.quietFrames = quiet;
    const timings = await collectRendererTimings(page);
    run.renderer = timings;
    run.resources = await collectResourceSummary(page);
    run.bundleStats = collectBundleStats();
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Performance.enable");
      run.cdpMetrics = await cdpMetrics(cdp);
    } catch (error) {
      run.warnings.push(`cdp metrics failed: ${String((error && error.message) || error).slice(0, 200)}`);
    } finally {
      await cdp.detach().catch(() => {});
    }
    run.reloadCost = await measureReloadCost(page).catch((error) => ({ error: String((error && error.message) || error) }));
    run.main = await readMainState(electronApp);
    if (process.env.PERF_AUDIT_DUMP_DOM === "1") run.domSnapshot = await snapshotDom(page);
    if (run.main.browserCreationTime != null) {
      // Electron 43 already reports creationTime in epoch milliseconds.
      run.processCreationEpoch = round(run.main.browserCreationTime, 1);
    }
  } catch (error) {
    run.errors.push(String((error && error.stack) || error));
    run.fatal = true;
  } finally {
    if (electronApp !== undefined) {
      const startedClose = Date.now();
      await electronApp.close().catch((error) => run.warnings.push(`close failed: ${String((error && error.message) || error)}`));
      run.closeMs = round(Date.now() - startedClose, 2);
      const pid = run.main ? run.main.pid : undefined;
      const killResult = await killTree(pid);
      run.killResult = killResult;
    }
    const hostAfter = collectHostCpu();
    run.hostBusyPercentDuringRun = hostBusyPercent(hostBefore, hostAfter);
    run.remainingElectronProcesses = listElectronProcesses().length;
  }

  const events = readHookEvents(hookLog);
  run.hookEvents = events;
  run.hookMarks = Object.fromEntries(HOOK_STAGES.map((stage) => [stage, hookEpoch(events, stage)]));
  for (const stage of Object.keys(run.hookMarks)) {
    const mark = hookMark(events, stage);
    if (mark !== undefined) run.hookMarks[`${stage}Hr`] = mark.hr;
  }
  const marks = run.hookMarks;
  const procStart = run.processCreationEpoch;
  const renderer = run.renderer || {};
  const quietEndEpoch =
    renderer.timeOrigin !== undefined && run.quietFrames && run.quietFrames.quietEnd !== null
      ? round(renderer.timeOrigin + run.quietFrames.quietEnd, 1)
      : null;
  run.timeline = {
    spawnEpoch: launchStartedAt,
    processCreationEpoch: procStart,
    hookLoadEpoch: marks["hook-load"] ?? null,
    appReadyEpoch: marks["app-ready"] ?? null,
    windowCreatedEpoch: marks["window-created"] ?? null,
    readyToShowEpoch: marks["ready-to-show"] ?? null,
    windowShowEpoch: marks["window-show"] ?? null,
    domReadyEpoch: marks["dom-ready"] ?? null,
    didFinishLoadEpoch: marks["did-finish-load"] ?? null,
    rendererNavStartEpoch: renderer.navStartEpoch ?? null,
    fcpEpoch: renderer.fcpEpoch ?? null,
    lcpEpoch: renderer.paint ? renderer.paint.lcpEpoch : null,
    dclEpoch: renderer.dclEpoch ?? null,
    loadEpoch: renderer.loadEpoch ?? null,
    interactiveEpoch: quietEndEpoch,
  };
  run.stages = {
    "spawn -> processCreated (Playwright call overhead included)": delta(procStart === null ? NaN : launchStartedAt, procStart),
    "processCreated -> hookLoad (node/electron bootstrap)": delta(procStart, marks["hook-load"]),
    "processCreated -> appReady": delta(procStart, marks["app-ready"]),
    "appReady -> windowCreated": delta(marks["app-ready"], marks["window-created"]),
    "windowCreated -> readyToShow": delta(marks["window-created"], marks["ready-to-show"]),
    "processCreated -> readyToShow": delta(procStart, marks["ready-to-show"]),
    "processCreated -> rendererNavStart": delta(procStart, renderer.navStartEpoch),
    "rendererNavStart -> DOMContentLoaded": renderer.navigation ? round(renderer.navigation.domContentLoadedEventEnd, 2) : null,
    "rendererNavStart -> load": renderer.navigation ? round(renderer.navigation.loadEventEnd, 2) : null,
    "rendererNavStart -> FCP": renderer.paint ? renderer.paint.firstContentfulPaint : null,
    "rendererNavStart -> LCP": renderer.paint ? renderer.paint.lcpStartTime : null,
    "load -> interactive (3 quiet frames)": quietEndEpoch !== null && renderer.loadEpoch ? delta(renderer.loadEpoch, quietEndEpoch) : null,
    "processCreated -> interactive": delta(procStart, quietEndEpoch),
    "spawn -> interactive": delta(launchStartedAt, quietEndEpoch),
  };
  if (quietEndEpoch === null) {
    run.warnings.push("interactive proxy unavailable: no 3-frame quiet streak inside the sampling window");
  }
  return run;
}

async function runScenario({ scenario, runs, timeout, dumpDom }) {
  const results = [];
  const hotTag = "startup-hot";
  if (scenario === "hot") {
    // One priming launch so the profile / browser caches are warm, then measure.
    const dirs = prepareIsolatedDirs(hotTag, { fresh: true });
    const priming = await runOnce({ scenario: "hot-priming", runIndex: 0, dirs, timeout });
    await sleep(1500);
    if (priming.fatal) return { scenario, primingFatal: priming.errors, runs: [] };
  }
  for (let i = 1; i <= runs; i += 1) {
    const dirs = scenario === "hot" ? prepareIsolatedDirs(hotTag, { fresh: false }) : prepareIsolatedDirs(`startup-cold-${i}`, { fresh: true });
    const stray = listElectronProcesses();
    if (stray.length > 0) await killStrayElectrons();
    const result = await runOnce({ scenario, runIndex: i, dirs, timeout });
    results.push(result);
    await sleep(1500);
  }
  return { scenario, runs: results };
}


/* ------------------------------------------------------------------ */
/* native channel: direct spawn + main-process hook (no Playwright)     */
/* ------------------------------------------------------------------ */

/**
 * Launches electron.exe directly with the NODE_OPTIONS hook in place. This is
 * the authoritative channel for the main-process phases: nothing (no debugger,
 * no automation driver) sits between `CreateProcess` and the app. Renderer
 * metrics are not available here; the Playwright channel covers those.
 */
async function runNativeOnce({ scenario, runIndex, dirs, timeout }) {
  const spawnEpoch = Date.now();
  const hostBefore = collectHostCpu();
  const child = spawn(ELECTRON, [APP_DIR, `--user-data-dir=${dirs.userData}`], {
    cwd: REPO_ROOT,
    env: hookEnv(dirs),
    stdio: "ignore",
    windowsHide: false,
  });
  const run = { scenario, runIndex, channel: "native", spawnEpoch, isolated: dirs, errors: [], warnings: [] };
  const deadline = Date.now() + timeout;
  let lastNames = "";
  while (Date.now() < deadline) {
    const events = readHookEvents(dirs.hookLog);
    const names = events.map((event) => event.name).join(",");
    if (names !== lastNames) lastNames = names;
    const finished = events.some((event) => event.name === "did-finish-load");
    if (finished) break;
    if (child.exitCode !== null) break;
    await sleep(25);
  }
  // Let the window actually show (ready-to-show may follow did-finish-load).
  await sleep(1200);
  run.exitCode = child.exitCode;
  run.mainPid = child.pid;
  const events = readHookEvents(dirs.hookLog);
  run.hookEvents = events;
  run.remainingElectronProcessesBeforeKill = listElectronProcesses().length;
  await killTree(child.pid);
  run.hostBusyPercentDuringRun = hostBusyPercent(hostBefore, collectHostCpu());
  run.afterKillElectronProcesses = listElectronProcesses().length;
  const markEpoch = (name) => {
    const mark = hookMark(events, name);
    return mark === undefined ? null : mark.epoch;
  };
  const hookLoad = hookMark(events, "hook-load");
  const procStartEpoch = hookLoad === undefined ? null : round(hookLoad.epoch - (hookLoad.uptimeMs ?? 0), 1);
  run.timeline = {
    spawnEpoch,
    processCreationEpoch: procStartEpoch,
    hookLoadEpoch: markEpoch("hook-load"),
    appReadyEpoch: markEpoch("app-ready"),
    windowCreatedEpoch: markEpoch("window-created"),
    readyToShowEpoch: markEpoch("ready-to-show"),
    windowShowEpoch: markEpoch("window-show"),
    domReadyEpoch: markEpoch("dom-ready"),
    didFinishLoadEpoch: markEpoch("did-finish-load"),
  };
  const t = run.timeline;
  run.stages = {
    "spawn -> processCreated": delta(spawnEpoch, procStartEpoch),
    "processCreated -> hookLoad (node/electron bootstrap)": delta(procStartEpoch, t.hookLoadEpoch),
    "processCreated -> appReady": delta(procStartEpoch, t.appReadyEpoch),
    "appReady -> windowCreated": delta(t.appReadyEpoch, t.windowCreatedEpoch),
    "windowCreated -> readyToShow": delta(t.windowCreatedEpoch, t.readyToShowEpoch),
    "processCreated -> readyToShow": delta(procStartEpoch, t.readyToShowEpoch),
    "processCreated -> didFinishLoad": delta(procStartEpoch, t.didFinishLoadEpoch),
    "spawn -> readyToShow": delta(spawnEpoch, t.readyToShowEpoch),
  };
  if (t.appReadyEpoch === null) run.errors.push("hook did not record app-ready (NODE_OPTIONS hook inactive?)");
  return run;
}

async function runNativeScenario({ scenario, runs, timeout }) {
  const results = [];
  const tag = `${NATIVE_TAG || "native"}-${scenario}`;
  if (scenario === "hot") {
    const warmDirs = prepareIsolatedDirs(tag, { fresh: true });
    await runNativeOnce({ scenario: "hot-priming", runIndex: 0, dirs: warmDirs, timeout });
    await sleep(1200);
  }
  for (let i = 1; i <= runs; i += 1) {
    if (listElectronProcesses().length > 0) await killStrayElectrons();
    const dirs = scenario === "hot" ? prepareIsolatedDirs(tag, { fresh: false }) : prepareIsolatedDirs(`native-cold-${i}`, { fresh: true });
    results.push(await runNativeOnce({ scenario, runIndex: i, dirs, timeout }));
    await sleep(1200);
  }
  return { scenario, runs: results };
}

function aggregate(runs) {
  const stageNames = Object.keys(runs[0]?.stages || {});
  const table = {};
  for (const name of stageNames) {
    const values = runs.map((run) => run.stages[name]).filter((value) => typeof value === "number" && Number.isFinite(value));
    table[name] = summarize(values);
  }
  return table;
}

async function main() {
  ensureDirs();
  const args = parseArgs(process.argv.slice(2));
  const scenarios = args.scenario === "both" ? ["cold", "hot"] : [args.scenario];
  if (args.exe) ELECTRON = args.exe;
  NATIVE_TAG = args.tag || "";
  const environment = collectEnvironment();
  const baselineBefore = collectHostCpu();
  await sleep(2000);
  const baselineHostBusyPercent = hostBusyPercent(baselineBefore, collectHostCpu());
  const strayBefore = await killStrayElectrons();

  const report = {
    probe: "startup",
    generatedAt: new Date().toISOString(),
    environment,
    baselineHostBusyPercent,
    strayElectronsKilledBeforeStart: strayBefore,
    args,
    scenarios: {},
  };

  for (const scenario of scenarios) {
    if (args.nativeOnly) break;
    const outcome = await runScenario({ scenario, runs: args.runs, timeout: args.timeout, dumpDom: args.dumpDom });
    report.scenarios[scenario] = { runs: outcome.runs, aggregate: aggregate(outcome.runs) };
    if (outcome.primingFatal) report.scenarios[scenario].primingFatal = outcome.primingFatal;
  }
  if (args.native) {
    report.native = {};
    for (const scenario of scenarios) {
      const outcome = await runNativeScenario({ scenario, runs: args.runs, timeout: args.timeout });
      report.native[scenario] = { runs: outcome.runs, aggregate: aggregate(outcome.runs) };
    }
  }
  report.strayElectronsAfter = listElectronProcesses();
  report.exe = ELECTRON;
  report.tag = args.tag;
  report.nativeOnly = args.nativeOnly;
  const outPath = process.env.PERF_AUDIT_REPORT ?? join(RAW_ROOT, args.tag ? `startup-${args.tag}.json` : "startup.json");
  writeJson(outPath, report);
  console.log(JSON.stringify({ outPath, scenarios: Object.keys(report.scenarios), native: Object.keys(report.native ?? {}) }, null, 2));
  const printScenario = (label, data) => {
    console.log(`\n== ${label} (n=${data.runs.length})`);
    for (const [name, stats] of Object.entries(data.aggregate)) {
      console.log(`  ${name.padEnd(56)} median=${String(stats.median).padStart(8)}  max=${String(stats.max).padStart(8)}  n=${stats.n}`);
    }
  };
  for (const [scenario, data] of Object.entries(report.scenarios)) printScenario(`playwright-${scenario}`, data);
  for (const [scenario, data] of Object.entries(report.native ?? {})) printScenario(`native-${scenario}`, data);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
