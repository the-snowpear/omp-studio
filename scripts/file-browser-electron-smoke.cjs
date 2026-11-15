/** Run after check --only production. Uses the built renderer; --url selects a dev server. No model requests. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { basename, dirname, join, resolve, relative, isAbsolute } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = resolve(__dirname, "..");
const output = join(root, "output", "playwright", "electron-file-browser");
const arg = process.argv.indexOf("--url");
const url = arg < 0 ? undefined : process.argv[arg + 1];
const report = { checks: [], errors: [], modelCalls: 0 };
let application, page;
const execute = promisify(execFile);
const modifier = process.platform === "darwin" ? "Meta" : "Control";

async function openBrowser() {
  await page.keyboard.press(`${modifier}+k`);
  await page.locator(".cmdk-input input").fill("打开文件浏览器");
  await page.locator(".cmdk-list").getByText("打开文件浏览器", { exact: true }).click();
  const browser = page.locator(".fb:visible").last();
  await browser.locator(".fb-crumb.is-current").waitFor();
  return browser;
}
async function navigateBrowser(browser, path) {
  await browser.locator(".fb-crumb.is-current").click();
  const input = browser.getByRole("textbox", { name: "路径", exact: true });
  await input.fill(path);
  await input.press("Enter");
}
const browserRow = (browser, name) => browser.locator("[data-path]").filter({ has: page.getByText(name, { exact: true }) });

async function query(name, input = {}) {
  const response = await page.evaluate(({ name, input }) => window.ompStudio.query({ queryName: name, input }), { name, input });
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.result;
}
async function command(name, input) {
  return page.evaluate(({ name, input }) => new Promise((resolveCommand, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => { off(); reject(new Error(`No receipt: ${name}`)); }, 30000);
    const off = window.ompStudio.subscribe({ scope: "command", requestId }, event => {
      if (event.kind !== "command.receipt") return;
      clearTimeout(timeout); off();
      if (event.receipt.status === "completed") resolveCommand(event.receipt.result);
      else reject(new Error(JSON.stringify(event.receipt)));
    });
    window.ompStudio.command({ commandName: name, input, requestId, idempotencyKey: requestId }).catch(error => { clearTimeout(timeout); off(); reject(error); });
  }), { name, input });
}
async function run() {
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(join(tmpdir(), "omp-file-browser-e2e-"));
  const home = join(temp, "home"), workspace = join(temp, "workspace"), roaming = join(temp, "roaming");
  const outside = join(home, ".omp", "external.txt"), image = join(home, ".omp", "preview.svg");
  report.profile = temp;
  const projectFolder = join(home, "adopt-me");
  for (const path of [workspace, projectFolder, join(workspace, "src"), roaming, join(temp, "user-data"), join(temp, "local"), join(home, ".omp"), ...["Desktop", "Downloads", "Documents", "Pictures"].map(name => join(home, name))]) await fs.mkdir(path, { recursive: true });
  await fs.writeFile(join(workspace, "inside.txt"), "Project file\n");
  await fs.writeFile(join(workspace, "src", "linked.txt"), "Shared buffer\n");
  const git = args => execute("git", args, { cwd: workspace, windowsHide: true });
  await git(["init", "--initial-branch=main"]);
  await git(["add", "inside.txt", "src/linked.txt"]);
  await git(["-c", "user.name=File Browser Smoke", "-c", "user.email=file-browser@localhost", "commit", "-qm", "Fixture"]);
  await fs.writeFile(join(workspace, "inside.txt"), "Modified project file\n");
  await fs.writeFile(outside, Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("Outside project\r\n")]));
  await fs.writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="indigo"/></svg>');
  const scratchPath = path => { const suffix = relative(temp, resolve(path)); assert.ok(suffix && !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("..\\") && !suffix.startsWith("../")); return path; };
  const desktop = join(root, "apps", "desktop"), bootstrap = join(temp, "bootstrap.cjs");
  await fs.writeFile(bootstrap, [
    'const {app,dialog}=require("electron");',
    `app.getAppPath=()=>${JSON.stringify(desktop)};`,
    `app.setPath("appData",${JSON.stringify(roaming)});`,
    `app.setPath("userData",${JSON.stringify(join(temp, "user-data"))});`,
    `app.setPath("home",${JSON.stringify(home)});`,
    ...["desktop", "downloads", "documents", "pictures"].map(kind => `app.setPath(${JSON.stringify(kind)},${JSON.stringify(join(home, kind[0].toUpperCase() + kind.slice(1)))});`),
    `dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(workspace)}]});`,
    `import(${JSON.stringify(pathToFileURL(join(desktop, "dist", "src", "main.js")).href)});`,
  ].join("\n"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: join(temp, "local"), PI_CONFIG_DIR: join(temp, "native-config"), OMP_RENDERER_DEV_URL: url, DO_NOT_TRACK: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!url) delete env.OMP_RENDERER_DEV_URL;
  application = await _electron.launch({ executablePath: require("electron"), args: [bootstrap], cwd: workspace, env, timeout: 60000 });
  for (const stream of [application.process().stdout, application.process().stderr]) stream?.on("data", chunk => { void fs.appendFile(join(output, "electron.log"), chunk); });
  page = await application.firstWindow({ timeout: 30000 }); page.setDefaultTimeout(15000);
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
  await page.waitForFunction(() => !!window.ompStudio && !!window.ompStudioChrome?.files);
  const model = await command("workspace.openPath", { path: workspace });
  assert.ok(model.activeWorkspaceId);
  report.checks.push("workspace.openPath registers and activates a real folder");
  const places = await query("fs.places");
  assert.ok(places.quick.some(place => place.kind === "downloads" && place.path === join(home, "Downloads")));
  for (const volume of places.volumes.filter(volume => volume.ready && /^[CD]:/i.test(volume.path))) await query("fs.list", { path: volume.path });
  await query("fs.list", { path: places.home });
  report.checks.push("real disks, home, and redirected known folders");
  const original = await query("fs.file.readText", { path: outside });
  const saved = await command("fs.file.writeText", { path: outside, text: "Saved through Electron\n", expectedVersion: original.file.version, encoding: original.encoding, bom: original.bom, lineEnding: original.lineEnding });
  assert.equal(saved.saved, true);
  assert.equal((await fs.readFile(outside)).subarray(3).toString(), "Saved through Electron\r\n");
  const conflict = await command("fs.file.writeText", { path: outside, text: "stale", expectedVersion: original.file.version, encoding: original.encoding, bom: original.bom, lineEnding: original.lineEnding });
  assert.equal(conflict.saved, false);
  report.checks.push("system file saves preserve BOM/CRLF and detect stale versions");
  const folder = await command("fs.directory.create", { parent: home, name: "file-browser-recycle-test" });
  await assert.rejects(command("fs.rename", { path: scratchPath(folder.path), name: "Downloads" }), /已存在/);
  const renamed = await command("fs.rename", { path: scratchPath(folder.path), name: "file-browser-recycled" });
  await command("fs.trash", { paths: [scratchPath(renamed.path)] });
  await assert.rejects(fs.access(renamed.path), { code: "ENOENT" });
  report.checks.push("new folder, no-overwrite rename, and the real Electron recycle bin");
  const media = await page.evaluate(async path => {
    const api = window.ompStudioChrome.files, resource = await api.open({ targetId: null, workspaceId: "", path, source: "system" });
    try { const response = await fetch(resource.url, { headers: { Range: "bytes=0-3" } }); return { status: response.status, text: await response.text() }; }
    finally { await api.release(resource.id); }
  }, image);
  assert.deepEqual(media, { status: 206, text: "<svg" });
  report.checks.push("sandboxed omp-file system resources support HTTP ranges");
  const onboarding = await fs.readFile(join(root, "apps/renderer/src/onboarding/onboardingState.ts"), "utf8");
  const tour = /ONBOARDING_TOUR_ID\s*=\s*"([^"]+)"/.exec(onboarding)?.[1];
  await page.evaluate(tour => {
    localStorage.setItem("omp.appSettings", JSON.stringify({ language: "zh" }));
    localStorage.setItem("omp.previewMode", "0"); localStorage.setItem("omp.lastRoute", "workbench");
    localStorage.setItem("omp.startupNotice.dismissed", "incomplete-v1");
    if (tour) localStorage.setItem("omp.onboarding.completed", tour);
  }, tour);
  await page.reload();
  await page.locator(".app-shell").waitFor();
  let browser = await openBrowser();
  await navigateBrowser(browser, "~/.omp");
  const fileRow = browserRow(browser, "external.txt");
  await fileRow.dblclick();
  const filePane = page.locator(".file-pane").last();
  await filePane.getByText("项目外", { exact: true }).waitFor();
  const editor = filePane.locator('.cm-content[contenteditable="true"]');
  await editor.fill("Saved from the file window\n");
  await editor.press(`${modifier}+s`);
  await page.waitForFunction(() => !document.querySelector(".file-pane .file-dirty-dot"));
  assert.equal((await fs.readFile(outside)).subarray(3).toString(), "Saved from the file window\r\n");
  await page.screenshot({ path: join(output, "editor.png") });
  report.checks.push("command palette → real file browser → outside-project editor → save");

  browser = await openBrowser();
  await fileRow.click();
  await page.keyboard.press(`${modifier}+Shift+n`);
  const realFolderName = browser.getByRole("textbox", { name: "新文件夹名称", exact: true });
  await realFolderName.fill("Managed from browser"); await realFolderName.press("Enter");
  await browserRow(browser, "Managed from browser").click();
  await page.keyboard.press("F2");
  const realRename = browser.getByRole("textbox", { name: "新名称", exact: true });
  await realRename.fill("Renamed from browser"); await realRename.press("Enter");
  await browserRow(browser, "Renamed from browser").click();
  const recycledFromBrowser = join(home, ".omp", "Renamed from browser");
  assert.ok((await fs.stat(recycledFromBrowser)).isDirectory());
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  await fs.access(recycledFromBrowser);
  await browserRow(browser, "Renamed from browser").click();
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "移到回收站", exact: true }).click();
  await browserRow(browser, "Renamed from browser").waitFor({ state: "detached" });
  await assert.rejects(fs.access(recycledFromBrowser), { code: "ENOENT" });
  if (process.platform === "win32") {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$items = (New-Object -ComObject Shell.Application).NameSpace(10).Items(); @($items | Where-Object { $_.Name -eq $env:OMP_RECYCLE_NAME -and $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq $env:OMP_RECYCLE_PARENT }).Count"], {
      windowsHide: true, env: { ...process.env, OMP_RECYCLE_NAME: basename(recycledFromBrowser), OMP_RECYCLE_PARENT: dirname(recycledFromBrowser) },
    });
    assert.equal(Number(stdout.trim()), 1);
  }
  report.checks.push("real UI create/rename/trash honors cancellation and reaches the system recycle bin");

  await browserRow(browser, "external.txt").click({ button: "right" });
  await page.getByRole("menuitem", { name: "添加到对话", exact: true }).click();
  await page.waitForFunction(path => [...document.querySelectorAll(".chip-composer .cm-chip")].some(chip => chip.title === path), outside);
  report.checks.push("outside-project context insertion keeps the absolute path");

  browser = await openBrowser();
  await navigateBrowser(browser, workspace);
  await browserRow(browser, "inside.txt").dblclick();
  const projectPane = page.getByRole("region", { name: "inside.txt", exact: true });
  await projectPane.locator(".cm-git-mark.is-modified").waitFor();
  assert.equal(await projectPane.getByText("项目外", { exact: true }).count(), 0);
  const projectEditor = projectPane.locator('.cm-content[contenteditable="true"]');
  await projectEditor.fill("Shared unsaved project buffer\n");
  await projectPane.locator(".file-dirty-dot").waitFor();
  browser = await openBrowser();
  await browserRow(browser, "inside.txt").click({ button: "right" });
  await page.getByRole("menuitem", { name: "在 Explorer 中定位", exact: true }).click();
  const explorerFile = page.locator('.tree-row[data-file="inside.txt"]:visible');
  await page.waitForFunction(() => [...document.querySelectorAll('.tree-row[data-file="inside.txt"]')].some(row => row.getAttribute("aria-selected") === "true"));
  await explorerFile.press("Enter");
  assert.equal(await page.getByRole("region", { name: "inside.txt", exact: true }).count(), 1);
  assert.equal((await projectEditor.innerText()).trimEnd(), "Shared unsaved project buffer");
  await projectEditor.press(`${modifier}+s`);
  await projectPane.locator(".file-dirty-dot").waitFor({ state: "detached" });
  assert.equal((await fs.readFile(join(workspace, "inside.txt"), "utf8")).replaceAll("\r\n", "\n"), "Shared unsaved project buffer\n");
  report.checks.push("project files keep Git markers and reuse the Explorer's unsaved buffer");

  await page.locator('.tree-row[data-dir="src"]:visible').click({ button: "right", position: { x: 16, y: 13 } });
  await page.getByRole("menuitem", { name: "在文件浏览器中显示", exact: true }).click();
  browser = page.locator(".fb:visible").last();
  await browserRow(browser, "linked.txt").waitFor();
  assert.equal(await browser.locator(".fb-crumb.is-current").innerText(), "src");
  report.checks.push("Explorer and file browser reveal each other's selected folder/file");

  await navigateBrowser(browser, projectFolder);
  await browser.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "设为项目并新建对话", exact: true }).click();
  await page.getByText("adopt-me", { exact: true }).first().waitFor();
  const projects = await query("projects.list");
  assert.ok(projects.workspaces.some(project => project.root === projectFolder));
  report.checks.push("a system folder opens as a registered project in a new chat");

  const previewUrl = new URL(page.url());
  previewUrl.searchParams.set("preview", "1"); previewUrl.searchParams.set("marks", "off");
  await page.goto(previewUrl.href);
  await page.locator(".app-shell").waitFor();
  browser = await openBrowser();
  await browser.getByRole("radio", { name: "列表视图", exact: true }).click();
  await browserRow(browser, "Desktop").waitFor();
  assert.equal(await browser.getByText("演示", { exact: true }).count(), 0);
  await browserRow(browser, "Desktop").click();
  await page.keyboard.press(`${modifier}+Shift+n`);
  const folderName = browser.getByRole("textbox", { name: "新文件夹名称", exact: true });
  await folderName.fill("Preview-only folder"); await folderName.press("Enter");
  await browserRow(browser, "Preview-only folder").waitFor();
  assert.equal(await browser.locator(".fb-notice").count(), 0);
  assert.equal(await browser.getByText("演示", { exact: true }).count(), 0);
  await page.screenshot({ path: join(output, "preview.png") });
  report.checks.push("preview=1&marks=off shows fixtures without demo markers or mutation notices");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.documentElement.matches('[data-perf-tier~="L1"]'));
  await browser.getByRole("radio", { name: "树视图", exact: true }).click();
  assert.equal(await browser.getAttribute("data-view"), "tree");
  assert.equal(await browser.locator(".fb-main").evaluate(element => getComputedStyle(element).transitionDuration), "0s");
  report.checks.push("reduced motion keeps navigation working with zero-duration transitions");
  assert.deepEqual(report.errors, []);
}

run().then(() => { report.ok = true; }).catch(async error => {
  report.ok = false; report.failure = error.stack || String(error); process.exitCode = 1;
  if (page) { await page.screenshot({ path: join(output, "failure.png") }).catch(() => {}); report.page = (await page.locator("body").innerText().catch(() => "")).slice(0, 14000); }
}).finally(async () => {
  if (application) await application.evaluate(({ app }) => app.exit()).catch(() => {});
  await fs.mkdir(output, { recursive: true }); await fs.writeFile(join(output, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
