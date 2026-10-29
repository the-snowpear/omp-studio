#!/usr/bin/env node
/**
 * Low-end-machine interaction probe: OMP Studio under CDP 4x CPU throttling.
 *
 * For each scenario the probe records, per interaction:
 *   - wall time (renderer clock),
 *   - `Performance.getMetrics` deltas (TaskDuration / ScriptDuration /
 *     LayoutDuration / RecalcStyleDuration),
 *   - `longtask` entries (count, total, max),
 *   - dropped frames: rAF intervals > 50 ms (`droppedFrames / frames`),
 *   - the selector it actually used, so a skipped step is visible instead of
 *     silently reported as 0 ms.
 *
 * Usage:
 *   node scripts/perf-audit/throttle-probe.mjs --rate 4
 *   node scripts/perf-audit/throttle-probe.mjs --rate 4 --only pageSwitch
 */
import { join } from "node:path";
import process from "node:process";

import { _electron as electron } from "playwright";

import {
  APP_DIR,
  ELECTRON_EXE,
  REPO_ROOT,
  RAW_ROOT,
  cdpMetrics,
  collectEnvironment,
  ensureDirs,
  hookEnv,
  killStrayElectrons,
  killTree,
  listElectronProcesses,
  measureQuietFrames,
  prepareIsolatedDirs,
  round,
  sleep,
  snapshotDom,
  summarize,
  writeJson,
} from "./lib/collect.mjs";

function parseArgs(argv) {
  const args = { rate: 4, only: null, tag: "throttle" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rate") args.rate = Number(argv[++i]);
    else if (arg === "--only") args.only = argv[++i];
    else if (arg === "--tag") args.tag = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** Installed in the page: per-interaction sampler (frame gaps + long tasks). */
const SAMPLER_SOURCE = `
window.__perfAudit = {
  longTasks: [],
  frames: [],
  running: false,
  start() {
    this.longTasks = [];
    this.frames = [];
    this.running = true;
    this._last = performance.now();
    try {
      this._observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.longTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name });
      });
      this._observer.observe({ type: 'longtask', buffered: false });
    } catch (error) { this.longTaskError = String(error); }
    const tick = (ts) => {
      if (!this.running) return;
      this.frames.push(ts - this._last);
      this._last = ts;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
  stop() {
    this.running = false;
    try { this._observer && this._observer.disconnect(); } catch (error) { /* ignore */ }
    const gaps = this.frames.slice(1);
    const dropped = gaps.filter((gap) => gap > 50);
    return {
      frames: gaps.length,
      elapsedMs: round2(gaps.reduce((a, b) => a + b, 0)),
      droppedFrames: dropped.length,
      droppedFrameRate: gaps.length === 0 ? null : dropped.length / gaps.length,
      worstFrameMs: gaps.length === 0 ? null : Math.max(...gaps),
      longTasks: this.longTasks.length,
      longTaskTotalMs: this.longTasks.reduce((a, b) => a + b.duration, 0),
      longTaskMaxMs: this.longTasks.length === 0 ? 0 : Math.max(...this.longTasks.map((task) => task.duration)),
      longTaskError: this.longTaskError || null,
    };
    function round2(value) { return Math.round(value * 100) / 100; }
  },
};
`;

async function startSampler(page) {
  await page.evaluate(SAMPLER_SOURCE);
  await page.evaluate(() => window.__perfAudit.start());
}

async function stopSampler(page) {
  return page.evaluate(() => window.__perfAudit.stop());
}

async function metricsDelta(page, cdp, before) {
  const after = await cdpMetrics(cdp);
  const keys = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount"];
  const delta = {};
  for (const key of keys) {
    delta[key] = round(((after[key] ?? 0) - (before[key] ?? 0)) * 1000, 2); // milliseconds
  }
  return { before, after, deltaMs: delta };
}

/** Find the app's primary navigation buttons by their visible labels. */
async function discoverNav(page) {
  return page.evaluate(() => {
    const wanted = ["首页", "Agent Hub", "设置", "模型配置", "会话"];
    const candidates = Array.from(document.querySelectorAll("button,[role='button'],a,[data-nav]"));
    const found = [];
    for (const label of wanted) {
      const element = candidates.find((node) => {
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        const aria = node.getAttribute("aria-label") || "";
        const title = node.getAttribute("title") || "";
        return text === label || aria === label || title === label || text.startsWith(label);
      });
      found.push({ label, found: element !== undefined });
    }
    return found;
  });
}

async function clickByLabel(page, label) {
  const result = await page.evaluate((wanted) => {
    const nodes = Array.from(document.querySelectorAll("button,[role='button'],a,[role='menuitem'],.action-row"));
    const match = nodes.find((node) => {
      const text = (node.textContent || "").replace(/s+/g, " ").trim();
      const aria = node.getAttribute("aria-label") || "";
      const title = node.getAttribute("title") || "";
      return text === wanted || text.startsWith(wanted) || aria === wanted || title === wanted;
    });
    if (match === undefined) return { skipped: `no element matching ${wanted}` };
    match.click();
    return { used: wanted, className: typeof match.className === "string" ? match.className.slice(0, 60) : null };
  }, label);
  return result;
}

/** Return to the workbench shell from whatever surface the previous step left. */
async function resetWorkbench(page) {
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape").catch(() => {});
  const result = await page.evaluate(() => {
    const back = document.querySelector("button[aria-label='返回']");
    if (back !== null) back.click();
    return { clickedBack: back !== null };
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const create = document.querySelector(".new-convo-btn, button[aria-label='新建对话']");
    if (create !== null) create.click();
  });
  await page.waitForTimeout(700);
  return {
    ...result,
    state: await page.evaluate(() => ({
      composer: document.querySelector("#composerInput") !== null,
      workbench: document.querySelector(".sb-brand") !== null,
      nodes: document.querySelectorAll("*").length,
    })),
  };
}

async function findComposer(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']"));
    const scored = candidates
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { node, area: Math.max(0, rect.width) * Math.max(0, rect.height), tag: node.tagName.toLowerCase() };
      })
      .filter((item) => item.area > 1000)
      .sort((a, b) => b.area - a.area);
    if (scored.length === 0) return null;
    const target = scored[0].node;
    if (target.id === "") target.setAttribute("data-perf-audit-composer", "1");
    return { tag: scored[0].tag, area: Math.round(scored[0].area), selector: target.id ? `#${target.id}` : "[data-perf-audit-composer]" };
  });
}

async function findScrollable(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("*")).filter((node) => {
      if (node.scrollHeight <= node.clientHeight + 80) return false;
      const rect = node.getBoundingClientRect();
      if (rect.height < 200 || rect.width < 200) return false;
      const style = getComputedStyle(node);
      return /auto|scroll/.test(style.overflowY);
    });
    if (candidates.length === 0) return null;
    const target = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    target.setAttribute("data-perf-audit-scroll", "1");
    return { tag: target.tagName.toLowerCase(), scrollHeight: target.scrollHeight, clientHeight: target.clientHeight };
  });
}

async function main() {
  ensureDirs();
  const args = parseArgs(process.argv.slice(2));
  const environment = collectEnvironment();
  const strayBefore = await killStrayElectrons();
  const dirs = prepareIsolatedDirs(`${args.tag}-run`, { fresh: true });
  const report = {
    probe: "throttle",
    generatedAt: new Date().toISOString(),
    environment,
    args,
    cpuThrottleRate: args.rate,
    strayElectronsKilledBeforeStart: strayBefore,
    scenarios: {},
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
    report.pid = electronApp.process().pid;
    const page = await electronApp.firstWindow({ timeout: 120000 });
    await page.waitForLoadState("load", { timeout: 60000 }).catch(() => {});
    await measureQuietFrames(page, { needed: 3, maxMs: 10000 });
    report.startupQuiet = true;

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: args.rate });
    report.throttleApplied = true;
    await sleep(1500);

    report.dom = await snapshotDom(page);
    report.navDiscovery = await discoverNav(page);
    // The fresh-profile app opens a blocking "create project" modal, because
    // there is no Host Runtime / workspace. Dismiss it so later interactions
    // reach the real shell instead of the backdrop.
    report.overlayDismissal = await page.evaluate(() => {
      const exact = document.querySelector("button[aria-label='关闭技能与插件抽屉']");
      if (exact !== null) { exact.click(); return { clicked: ["关闭技能与插件抽屉"], backdropsBefore: document.querySelectorAll(".modal-backdrop").length }; }
      const labels = ["取消", "关闭", "以后再说", "稍后", "跳过", "Close", "Cancel"];
      const buttons = Array.from(document.querySelectorAll("button,[role='button']"));
      const details = [];
      for (const label of labels) {
        const button = buttons.find((node) => (node.textContent || "").replace(/\s+/g, " ").trim() === label);
        if (button !== undefined) {
          button.click();
          details.push(label);
          break;
        }
      }
      return { clicked: details, backdropsBefore: document.querySelectorAll(".modal-backdrop").length };
    });
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(600);
    report.overlayAfter = await page.evaluate(() => ({
      backdrops: document.querySelectorAll(".modal-backdrop").length,
      dialogs: document.querySelectorAll("[role='dialog']").length,
    }));

    const scenario = async (name, fn) => {
      if (args.only !== null && args.only !== name) return;
      const reset = await resetWorkbench(page);
      const before = await cdpMetrics(cdp);
      await startSampler(page);
      const started = Date.now();
      let detail;
      try {
        detail = await fn();
      } catch (error) {
        detail = { error: String((error && error.message) || error) };
      }
      const wallMs = Date.now() - started;
      const sampler = await stopSampler(page);
      const metrics = await metricsDelta(page, cdp, before);
      report.scenarios[name] = { wallMs, detail, sampler, reset, metrics: metrics.deltaMs, raw: metrics };
      console.log(
        `  ${name.padEnd(16)} wall=${String(wallMs).padStart(6)}ms tasks=${String(metrics.deltaMs.TaskDuration).padStart(7)}ms script=${String(metrics.deltaMs.ScriptDuration).padStart(7)}ms dropped=${sampler.droppedFrameRate === null ? "n/a" : (sampler.droppedFrameRate * 100).toFixed(1) + "%"} longtasks=${sampler.longTasks}`,
      );
      await sleep(800);
    };

    // 1. Switch the main workbench surfaces that exist without a Host Runtime.
    //    首页 / 设置 / 模型配置 / 会话 need a loaded project or the Runtime; the
    //    probe records them as unreachable instead of inventing numbers.
    await scenario("pageSwitch", async () => {
      const wanted = ["Agent Hub", "技能&插件", "新建对话", "全局搜索", "文件"];
      const steps = [];
      for (const label of wanted) {
        const stepStart = Date.now();
        const clicked = await clickByLabel(page, label);
        await page.waitForTimeout(400);
        steps.push({ label, ...clicked, ms: Date.now() - stepStart });
      }
      await resetWorkbench(page);
      const drawerStart = Date.now();
      const drawer = await clickByLabel(page, "技能&插件");
      await page.waitForTimeout(500);
      const drawerState = await page.evaluate(() => ({
        backdrops: document.querySelectorAll(".modal-backdrop").length,
        drawer: document.querySelector(".sd-head") !== null,
      }));
      steps.push({ label: "技能&插件", ...drawer, ms: Date.now() - drawerStart, drawerState });
      const unreachable = ["首页", "设置", "模型配置", "会话"];
      const discovered = await discoverNav(page);
      return { steps, unreachable, discovered };
    });

    // 2. Typing 200 characters into the composer.
    await scenario("composerTyping", async () => {
      const composer = await findComposer(page);
      if (composer === null) return { skipped: "no composer input found" };
      await page.evaluate((selector) => {
        const node = document.querySelector(selector);
        if (node !== null) { node.focus(); node.click(); }
      }, composer.selector);
      await page.waitForTimeout(150);
      const text = "性能审计输入测试 0123456789 abcdefghijklmnopqrstuvwxyz ".repeat(6).slice(0, 200);
      const started = Date.now();
      for (let i = 0; i < text.length; i += 20) {
        await page.keyboard.type(text.slice(i, i + 20), { delay: 0 });
      }
      const typedChars = text.length;
      const typedMs = Date.now() - started;
      const value = await page.evaluate((selector) => {
        const node = document.querySelector(selector);
        if (node === null) return null;
        return node.tagName.toLowerCase() === "textarea" ? node.value.length : (node.innerText || "").length;
      }, composer.selector);
      return { composer, typedChars, typedMs, valueLength: value };
    });

    // 3. Scrolling the conversation/list surface.
    await scenario("scrollList", async () => {
      const scrollable = await findScrollable(page);
      if (scrollable === null) return { skipped: "no scrollable list found" };
      const beforeScroll = await page.evaluate(() => document.querySelector("[data-perf-audit-scroll]").scrollTop);
      const box = await page.evaluate(() => {
        const node = document.querySelector("[data-perf-audit-scroll]");
        const rect = node.getBoundingClientRect();
        node.scrollTop = 0;
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
      });
      await page.mouse.move(box.x, box.y);
      for (let i = 0; i < 20; i += 1) {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(50);
      }
      const afterScroll = await page.evaluate(() => document.querySelector("[data-perf-audit-scroll]").scrollTop);
      return { scrollable, beforeScroll, afterScroll, box };
    });

    // 4. Opening and closing the command palette (a large overlay panel).
    await scenario("panelToggle", async () => {
      // Open the skills & plugins drawer (a full-height workbench panel) by
      // clicking the sidebar action row directly.
      const clicked = await page.evaluate(() => {
        const button = document.querySelector(".skills-btn, .action-row[class*='skills']");
        if (button === null) return { skipped: "no skills drawer button" };
        button.click();
        return { used: (button.textContent || "").replace(/s+/g, " ").trim().slice(0, 30) };
      });
      await page.waitForTimeout(1000);
      const state = await page.evaluate(() => ({
        nodes: document.querySelectorAll("*").length,
        dialogs: document.querySelectorAll("[role='dialog'], .modal-backdrop, [class*='palette']").length,
        activeElement: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
      }));
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
      return { clicked, state };
    });

    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await cdp.detach().catch(() => {});
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

  const outPath = process.env.PERF_AUDIT_REPORT ?? join(RAW_ROOT, "throttle.json");
  writeJson(outPath, report);
  console.log(`throttle report: ${outPath}`);
  const summary = {};
  for (const [name, data] of Object.entries(report.scenarios)) {
    summary[name] = {
      wallMs: data.wallMs,
      taskMs: data.metrics.TaskDuration,
      scriptMs: data.metrics.ScriptDuration,
      layoutMs: data.metrics.LayoutDuration,
      recalcMs: data.metrics.RecalcStyleDuration,
      longTasks: data.sampler.longTasks,
      droppedFrameRate: data.sampler.droppedFrameRate === null ? null : round(data.sampler.droppedFrameRate * 100, 1),
      worstFrameMs: data.sampler.worstFrameMs === null ? null : round(data.sampler.worstFrameMs, 1),
      detail: data.detail,
    };
  }
  report.summary = summary;
  writeJson(outPath, report);
  console.log(JSON.stringify(summary, null, 1));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
