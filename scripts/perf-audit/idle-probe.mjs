#!/usr/bin/env node
/**
 * Idle resource probe for OMP Studio (Electron).
 *
 * Launches the app once, waits until it is idle-ready, then samples
 * `app.getAppMetrics()` once per second for 60 s in three window states:
 *   1. normal (window visible and focused),
 *   2. blurred but visible (`win.blur()`),
 *   3. minimized (`win.minimize()`).
 *
 * Sampling happens inside the Electron main process (one setInterval) so the
 * probe's own IPC round-trips do not show up in the numbers. The host-wide CPU
 * busy percentage is sampled on the Node side at the same cadence, which lets
 * us separate "app idle cost" from "machine is busy anyway".
 *
 * Usage:
 *   node scripts/perf-audit/idle-probe.mjs --seconds 60 --states normal,blurred,minimized
 */
import { join } from "node:path";
import process from "node:process";

import { _electron as electron } from "playwright";

import {
  APP_DIR,
  ELECTRON_EXE,
  RAW_ROOT,
  REPO_ROOT,
  collectEnvironment,
  collectHostCpu,
  ensureDirs,
  hookEnv,
  hostBusyPercent,
  killStrayElectrons,
  killTree,
  listElectronProcesses,
  measureQuietFrames,
  prepareIsolatedDirs,
  round,
  sleep,
  summarize,
  writeJson,
} from "./lib/collect.mjs";

function parseArgs(argv) {
  const args = { seconds: 60, states: "normal,blurred,minimized", tag: "idle" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--seconds") args.seconds = Number(argv[++i]);
    else if (arg === "--states") args.states = argv[++i];
    else if (arg === "--tag") args.tag = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** Merge the per-second app metrics samples into per-process-type statistics. */
function summarizeSamples(samples) {
  /** @type {Record<string, {cpu: number[], rssMb: number[], wakeups: number[], pids: Set<number>}>} */
  const byType = {};
  for (const sample of samples) {
    for (const proc of sample.processes) {
      const bucket = (byType[proc.type] ??= { cpu: [], rssMb: [], wakeups: [], pids: new Set() });
      bucket.pids.add(proc.pid);
      if (Number.isFinite(proc.cpuPercent)) bucket.cpu.push(proc.cpuPercent);
      if (Number.isFinite(proc.workingSetSizeKb)) bucket.rssMb.push(proc.workingSetSizeKb / 1024);
      if (Number.isFinite(proc.idleWakeupsPerSecond)) bucket.wakeups.push(proc.idleWakeupsPerSecond);
    }
  }
  const out = {};
  for (const [type, bucket] of Object.entries(byType)) {
    out[type] = {
      pids: Array.from(bucket.pids),
      samples: bucket.cpu.length,
      cpuPercent: summarize(bucket.cpu),
      rssMb: {
        ...summarize(bucket.rssMb),
        peak: bucket.rssMb.length === 0 ? null : round(Math.max(...bucket.rssMb), 2),
        mean: bucket.rssMb.length === 0 ? null : round(bucket.rssMb.reduce((a, b) => a + b, 0) / bucket.rssMb.length, 2),
      },
      idleWakeupsPerSecond: summarize(bucket.wakeups),
    };
  }
  // Per-sample totals across every process of the app.
  const totalCpu = samples.map((sample) => sample.processes.reduce((acc, proc) => acc + (Number.isFinite(proc.cpuPercent) ? proc.cpuPercent : 0), 0));
  const totalRss = samples.map((sample) => sample.processes.reduce((acc, proc) => acc + (Number.isFinite(proc.workingSetSizeKb) ? proc.workingSetSizeKb : 0), 0) / 1024);
  out.__total = {
    samples: samples.length,
    cpuPercentSumAcrossProcesses: summarize(totalCpu),
    rssMbSumAcrossProcesses: {
      ...summarize(totalRss),
      peak: totalRss.length === 0 ? null : round(Math.max(...totalRss), 2),
    },
  };
  return out;
}

async function main() {
  ensureDirs();
  const args = parseArgs(process.argv.slice(2));
  const states = args.states.split(",").map((value) => value.trim()).filter(Boolean);
  const environment = collectEnvironment();
  const strayBefore = await killStrayElectrons();

  // Host baseline with no app running: how busy is this machine anyway?
  const baseBefore = collectHostCpu();
  await sleep(Math.min(10, args.seconds) * 1000);
  const hostBaselinePercent = hostBusyPercent(baseBefore, collectHostCpu());

  const dirs = prepareIsolatedDirs(`${args.tag}-run`, { fresh: true });
  const launchStartedAt = Date.now();
  const report = {
    probe: "idle",
    generatedAt: new Date().toISOString(),
    environment,
    hostBaselinePercent,
    strayElectronsKilledBeforeStart: strayBefore,
    args,
    windowStateChecks: {},
    perState: {},
    warnings: [],
  };

  let electronApp;
  try {
    electronApp = await electron.launch({
      executablePath: ELECTRON_EXE,
      args: [APP_DIR, `--user-data-dir=${dirs.userData}`],
      cwd: REPO_ROOT,
      env: hookEnv(dirs),
      timeout: 120000,
    });
    report.playwrightLaunchMs = round(Date.now() - launchStartedAt, 2);
    report.pid = electronApp.process().pid;
    report.processCreationEpoch = null;
    const page = await electronApp.firstWindow({ timeout: 120000 });
    await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
    const quiet = await measureQuietFrames(page, { needed: 3, maxMs: 10000 });
    report.readyAfterMs = round(Date.now() - launchStartedAt, 2);
    report.quietFrames = quiet;
    // Let the first-render burst fully settle before the idle window starts.
    await sleep(5000);

    // GPU state is collected once, from the live main process.
    report.gpu = await electronApp.evaluate(async ({ app }) => {
      const output = {};
      try {
        output.featureStatus = app.getGPUFeatureStatus();
      } catch (error) {
        output.featureStatusError = String((error && error.message) || error);
      }
      for (const level of ["basic", "complete"]) {
        try {
          output[`info_${level}`] = await app.getGPUInfo(level);
        } catch (error) {
          output[`info_${level}_error`] = String((error && error.message) || error);
        }
      }
      return output;
    });

    for (const state of states) {
      const stateApplied = await electronApp.evaluate(async ({ BrowserWindow }, wanted) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return { error: "no window" };
        if (wanted === "blurred") win.blur();
        else if (wanted === "minimized") win.minimize();
        else {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
        return { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() };
      }, state);

      const hostBefore = collectHostCpu();
      // Start the main-process sampler, wait, then harvest it.
      const samples = await electronApp.evaluate(
        async ({ app }, durationSeconds) => {
          const collected = [];
          const sampleOnce = () => {
            const metrics = app.getAppMetrics();
            collected.push({
              at: Date.now(),
              processes: metrics.map((entry) => ({
                pid: entry.pid,
                type: entry.type,
                cpuPercent: entry.cpu ? entry.cpu.percentCPUUsage : null,
                idleWakeupsPerSecond: entry.cpu ? entry.cpu.idleWakeupsPerSecond : null,
                workingSetSizeKb: entry.memory ? entry.memory.workingSetSize : null,
                peakWorkingSetSizeKb: entry.memory ? entry.memory.peakWorkingSetSize : null,
                privateBytesKb: entry.memory ? entry.memory.privateBytes : null,
              })),
            });
          };
          // Reset the CPU counters: percentCPUUsage is a delta since the previous call.
          sampleOnce();
          collected.length = 0;
          for (let i = 0; i < durationSeconds; i += 1) {
            await new Promise((done) => setTimeout(done, 1000));
            sampleOnce();
          }
          return collected;
        },
        args.seconds,
      );
      const hostAfter = collectHostCpu();
      report.windowStateChecks[state] = stateApplied;
      report.perState[state] = {
        durationSeconds: args.seconds,
        windowState: stateApplied,
        hostBusyPercentDuringWindow: hostBusyPercent(hostBefore, hostAfter),
        hostBusyPercentBaseline: hostBaselinePercent,
        byType: summarizeSamples(samples),
        firstSampleAt: samples.length > 0 ? new Date(samples[0].at).toISOString() : null,
        lastSampleAt: samples.length > 0 ? new Date(samples[samples.length - 1].at).toISOString() : null,
        rawSamples: samples,
      };
      await sleep(2000);
    }
    report.mainProcessMemory = await electronApp.evaluate(({ app }) => process.memoryUsage());
    report.appMetricsAtEnd = await electronApp.evaluate(({ app }) =>
      app.getAppMetrics().map((entry) => ({ pid: entry.pid, type: entry.type, workingSetSizeKb: entry.memory ? entry.memory.workingSetSize : null })),
    );
  } catch (error) {
    report.fatal = String((error && error.stack) || error);
  } finally {
    if (electronApp !== undefined) {
      await electronApp.close().catch((error) => report.warnings.push(`close failed: ${String((error && error.message) || error)}`));
    }
    await sleep(500);
    await killTree(report.pid);
    report.remainingElectronProcesses = listElectronProcesses().length;
  }

  const outPath = process.env.PERF_AUDIT_REPORT ?? join(RAW_ROOT, "idle.json");
  writeJson(outPath, report);
  console.log(`idle report: ${outPath}`);
  for (const [state, data] of Object.entries(report.perState)) {
    console.log(`\n== ${state} (${data.durationSeconds}s, host ${data.hostBusyPercentDuringWindow}% vs baseline ${report.hostBaselinePercent}%)`);
    for (const [type, stats] of Object.entries(data.byType)) {
      if (type === "__total") continue;
      console.log(
        `  ${type.padEnd(10)} cpu mean=${String(stats.cpuPercent.mean).padStart(6)} p95=${String(stats.cpuPercent.p95).padStart(6)} | rss mean=${String(stats.rssMb.mean).padStart(8)}MB peak=${String(stats.rssMb.peak).padStart(8)}MB | wakeups mean=${String(stats.idleWakeupsPerSecond.mean).padStart(6)}`,
      );
    }
    const total = data.byType.__total;
    console.log(`  TOTAL      cpu-sum mean=${total.cpuPercentSumAcrossProcesses.mean} | rss-sum mean=${total.rssMbSumAcrossProcesses.mean}MB peak=${total.rssMbSumAcrossProcesses.peak}MB`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
