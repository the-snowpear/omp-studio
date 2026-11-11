// No-model UI acceptance on the real Electron app, with isolated user and Host data.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadPlaywright, prepareIsolatedDirs, hookEnv, APP_DIR, ELECTRON_EXE, REPO_ROOT } from "./perf-audit/lib/collect.mjs";

const output = resolve(REPO_ROOT, "output/playwright/review-data/gui-after");
await mkdir(output, { recursive: true });
const dirs = prepareIsolatedDirs("review-gui-after", { fresh: true });
const home = join(dirs.root, "home"); await mkdir(home, { recursive: true });
const roaming = join(home, "AppData/Roaming"), local = join(home, "AppData/Local");
await Promise.all([roaming, local, join(home, "Downloads")].map(path => mkdir(path, { recursive: true })));
const env = hookEnv(dirs, { HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local, PI_CODING_AGENT_DIR: join(home, ".omp/agent"), DO_NOT_TRACK: "1" });
for (const key of ["ELECTRON_RUN_AS_NODE", "OMP_ARTIFACT_DIR", "OMP_RUNTIME_SIGNING_KEY", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[key];
const { _electron } = await loadPlaywright();
const report = { modelCalls: 0, checks: [], errors: [], screenshots: [] };
let app, page;
try {
  app = await _electron.launch({ executablePath: ELECTRON_EXE, args: [APP_DIR, `--user-data-dir=${dirs.userData}`], cwd: REPO_ROOT, env, timeout: 30000 });
  app.process().stderr?.on("data", chunk => process.stderr.write(chunk));
  page = await app.firstWindow();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.waitForLoadState("load");
  await page.addInitScript(() => {
    localStorage.setItem("omp.onboarding.completed", "workbench-0.2.0");
    localStorage.setItem("omp.startupNotice.dismissed", "incomplete-v1");
  });
  const base = new URL(page.url());
  for (const preview of [false, true]) {
    const url = new URL(base); url.search = preview ? "?preview=1&marks=off" : "";
    await page.evaluate(mode => {
      localStorage.setItem("omp.previewMode", mode ? "1" : "0");
      localStorage.setItem("omp.lastRoute", "home");
    }, preview);
    await page.goto(url.href);
    await page.waitForLoadState("load");
    await page.waitForSelector(".app-rail");
    const dialog = page.getByRole("dialog");
    if (await dialog.count()) {
      for (let step = 0; step < 8; step++) {
        const next = dialog.getByRole("button", { name: /下一步|Next/ });
        if (await next.count()) await next.first().click();
      }
      const close = dialog.getByRole("button", { name: /关闭|完成|Close|Finish/ });
      if (await close.count()) await close.first().click();
    }
    for (const route of ["home", "history", "settings", "workbench"]) {
      const nav = page.locator(`.app-rail [data-route="${route}"]`);
      await nav.click();
      await page.waitForTimeout(500);
      const active = await nav.getAttribute("class");
      if (!active?.includes("active")) throw new Error(`Route did not activate: ${route}`);
      const name = `${preview ? "preview" : "real"}-${route}`;
      await page.screenshot({ path: join(output, `${name}.png`) });
      report.screenshots.push(name);
      report.checks.push({ preview, route, active: true });
    }
  }
  report.electron = await app.evaluate(() => process.versions.electron);
  if (report.errors.length) throw new Error(report.errors.join("\n"));
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.failure = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, "failure.png") });
    report.failureView = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 5000) }));
  }
}
finally { await app?.close(); }
const path = join(output, "report.json"); await writeFile(path, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ path, ...report }, null, 2));
