/**
 * 流式渲染性能门禁（真 Chromium）。
 *
 * `npm test` 里的 streamingFrameCost 只量 jsdom 中 React 的 commit 时长 —— CSS 布局、
 * ResizeObserver、滚动写入、合成全部不在里面，所以"测试绿、真机掉帧"是可能的。这条门禁
 * 用 Playwright 起一个真 Chromium，加载 apps/renderer/perf-harness.html，按帧推进真实
 * runtime 事件，量的是 rAF 到 rAF 的间隔。
 *
 * 判定全部用**比值**而不是绝对毫秒：机器快慢会让绝对值飘，但"帧代价不随历史长度增长"
 * 和"展开动画不该把流式帧预算吃光"这两条不变量与机器无关。绝对上限只作为崩溃级兜底。
 *
 * 用法：
 *   npm run perf:streaming
 *   PERF_HEADED=1 npm run perf:streaming          # 想亲眼看一遍
 *   PERF_HISTORY_RATIO=3 npm run perf:streaming   # 临时放宽某条预算
 *
 * playwright 与 capture-readme-shots.mjs 一样按需装、不写进 package.json：主 CI 的三条
 * 门禁用不到它，没必要让每次 `npm ci` 都下 100MB 的 Chromium。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const rendererRoot = join(root, "apps", "renderer");
const reportPath = process.env.PERF_REPORT ?? join(root, "outputs", "streaming-perf.json");

/**
 * 历史越长、工具输出越多，单帧布局代价的允许放大倍数。
 *
 * 这是一条**棘轮**，不是理想值。2026-08-30 两个阶段的基线：
 * 首次实测 short 2.5ms/f → long 11.6ms/f（约 4.7×），放大来自在跑工具卡的行盒——
 * 1500 行保留输出每帧全量布局、可见的只有 320px 内的十几行；当天先用流式态动画
 * 剥离压住观感后比值仍 3~4.7。随后 `textChunks` 的 `content-visibility: auto` 分块
 * 落地（按 64 行切块、视口外跳过布局），长历史单帧布局降到 1.4~1.5ms，比值 1.3~1.4，
 * 棘轮随基线收到 2。再往下动布局时间之前先改这里的注释和数字。
 */
const HISTORY_RATIO = Number(process.env.PERF_HISTORY_RATIO ?? 2);
/** 崩溃级兜底：最忙场景的 p95 帧间隔上限（ms）。 */
const FRAME_CEILING_MS = Number(process.env.PERF_FRAME_CEILING_MS ?? 120);
/** 崩溃级兜底：最忙场景里「连漏两帧以上」的比例上限。稳定 30fps 不算卡顿，只算偏慢；
 *  真正伤观感的是间隔跳到 48ms 以上的那些帧。本机同一份代码多次跑在 0.07~0.17 之间波
 *  动，所以阈值留够余量 —— 这条只负责拦崩溃级回归，细粒度的判定交给上面两条。 */
const STALL_RATIO = Number(process.env.PERF_STALL_RATIO ?? 0.35);

const FRAMES = Number(process.env.PERF_FRAMES ?? 90);
/** 折叠/展开的间隔帧数。--dur-slow 是 250ms，所以这个节奏能让相当一部分帧落在过渡里。 */
const TOGGLE_EVERY = Number(process.env.PERF_TOGGLE_EVERY ?? 20);
const SHORT_SEED = { turns: 3, toolsPerTurn: 1, outputLines: 40 };
const LONG_SEED = { turns: 24, toolsPerTurn: 3, outputLines: 1200 };

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "playwright 未安装。这条门禁必须在真 Chromium 里跑：\n"
        + "  npm i --no-save playwright@1.62.1\n"
        + "  npx playwright install chromium",
    );
  }
}

async function startServer() {
  const { createServer } = await import("vite");
  const server = await createServer({
    root: rendererRoot,
    configFile: join(rendererRoot, "vite.config.ts"),
    logLevel: "warn",
    server: { host: "127.0.0.1", port: Number(process.env.PERF_PORT ?? 5187), strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (url === undefined) {
    await server.close();
    throw new Error("vite dev server 没有报告本地地址");
  }
  return { server, url: `${url.replace(/\/$/, "")}/perf-harness.html` };
}

/**
 * 一个场景：重置 → 预热一轮丢弃 → 正式量一轮。
 *
 * 除了帧间隔，还通过 CDP 取 `Performance.getMetrics` 的累积值做差。帧间隔被 vsync 量化
 * （60Hz 下只有 16.7 / 33.3 / 50 这些台阶），一旦掉到 30fps 就饱和了，"稍微更贵"和
 * "贵得多"读起来一样 —— 而 `LayoutDuration` / `RecalcStyleDuration` 是连续量，正好对应
 * 「工具卡在动画真实高度」这条结论。
 */
async function scenario(page, cdp, name, seed, runOptions) {
  await page.evaluate((value) => window.ompPerf.reset(value), seed);
  await page.evaluate(
    (value) => window.ompPerf.run(value),
    { ...runOptions, frames: Math.min(30, runOptions.frames) },
  );
  const before = await metrics(cdp);
  const result = await page.evaluate((value) => window.ompPerf.run(value), runOptions);
  const after = await metrics(cdp);
  const cost = {
    layoutMsPerFrame: ((after.LayoutDuration - before.LayoutDuration) * 1000) / result.frames,
    styleMsPerFrame: ((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000) / result.frames,
    scriptMsPerFrame: ((after.ScriptDuration - before.ScriptDuration) * 1000) / result.frames,
  };
  console.log(
    `${name.padEnd(22)} layout ${cost.layoutMsPerFrame.toFixed(2)}ms/f  style ${cost.styleMsPerFrame.toFixed(2)}ms/f  `
      + `script ${cost.scriptMsPerFrame.toFixed(2)}ms/f  median ${result.median.toFixed(1)}ms  p95 ${result.p95.toFixed(1)}ms  `
      + `>48ms ${result.stalls}/${result.frames}  toggles ${result.toggles}  rows ${result.rows}`,
  );
  return { name, seed, ...result, ...cost };
}

async function metrics(cdp) {
  const { metrics: entries } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
}

function check(name, actual, limit, detail) {
  const passed = actual <= limit;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}: ${actual.toFixed(2)} <= ${limit.toFixed(2)}  (${detail})`);
  return { name, actual: Number(actual.toFixed(3)), limit, status: passed ? "passed" : "failed", detail };
}

function assert(name, passed, detail) {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  return { name, status: passed ? "passed" : "failed", detail };
}

const started = await startServer();
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  headless: process.env.PERF_HEADED !== "1",
  args: ["--disable-lcd-text", "--force-device-scale-factor=1"],
});
let scenarios = [];
let contract = null;
let switchContract = null;
let error = null;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (issue) => { throw issue; });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(started.url, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.ompPerf === "object");
  const base = { charsPerFrame: 48, toolLinesPerFrame: 2, toggleEveryFrames: 0, frames: FRAMES };
  scenarios = [
    await scenario(page, cdp, "short-history", SHORT_SEED, base),
    await scenario(page, cdp, "long-history", LONG_SEED, base),
    await scenario(page, cdp, "long+expanding-card", LONG_SEED, { ...base, toggleEveryFrames: TOGGLE_EVERY }),
  ];
  contract = await page.evaluate(() => window.ompPerf.cardTransition());
  console.log(`tool-card transition-property  streaming: [${contract.streaming}]  idle: [${contract.idle}]`);
  switchContract = await page.evaluate(() => window.ompPerf.sessionSwitch());
  console.log(
    `session switch             settling=${switchContract.sawSettling}  opacity<=${switchContract.settlingMaxOpacity.toFixed(3)}  `
      + `first-tail-distance=${switchContract.firstVisibleDistanceFromTail?.toFixed(1) ?? "n/a"}px  `
      + `visible-jumps=${switchContract.visiblePositionJumps}  max-shift=${switchContract.maxVisibleShiftPx.toFixed(1)}px`,
  );
} catch (issue) {
  error = issue instanceof Error ? issue.message : String(issue);
} finally {
  await browser.close();
  await started.server.close();
}

const byName = Object.fromEntries(scenarios.map((entry) => [entry.name, entry]));
const short = byName["short-history"];
const long = byName["long-history"];
const busy = byName["long+expanding-card"];
const checks = [];
if (error === null && short !== undefined && long !== undefined && busy !== undefined && contract !== null && switchContract !== null) {
  /* 布局时间是连续量，不像帧间隔那样被 vsync 台阶饱和，所以历史无关性拿它来判。 */
  checks.push(check(
    "layout-cost-independent-of-history",
    long.layoutMsPerFrame / Math.max(short.layoutMsPerFrame, 0.02),
    HISTORY_RATIO,
    "长历史 + 长工具输出下的单帧布局时间 / 短历史下的单帧布局时间",
  ));
  checks.push(assert(
    "height-transition-kept-while-streaming",
    contract.streaming.includes("grid-template-rows"),
    `流式态 transition-property = [${contract.streaming}]，工具卡收起/展开动画在流式期间必须保留（只按卡片是否运行取舍，见 BatchChain）`,
  ));
  checks.push(assert(
    "height-transition-kept-when-idle",
    contract.idle.includes("grid-template-rows"),
    `静止态 transition-property = [${contract.idle}]，展开动画本身必须还在`,
  ));
  checks.push(check("busy-p95-frame-interval-ms", busy.p95, FRAME_CEILING_MS, "崩溃级兜底"));
  checks.push(check("busy-stall-ratio", busy.stalls / Math.max(busy.frames, 1), STALL_RATIO, "间隔 >48ms 的帧占比；崩溃级兜底"));
  checks.push(assert("expand-scenario-actually-ran", busy.toggles > 0, `折叠/展开 ${busy.toggles} 次`));
  checks.push(assert(
    "incoming-session-held-until-old-content-left",
    switchContract.newContentMountedDuringLeave === false,
    "leaving 阶段不能把旧 transcript DOM 换成新会话",
  ));
  checks.push(assert(
    "incoming-session-settles-before-reveal",
    switchContract.sawSettling === true && switchContract.settlingMaxOpacity <= 0.01,
    `稳定阶段 opacity 最大 ${switchContract.settlingMaxOpacity.toFixed(3)}`,
  ));
  checks.push(check(
    "incoming-session-first-visible-tail-distance-px",
    switchContract.firstVisibleDistanceFromTail ?? Number.POSITIVE_INFINITY,
    1,
    "新正文第一次可见前已经贴底",
  ));
  checks.push(check(
    "incoming-session-visible-position-jumps",
    switchContract.visiblePositionJumps,
    0,
    `淡入后最大位移 ${switchContract.maxVisibleShiftPx.toFixed(1)}px`,
  ));
}

const failed = error !== null || checks.length === 0 || checks.some((entry) => entry.status === "failed");
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(
  reportPath,
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    frames: FRAMES,
    budgets: { HISTORY_RATIO, FRAME_CEILING_MS, STALL_RATIO },
    scenarios,
    ...(contract === null ? {} : { toolCardTransition: contract }),
    ...(switchContract === null ? {} : { sessionSwitch: switchContract }),
    checks,
    ...(error === null ? {} : { error }),
    status: failed ? "failed" : "passed",
  }, null, 2)}\n`,
  "utf8",
);
console.log(`streaming perf report: ${reportPath}`);
if (error !== null) console.error(error);
if (failed) process.exitCode = 1;
