/** Installed Linux acceptance. Real Runtime, tools and PTY; a local model endpoint incurs no API charges. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const executable = process.env.OMP_E2E_PACKAGED_EXE;
if (process.platform !== "linux" || !executable) throw new Error("Set OMP_E2E_PACKAGED_EXE to a packaged Linux executable or AppImage");
const output = resolve(process.env.OMP_E2E_OUTPUT_DIR ?? "outputs/linux-package-smoke");
const profile = await mkdtemp("/tmp/omp-linux-smoke-");
const home = join(profile, "home"), workspace = join(profile, "workspace"), agentDir = join(home, ".omp/agent");
const proof = `linux-package-${randomUUID()}`;
const report = { status: "running", executable, packageRun: process.env.OMP_E2E_PACKAGE_RUN, sandboxSetup: process.env.OMP_E2E_SANDBOX_SETUP, display: process.env.OMP_E2E_DISPLAY ?? "x11", model: "local deterministic OpenAI-compatible endpoint", checks: [], profile };
let application, page, providerCalls = 0, toolRequests = 0, readResultReplies = 0;

const provider = createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    providerCalls += 1;
    const toolReply = body.messages.find(message => message.role === "tool" && JSON.stringify(message.content).includes(proof));
    const lastUser = JSON.stringify(body.messages.findLast(message => message.role === "user")?.content ?? "");
    const conversation = !lastUser.includes("<title-request>") && Boolean(toolReply || body.tools?.some(tool => tool.function?.name === "read"));
    // Titles and cache warming also contact the provider; the assertion below
    // follows the actual tool result and persisted reply, not a request count.
    if (conversation) toolRequests += 1;
    if (toolReply) readResultReplies += 1;
    report.providerRequests ??= [];
    if (report.providerRequests.length < 8) report.providerRequests.push({ tools: Boolean(body.tools?.length), toolChoice: body.tool_choice, toolReply: Boolean(toolReply), lastUser: lastUser.slice(0, 200) });
    const delta = !conversation ? { content: "Linux package acceptance" } : toolReply ? { content: `OMP_LINUX_OK ${proof}` } : {
      tool_calls: [{ index: 0, id: "linux-smoke-read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }],
    };
    const finish = delta.tool_calls ? "tool_calls" : "stop";
    if (body.stream === false) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "linux-package-smoke", object: "chat.completion", created: 1, model: "smoke-model", choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const chunk = (change, finish_reason) => `data: ${JSON.stringify({ id: "linux-package-smoke", object: "chat.completion.chunk", created: 1, model: "smoke-model", choices: [{ index: 0, delta: change, finish_reason }] })}\n\n`;
    response.write(chunk({ role: "assistant", ...delta }, null));
    response.write(chunk({}, finish));
    response.end("data: [DONE]\n\n");
  } catch (error) {
    report.providerError = String(error);
    response.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: String(error) } }));
  }
});

async function query(name, input = {}) {
  const response = await page.evaluate(({ name, input }) => window.ompStudio.query({ queryName: name, input }), { name, input });
  if (!response.ok) throw new Error(`${name}: ${JSON.stringify(response.error)}`);
  return response.result;
}

async function command(name, input = {}) {
  return page.evaluate(({ name, input }) => new Promise((resolveCommand, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { off(); reject(new Error(`Command timed out: ${name}`)); }, 90_000);
    const off = window.ompStudio.subscribe({ scope: "command", requestId }, event => {
      if (event.kind !== "command.receipt" || !["completed", "failed", "rejected", "outcome_unknown"].includes(event.receipt.status)) return;
      clearTimeout(timer); off();
      if (event.receipt.status === "completed") resolveCommand(event.receipt.result);
      else reject(new Error(JSON.stringify(event.receipt)));
    });
    window.ompStudio.command({ commandName: name, input, requestId, idempotencyKey: requestId }).catch(error => { clearTimeout(timer); off(); reject(error); });
  }), { name, input });
}

async function until(read, accept, label) {
  const deadline = Date.now() + 90_000;
  let last;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value; last = value; } catch (error) { last = String(error); }
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

async function launch(env) {
  application = await _electron.launch({
    executablePath: executable,
    chromiumSandbox: true,
    args: [`--user-data-dir=${join(profile, "user-data")}`, `--ozone-platform=${report.display}`],
    cwd: workspace, env, timeout: 60_000,
  });
  for (const stream of [application.process().stdout, application.process().stderr]) stream?.on("data", data => { void appendFile(join(output, "electron.log"), data); });
  page = await application.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => Boolean(window.ompStudio));
  const identity = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, sandboxDisabled: app.commandLine.hasSwitch("no-sandbox"), version: app.getVersion() }));
  assert.equal(identity.packaged, true);
  assert.equal(identity.sandboxDisabled, false);
  const locations = await application.evaluate(() => ({ home: process.env.HOME, configHome: process.env.XDG_CONFIG_HOME }));
  report.logDirectory = join(locations.configHome || join(locations.home, ".config"), "omp-studio/logs");
  await application.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, workspace);
  return identity;
}

try {
  await Promise.all([output, home, workspace, agentDir, join(home, "bin"), join(profile, "config/omp-studio")].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(workspace, "fixture.txt"), proof);
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-qm", "Linux acceptance fixture"]]) execFileSync("git", ["-c", "user.name=Studio Acceptance", "-c", "user.email=acceptance@example.test", ...args], { cwd: workspace, stdio: "pipe" });
  await writeFile(join(home, ".bash_profile"), 'export OMP_LINUX_LOGIN_PROBE=resolved\nexport PATH="$HOME/bin:$PATH"\n');
  await writeFile(join(home, "bin/omp-linux-probe"), "#!/bin/sh\nprintf 'OMP_LINUX_TOOL_OK\\n'\n");
  await chmod(join(home, "bin/omp-linux-probe"), 0o755);
  await writeFile(join(profile, "config/omp-studio/update-prefs.json"), JSON.stringify({ autoCheck: false, autoDownload: false }));
  await new Promise(done => provider.listen(0, "127.0.0.1", done));
  await writeFile(join(agentDir, "models.yml"), JSON.stringify({ providers: { "linux-smoke": {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "local-fixture",
    models: [{ id: "smoke-model", name: "Linux package smoke", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const env = { ...process.env, HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/bash", XDG_CONFIG_HOME: join(profile, "config"), XDG_DATA_HOME: join(profile, "data"), XDG_CACHE_HOME: join(profile, "cache"), XDG_STATE_HOME: join(profile, "state"), PI_CODING_AGENT_DIR: agentDir, DO_NOT_TRACK: "1" };
  for (const name of ["ELECTRON_RUN_AS_NODE", "OMP_ARTIFACT_DIR", "OMP_RENDERER_DEV_URL", "OMP_SIGNING_SECRET", "OMP_RUNTIME_SIGNING_KEY", "OMP_RUNTIME_SIGNING_KEY_ID", "OMP_RUNTIME_TRUSTED_PUBLIC_KEY", "GH_TOKEN", "GITHUB_TOKEN", "TERM", "TERM_PROGRAM"]) delete env[name];
  report.app = await launch(env);
  await page.evaluate(() => { localStorage.setItem("omp.previewMode", "0"); localStorage.setItem("omp.appSettings", JSON.stringify({ language: "zh" })); localStorage.setItem("omp.startupNotice.dismissed", "incomplete-v1"); });
  await page.reload();
  const tour = page.locator(".ob-dialog");
  await tour.waitFor({ state: "visible" });
  const steps = await tour.getByRole("tab").count();
  for (let step = 1; step < steps; step += 1) await tour.getByRole("button", { name: /^(下一步|Next)$/ }).click();
  await tour.getByRole("button", { name: /^(开始使用|Get started)$/ }).click();
  await tour.waitFor({ state: "hidden" });
  report.checks.push("first-run tutorial completes and releases the workspace controls");
  await page.getByRole("button", { name: /打开本地文件夹|Open local folder/ }).first().click();
  await until(() => query("projects.list"), result => result.workspaces.some(row => row.active), "workspace selection");
  await command("session.create", { model: "linux-smoke/smoke-model", noContextFiles: true });
  const environment = await until(() => query("environment.get"), result => result.runtime.status === "connected", "signed Runtime handshake");
  assert.equal(environment.runtime.classification, "managed");
  const series = JSON.parse(await readFile("omp-patch/patches/series.json", "utf8"));
  const upstream = JSON.parse(await readFile("omp-patch/vendor/oh-my-pi/packages/coding-agent/package.json", "utf8"));
  assert.equal(environment.runtime.runtimeVersion, `${upstream.version}-${series.patchsetVersion}`);
  assert.equal(await application.evaluate(() => process.env.OMP_LINUX_LOGIN_PROBE), "resolved");
  report.runtime = environment.runtime.runtimeVersion;
  report.checks.push("packaged Electron with sandbox enabled; bundled signed Runtime activates without development-tool PATH", "application-menu login environment discovers user tools");

  const terminalOutput = await page.evaluate(async () => {
    let text = "";
    const off = window.ompStudioTerminal.onData(event => { text += event.data; });
    const terminal = await window.ompStudioTerminal.create({ cols: 80, rows: 24 });
    try {
      await window.ompStudioTerminal.write(terminal.id, "[ -t 0 ] && [ -t 1 ] && printf 'OMP_TTY_%s\\n' OK; omp-linux-probe\r");
      const deadline = Date.now() + 15_000;
      while ((!text.includes("OMP_TTY_OK") || !text.includes("OMP_LINUX_TOOL_OK")) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
      return text;
    } finally { off(); await window.ompStudioTerminal.dispose(terminal.id); }
  });
  assert.ok(terminalOutput.includes("OMP_TTY_OK") && terminalOutput.includes("OMP_LINUX_TOOL_OK"), "Terminal must be a real PTY, with GUI login PATH");
  report.checks.push("native node-pty ABI, real tty input/output, user tool execution and terminal disposal");

  const editor = page.locator('.composer-region [contenteditable="true"]').first();
  await editor.fill("Read fixture.txt and reply with its exact content.");
  await editor.press("Enter");
  await until(() => query("session.transcript.read"), result => result.items.some(item => item.role === "assistant" && item.content?.some(block => block.type === "text" && block.text.includes(`OMP_LINUX_OK ${proof}`))), "conversation and native tool roundtrip");
  await until(() => query("session.state"), result => !result.isStreaming, "conversation completion");
  assert.ok(readResultReplies > 0, "The Runtime must return the unique file contents to the model endpoint");
  report.checks.push("real Runtime conversation through local model endpoint, native file read, streamed reply and persisted transcript");
  const session = await query("session.state");
  const prediction = (await command("prediction.prepare", { sessionId: session.sessionId, protocolVersion: 2 })).result;
  const attached = await page.evaluate(channel => window.ompStudioChrome.attachPrediction(channel), prediction);
  assert.ok(attached.ok, attached.message);
  const pinged = await page.evaluate(channelId => window.ompStudioChrome.predictionInput({ channelId, input: { kind: "ping" } }), prediction.channelId);
  assert.ok(pinged.ok, pinged.message);
  await page.evaluate(channelId => window.ompStudioChrome.detachPrediction({ channelId }), prediction.channelId);
  await command("prediction.release", { sessionId: session.sessionId, channelId: prediction.channelId });
  report.checks.push("v2 prediction channel metadata, authenticated private socket and input transport");
  await editor.fill("unsent ");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "中文输入", selectionStart: 4, selectionEnd: 4 });
  await cdp.send("Input.insertText", { text: "中文输入" });
  assert.ok((await editor.innerText()).includes("中文输入"));
  await editor.fill("");
  await application.evaluate(({ clipboard }) => { clipboard.writeText("OMP_LINUX_CLIPBOARD"); });
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), "OMP_LINUX_CLIPBOARD");
  report.checks.push("Chromium IME composition (physical input method excluded) and desktop clipboard");
  await page.screenshot({ path: join(output, "conversation.png") });
  await application.close(); application = undefined;

  await launch(env);
  await page.getByText(`OMP_LINUX_OK ${proof}`, { exact: true }).waitFor({ state: "visible" });
  await until(() => query("session.transcript.readPage", { sessionId: session.sessionId }), result => result.items.some(item => item.role === "assistant" && item.content?.some(block => block.type === "text" && block.text.includes(proof))), "persisted conversation");
  // Restored conversation views are deliberately dormant until the user sends
  // again or chooses Connect now; the authority's startup session is separate.
  await page.getByRole("button", { name: "立即连接", exact: true }).click();
  await until(() => query("residents.list"), result => result.residents.some(row => row.sessionId === session.sessionId), "restored conversation reconnects");
  const restoredEditor = page.locator('.composer-region [contenteditable="true"]').first();
  await restoredEditor.fill("Confirm this conversation survived a restart.");
  await restoredEditor.press("Enter");
  await until(() => query("session.transcript.readPage", { sessionId: session.sessionId }), result => result.items.filter(item => item.role === "assistant" && item.content?.some(block => block.type === "text" && block.text.includes(`OMP_LINUX_OK ${proof}`))).length >= 2, "resumed conversation completes a second reply");
  await page.getByText("正在同步", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.locator(".cm-prediction-error").count(), 0, "The restored conversation must attach its prediction channel too");
  await page.screenshot({ path: join(output, "restarted.png") });
  report.checks.push("workspace and conversation restore after restart; the dormant session reconnects and completes a second reply with prediction available");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
    report.runtimeAtFailure = await query("environment.get").catch(() => undefined);
  }
} finally {
  if (application) await application.close().catch(() => application.process().kill("SIGKILL"));
  provider.closeAllConnections();
  await new Promise(done => provider.close(done));
  report.providerCalls = providerCalls;
  report.toolRequests = toolRequests;
  report.readResultReplies = readResultReplies;
  if (report.logDirectory) await cp(report.logDirectory, join(output, "host-logs"), { recursive: true }).catch(error => { report.logCopyError = String(error); });
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
