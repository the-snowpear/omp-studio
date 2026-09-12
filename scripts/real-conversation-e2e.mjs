import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("..", import.meta.url));
const timeoutMs = Number(process.env.OMP_E2E_TIMEOUT_MS ?? 180000);
const require = createRequire(import.meta.url);
const report = { status: "running", checks: [], modelCalls: "at most two foreground prompts", preview: false };
let electronApp;
let page;
let outputDirectory;
let configurationBefore;

async function configurationDigests() {
  const directories = [...new Set([process.env.PI_CODING_AGENT_DIR, join(homedir(), ".omp"), join(homedir(), ".omp/agent")].filter(Boolean))];
  const digests = [];
  for (const directory of directories) for (const name of ["config.yml", "models.yml"]) {
    const file = join(directory, name);
    try {
      digests.push([file, createHash("sha256").update(await readFile(file)).digest("hex")]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return JSON.stringify(digests);
}

async function query(name, input = {}) {
  const response = await page.evaluate(async ({ name, input }) => window.ompStudio.query({ queryName: name, input }), { name, input });
  if (!response.ok) throw new Error(response.error.code + ": " + response.error.message);
  return response.result;
}

async function waitUntil(read, accept, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(label + " timed out" + (lastError ? ": " + lastError.message : ""));
}

async function command(name, input = {}) {
  return page.evaluate(async ({ name, input }) => window.ompStudio.command({
    commandName: name,
    input,
    requestId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  }), { name, input });
}

async function capture(name) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(outputDirectory, name + ".png"), fullPage: false });
  }
}

async function main() {
  if (process.env.OMP_E2E_ALLOW_MODEL !== "1") {
    report.status = "not-run";
    report.reason = "Set OMP_E2E_ALLOW_MODEL=1 to authorize isolated real-provider smoke tests.";
    process.exitCode = 2;
    return;
  }
  const playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  configurationBefore = await configurationDigests();
  const upstream = JSON.parse(await readFile(join(root, "omp-patch/upstream.json"), "utf8"));
  const series = JSON.parse(await readFile(join(root, "omp-patch/patches/series.json"), "utf8"));
  const upstreamPackage = JSON.parse(await readFile(join(root, "omp-patch/vendor/oh-my-pi/packages/coding-agent/package.json"), "utf8"));
  const runtimeVersion = upstreamPackage.version + "-" + series.patchsetVersion;
  const artifactDirectory = resolve(process.env.OMP_ARTIFACT_DIR ?? join(root, "packages/runtime-installer/dist/artifacts", "win32-" + process.arch, runtimeVersion));
  const manifest = JSON.parse(await readFile(join(artifactDirectory, "runtime-manifest.json"), "utf8"));
  if (manifest.runtimeVersion !== runtimeVersion || manifest.upstreamCommit !== upstream.commit) throw new Error("E2E artifact does not match the pinned source");
  const originalAppData = process.env.APPDATA ?? join(homedir(), "AppData/Roaming");
  const keyDirectory = join(originalAppData, "omp-studio/keys");
  const publicKeyPath = process.env.OMP_RUNTIME_TRUSTED_PUBLIC_KEY ?? join(keyDirectory, "trusted-public.pem");
  const keyId = process.env.OMP_RUNTIME_SIGNING_KEY_ID ?? (await readFile(join(keyDirectory, "key-id.txt"), "utf8")).trim();
  await access(publicKeyPath);
  const tempRoot = await mkdtemp(join(tmpdir(), "omp-studio-real-gui-"));
  const workspace = join(tempRoot, "workspace");
  const roaming = join(tempRoot, "roaming");
  const userData = join(tempRoot, "user-data");
  outputDirectory = resolve(process.env.OMP_E2E_OUTPUT_DIR ?? join(tempRoot, "evidence"));
  await Promise.all([workspace, roaming, userData, outputDirectory, join(tempRoot, "local")].map(directory => mkdir(directory, { recursive: true })));
  const proof = "read-proof-" + randomUUID();
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "omp-studio-smoke", private: true, version: "0.0.0", description: proof }, null, 2));
  await writeFile(join(workspace, "AGENTS.md"), "This is an isolated verification workspace. Read-only tasks only. Do not modify files, spawn agents, or access any other project.\n");
  const desktopRoot = join(root, "apps/desktop");
  const desktopEntry = join(desktopRoot, "dist/src/main.js");
  await access(desktopEntry);
  await access(join(desktopRoot, "dist/preload.cjs"));
  const appPackage = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
  const bootstrap = join(tempRoot, "bootstrap.cjs");
  const bootstrapSource = [
    "const { app, dialog } = require('electron');",
    "app.getAppPath = () => " + JSON.stringify(desktopRoot) + ";",
    "app.setPath('appData', " + JSON.stringify(roaming) + ");",
    "app.setPath('userData', " + JSON.stringify(userData) + ");",
    "dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [" + JSON.stringify(workspace) + "] });",
    "import(" + JSON.stringify(pathToFileURL(desktopEntry).href) + ").catch(error => { console.error(error.message); app.exit(1); });",
  ].join("\n");
  await writeFile(bootstrap, bootstrapSource);
  await writeFile(join(tempRoot, "package.json"), JSON.stringify({ name: "omp-studio-smoke", version: appPackage.version, main: "bootstrap.cjs" }));
  const env = {
    ...process.env,
    APPDATA: roaming,
    LOCALAPPDATA: join(tempRoot, "local"),
    OMP_ARTIFACT_DIR: artifactDirectory,
    OMP_RUNTIME_TRUSTED_PUBLIC_KEY: publicKeyPath,
    OMP_RUNTIME_SIGNING_KEY_ID: keyId,
    DO_NOT_TRACK: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OMP_RUNTIME_SIGNING_PRIVATE_KEY;
  delete env.OMP_RENDERER_DEV_URL;
  electronApp = await playwright._electron.launch({
    executablePath: join(root, "node_modules/electron/dist/electron.exe"),
    args: [tempRoot, "--user-data-dir=" + userData],
    cwd: workspace,
    env,
    timeout: 60000,
  });
  page = await electronApp.firstWindow();
  page.setDefaultTimeout(30000);
  await page.waitForFunction(() => typeof window.ompStudio?.query === "function");
  await page.evaluate(() => {
    localStorage.setItem("omp.previewMode", "0");
    localStorage.setItem("omp.startupNotice.dismissed", "incomplete-v1");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.ompStudio?.query === "function");
  const home = page.locator('nav.page-nav a[data-nav="home"]');
  if (await home.count()) await home.click();
  await page.getByRole("button", { name: /打开本地文件夹|Open local folder/i }).first().click();
  const projects = await waitUntil(() => query("projects.list"), result => result.workspaces.some(entry => entry.active), "Workspace activation");
  await command("session.create");
  const connected = await waitUntil(() => query("environment.get"), result => result.runtime.status === "connected", "Managed Runtime connection");
  if (connected.runtime.classification !== "managed" || connected.runtime.runtimeVersion !== runtimeVersion || connected.runtime.upstreamCommit !== upstream.commit) throw new Error("GUI connected to an unexpected Runtime");
  report.runtimeVersion = runtimeVersion;
  report.upstreamCommit = upstream.commit;
  report.workspace = workspace;
  report.userData = userData;
  report.checks.push("isolated profile and signed managed Runtime identity");
  await page.waitForSelector('.composer-region [contenteditable="true"]');
  const editor = page.locator('.composer-region [contenteditable="true"]').first();
  await editor.fill("Read package.json with the available file-reading tools. Reply with STUDIO_E2E_OK followed by its description value exactly. Do not write files, spawn agents, or access other projects.");
  await editor.press("Enter");
  const transcript = await waitUntil(() => query("session.transcript.read"), result => result.items.some(item =>
    item.kind === "message" && item.role === "assistant" && item.content.some(block => block.type === "text" && block.text.includes("STUDIO_E2E_OK") && block.text.includes(proof))
  ), "Real file read and assistant response");
  const session = await query("session.state");
  await waitUntil(() => query("session.state"), result => !result.isStreaming && !result.isCompacting, "First turn completion");
  report.sessionId = session.sessionId;
  report.assistantItems = transcript.items.filter(item => item.kind === "message" && item.role === "assistant").length;
  report.model = session.model;
  await page.locator(".ev-assistant").filter({ hasText: proof }).first().waitFor();
  report.checks.push("real provider response proves reading an unpredictable workspace file");
  await capture("real-conversation");
  await command("loop.enable", { limit: { turns: 1 } });
  await waitUntil(() => query("session.state"), result => result.loop?.status === "waiting", "Loop preparation", 30000);
  await editor.fill("Explain the small package in 1000 numbered sentences. Do not use tools or modify files.");
  await editor.press("Enter");
  await waitUntil(() => query("session.state"), result => result.isStreaming, "Second turn start", 30000);
  await command("core.abort");
  await waitUntil(() => query("session.state"), result => !result.isStreaming && !result.isCompacting && result.retry === undefined, "Abort completion", 30000);
  await new Promise(resolveWait => setTimeout(resolveWait, 1200));
  const cancelled = await query("session.state");
  if (cancelled.loop?.status !== "paused" || cancelled.isStreaming) throw new Error("An aborted prompt reactivated the loop");
  report.checks.push("active turn cancellation cannot reactivate a paused loop");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.ompStudio?.query === "function");
  const restored = await waitUntil(() => query("session.state"), result => result.sessionId === session.sessionId, "Reload session recovery");
  if (restored.runtimeEpoch !== session.runtimeEpoch) throw new Error("Reload replaced rather than reattached the Runtime");
  const replay = await query("session.transcript.read");
  if (!replay.items.some(item => item.kind === "message" && item.role === "assistant" && item.content.some(block => block.type === "text" && block.text.includes(proof)))) throw new Error("Reload lost the completed assistant response");
  await page.locator(".ev-assistant").filter({ hasText: proof }).first().waitFor();
  await page.getByText("workspace", { exact: true }).first().waitFor();
  report.checks.push("reload retains the session epoch and completed transcript");
  const history = await query("history.list", { limit: 100, workspaceId: projects.workspaces.find(entry => entry.active).workspaceId });
  if (!history.entries.some(entry => entry.sessionId === session.sessionId)) throw new Error("Completed session is missing from history");
  report.checks.push("completed session is discoverable in persisted history");
  await capture("recovered-conversation");
  await command("loop.disable");
  report.status = "passed";
}

try {
  await main();
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
  process.exitCode = 1;
  if (page && !page.isClosed()) {
    report.runtimeAtFailure = await query("environment.get").then(result => result.runtime).catch(() => undefined);
    await capture("failure").catch(() => {});
    await command("core.abort").catch(() => {});
  }
} finally {
  if (electronApp) {
    await electronApp.close().catch(async () => {
      await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => {});
    });
  }
  if (configurationBefore !== undefined) {
    report.configurationUnchanged = configurationBefore === await configurationDigests();
    if (!report.configurationUnchanged) {
      report.status = "failed";
      report.error = "Existing config/models files changed during verification; no files were restored automatically.";
      process.exitCode = 1;
    }
  }
  if (outputDirectory) await writeFile(join(outputDirectory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
