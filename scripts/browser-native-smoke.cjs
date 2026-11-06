const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!process.versions.electron) {
  const { spawnSync } = require("node:child_process");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "omp-browser-native-"));
  for (const mode of [[], ["--restore"]]) {
    const result = spawnSync(require("electron"), [__filename, "--profile", profile, ...mode], { env: environment, stdio: "inherit", windowsHide: true, timeout: 120000 });
    if (result.error) console.error(result.error.message);
    console.log(`Native smoke process exit: status=${result.status}, signal=${result.signal}`);
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}

const { app, BrowserWindow, WebContentsView, View, dialog } = require("electron");
const { createServer } = require("node:http");
const profileIndex = process.argv.indexOf("--profile");
const temporary = profileIndex >= 0 ? process.argv[profileIndex + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "omp-browser-native-"));
app.setPath("userData", temporary);
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.on("window-all-closed", () => {});
const results = [];
const windows = [];
const contents = [];
const views = [];
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function settle(condition, description) {
  for (let attempt = 0; attempt < 160; attempt++) { if (await condition()) return; await wait(50); }
  assert.fail(description);
}
const record = (name, detail) => { results.push({ name, detail, passed: true }); console.log(`PASS ${name}: ${detail}`); };
let server;

async function run() {
  await app.whenReady();
  const recovery = process.argv.includes("--restore") ? JSON.parse(fs.readFileSync(path.join(temporary, "recovery.json"), "utf8")) : undefined;
  server = createServer((request, response) => {
    if (request.url === "/icon.svg") { response.writeHead(200, { "Content-Type": "image/svg+xml" }); response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#5c43cb"/></svg>'); return; }
    if (request.url === "/download") { response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=browser-test.txt" }); response.end("managed browser download"); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/frame") { response.end('<!doctype html><html><body><button id="frame-button" onclick="window.clicked=true">Frame action</button></body></html>'); return; }
    response.end(`<!doctype html><html><head><link rel="icon" href="/icon.svg"><style>body{background:#ecf1fa;font:18px sans-serif;padding:20px}input,button{font:inherit;margin:8px}#paint{width:160px;height:80px;background:#5c43cb}iframe{width:260px;height:100px}</style></head><body><h1>OMP native browser fixture</h1><input id="text"><button id="count" onclick="window.count++;this.textContent=window.count">0</button><div id="paint"></div><iframe id="same" src="/frame"></iframe><iframe id="cross" src="http://localhost:${server.address().port}/frame"></iframe><div id="shadow"></div><script>window.count=0;window.framesPainted=0;const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});shadow.innerHTML='<button id="shadow-button" onclick="window.shadowClicked=true">Shadow action</button>';function tick(){framesPainted++;requestAnimationFrame(tick)}tick();</script></body></html>`);
  });
  await new Promise(resolve => server.listen(recovery ? Number(new URL(recovery.url).port) : 0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  if (recovery) {
    const { DesktopManagedBrowser } = await import("../apps/desktop/dist/src/managed-browser.js");
    const main = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windows.push(main);
    const manager = new DesktopManagedBrowser({ directory: recovery.directory, downloadsDirectory: path.join(temporary, "recovery-downloads"), windowFor: () => main });
    try {
      await manager.ready;
      assert.equal(manager.contents(recovery.active), undefined);
      assert.equal(manager.contents(recovery.dormant), undefined);
      const restored = await manager.read("restore-chat");
      assert.equal(restored.activePageId, recovery.active);
      // Reading a chat never loads its pages; the tab shown on screen loads, the others stay dormant.
      assert.equal(manager.contents(recovery.active), undefined);
      await manager.present({ sessionId: "restore-chat", surfaceId: "restore", pageId: recovery.active, visible: true, bounds: { x: 0, y: 0, width: 640, height: 400 }, clip: { x: 0, y: 0, width: 640, height: 400 } });
      assert.equal(manager.contents(recovery.dormant), undefined);
      await settle(() => manager.store.page(recovery.active).status === "ready", "Active page did not restore after full Electron restart");
      const active = manager.contents(recovery.active);
      assert.equal(await active.executeJavaScript("document.cookie.includes('browser_login=retained')"), true);
      assert.equal(await active.executeJavaScript("document.querySelector('#text').value"), "");
      assert.equal(await active.executeJavaScript("typeof window.unsavedState"), "undefined");
      await manager.execute({ sessionId: "restore-chat", action: "select", pageId: recovery.dormant });
      await settle(() => manager.store.page(recovery.dormant).status === "ready", "Dormant page did not restore on selection");
      assert.equal(await manager.contents(recovery.dormant).executeJavaScript("document.cookie.includes('browser_login=retained')"), false);
      record("full application restart", "a fresh Electron process loads only the tab it shows, retains shared login, keeps isolated login separate and discards unsaved form/JS state");
      const output = path.resolve(__dirname, "../outputs/browser-native-smoke", `${process.platform}.json`);
      const report = JSON.parse(fs.readFileSync(output, "utf8")); report.results.push(...results); fs.writeFileSync(output, JSON.stringify(report, null, 2));
    } finally { await manager.dispose(); }
    return;
  }
  const main = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const floating = new BrowserWindow({ show: false, width: 820, height: 620, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  windows.push(main, floating);
  await Promise.all([main.loadURL("about:blank"), floating.loadURL("about:blank")]);
  main.showInactive();
  const page = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "persist:smoke-browser", backgroundThrottling: false } });
  contents.push(page.webContents);
  const clip = new View();
  clip.setBounds({ x: 40, y: 90, width: 700, height: 460 });
  page.setBounds({ x: 0, y: 0, width: 700, height: 460 });
  clip.addChildView(page);
  views.push({ page, clip, window: main });
  main.contentView.addChildView(clip);
  await page.webContents.loadURL(url);
  for (let attempt = 0; attempt < 40 && !(await page.webContents.executeJavaScript("innerWidth")); attempt++) await wait(25);
  await wait(100);
  page.webContents.debugger.attach("1.3");
  const initialCdp = await page.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", fromSurface: true });
  assert.ok(initialCdp.data.length > 100);
  page.webContents.debugger.detach();
  record("initial capture", "native page compositor is available");
  const identity = page.webContents.id;
  await page.webContents.executeJavaScript("document.querySelector('#text').value='中文表单';window.count=7;window.retained={value:42}");
  const before = await page.webContents.executeJavaScript("({text:document.querySelector('#text').value,count,retained:retained.value,history:history.length,width:innerWidth,height:innerHeight})");
  main.contentView.removeChildView(clip);
  floating.contentView.addChildView(clip);
  await wait(100);
  assert.equal(page.webContents.id, identity);
  assert.deepEqual(await page.webContents.executeJavaScript("({text:document.querySelector('#text').value,count,retained:retained.value,history:history.length,width:innerWidth,height:innerHeight})"), before);
  floating.contentView.removeChildView(clip);
  main.contentView.addChildView(clip);
  floating.destroy();
  await wait(250);
  assert.equal(await page.webContents.executeJavaScript("retained.value"), 42);
  record("page migration", "same webContents, form, JavaScript heap and navigation history survive window migration and old-window close");

  page.webContents.debugger.attach("1.3");
  const evaluate = async expression => (await page.webContents.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  assert.equal(await evaluate("document.querySelector('#text').value"), "中文表单");
  await page.webContents.debugger.sendCommand("Runtime.evaluate", { expression: "document.querySelector('#text').focus()" });
  await page.webContents.debugger.sendCommand("Input.insertText", { text: "与 Agent 同页" });
  assert.equal(await page.webContents.executeJavaScript("document.querySelector('#text').value"), "中文表单与 Agent 同页");
  record("shared CDP page", "CDP reads and edits the native page without a second browser");

  let nativeKeys = 0;
  let cdpKeys = 0;
  let phase = "native";
  const input = event => { if (phase === "native") nativeKeys++; else cdpKeys++; event.preventDefault(); };
  page.webContents.on("before-input-event", input);
  page.webContents.sendInputEvent({ type: "keyDown", keyCode: "A" });
  page.webContents.sendInputEvent({ type: "keyUp", keyCode: "A" });
  await wait(40);
  phase = "cdp";
  await page.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "b", code: "KeyB", text: "b", windowsVirtualKeyCode: 66 });
  await page.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "b", code: "KeyB", windowsVirtualKeyCode: 66 });
  page.webContents.removeListener("before-input-event", input);
  assert.ok(nativeKeys > 0);
  record("input routing probe", JSON.stringify({ nativeKeys, cdpKeys, requiresNativeShield: cdpKeys > 0 }));

  const firstPaint = await evaluate("framesPainted");
  await page.webContents.capturePage();
  clip.setVisible(false);
  await wait(180);
  const hiddenShot = await page.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true });
  assert.equal(hiddenShot.isEmpty(), false);
  assert.equal(hiddenShot.getSize().width, Math.round(700 * await evaluate("devicePixelRatio")));
  assert.ok(await evaluate("framesPainted") > firstPaint);
  clip.setVisible(true);
  record("hidden page", "background animation, CDP and native capture remain live while detached from display");

  let detached = false;
  page.webContents.debugger.once("detach", () => { detached = true; });
  page.webContents.debugger.detach();
  page.webContents.openDevTools({ mode: "detach", activate: false });
  for (let attempt = 0; attempt < 200 && !page.webContents.isDevToolsOpened(); attempt++) await wait(50);
  assert.equal(page.webContents.isDevToolsOpened(), true);
  page.webContents.closeDevTools();
  await wait(100);
  if (!page.webContents.debugger.isAttached()) page.webContents.debugger.attach("1.3");
  assert.equal(await evaluate("retained.value"), 42);
  record("DevTools handoff", `opened, closed and CDP available on same page; debugger detached=${detached}`);

  const { DesktopManagedBrowser } = await import("../apps/desktop/dist/src/managed-browser.js");
  const manager = new DesktopManagedBrowser({ directory: path.join(temporary, "managed"), downloadsDirectory: path.join(temporary, "downloads"), windowFor: () => main });
  try {
    const managed = await manager.create("native-chat", url, "human");
    const managedContents = manager.contents(managed.id);
    for (let attempt = 0; attempt < 60 && manager.store.page(managed.id).status !== "ready"; attempt++) await wait(50);
    await manager.present({ sessionId: "native-chat", surfaceId: "smoke", pageId: managed.id, visible: true, bounds: { x: 20, y: 20, width: 650, height: 420 }, clip: { x: 20, y: 20, width: 650, height: 420 } });
    assert.equal((await manager.capture(managed.id)).isEmpty(), false);
    const picked = [];
    const unsubscribe = manager.subscribe(event => { if (event.kind === "selection") picked.push(event.reference); });
    await manager.execute({ sessionId: "native-chat", action: "pick", pageId: managed.id });
    managedContents.debugger.attach("1.3");
    const button = await managedContents.executeJavaScript("(()=>{const rect=document.querySelector('#count').getBoundingClientRect();return {x:rect.x+5,y:rect.y+5}})()");
    await managedContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...button, button: "left", clickCount: 1 });
    await managedContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...button, button: "left", clickCount: 1 });
    for (let attempt = 0; attempt < 50 && !picked.length; attempt++) await wait(50);
    assert.equal(picked[0]?.selector, "#count");
    assert.ok(picked[0]?.screenshot?.data);
    assert.equal(await managedContents.executeJavaScript("count"), 0);
    await manager.execute({ sessionId: "native-chat", action: "stop-picking" });
    const pick = async expression => {
      const count = picked.length;
      await manager.execute({ sessionId: "native-chat", action: "pick", pageId: managed.id });
      const position = await managedContents.executeJavaScript(expression);
      if (!managedContents.debugger.isAttached()) managedContents.debugger.attach("1.3");
      await managedContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", clickCount: 1 });
      await managedContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", clickCount: 1 });
      await settle(() => picked.length > count, "Picker did not capture the selected element");
      await manager.execute({ sessionId: "native-chat", action: "stop-picking" });
      return picked.at(-1);
    };
    await settle(() => managedContents.executeJavaScript("!!document.querySelector('#same').contentDocument?.querySelector('#frame-button')"), "Same-origin frame did not load");
    const frame = await pick("(()=>{const frame=document.querySelector('#same');frame.scrollIntoView();const box=frame.getBoundingClientRect(),rect=frame.contentDocument.querySelector('#frame-button').getBoundingClientRect();return {x:box.x+frame.clientLeft+rect.x+5,y:box.y+frame.clientTop+rect.y+5}})()");
    assert.equal(frame.selector, "#same ::frame:: #frame-button");
    assert.equal(new URL(frame.frameUrl).pathname, "/frame");
    assert.ok(frame.screenshot.data);
    assert.equal(await managedContents.executeJavaScript("document.querySelector('#same').contentWindow.clicked === true"), false);
    const shadow = await pick("(()=>{const host=document.querySelector('#shadow');host.scrollIntoView();const rect=host.shadowRoot.querySelector('button').getBoundingClientRect();return {x:rect.x+5,y:rect.y+5}})()");
    assert.equal(shadow.selector, "#shadow >>> #shadow-button");
    assert.equal(await managedContents.executeJavaScript("window.shadowClicked === true"), false);
    const cross = await pick("(()=>{const frame=document.querySelector('#cross');frame.scrollIntoView();const rect=frame.getBoundingClientRect();return {x:rect.x+5,y:rect.y+5}})()");
    assert.equal(cross.selector, "#cross");
    assert.ok(cross.screenshot.data);
    let picking = false;
    const stopEvents = manager.subscribe(event => { if (event.kind === "picker") picking = event.active; });
    await manager.execute({ sessionId: "native-chat", action: "pick", pageId: managed.id });
    managedContents.focus();
    managedContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await settle(() => !picking, "Escape did not clear picker state");
    await manager.execute({ sessionId: "native-chat", action: "pick", pageId: managed.id });
    const priorDocument = manager.store.page(managed.id).documentId;
    await managedContents.loadURL(url);
    assert.equal(picking, false);
    assert.notEqual(manager.store.page(managed.id).documentId, priorDocument);
    stopEvents();
    record("picker boundaries", "same-origin frame and open Shadow DOM locators, whole cross-origin frame capture, Escape and navigation cancellation preserve the captured document identity");
    unsubscribe();
    await managedContents.executeJavaScript("(()=>{const link=document.createElement('a');link.href='/download';document.body.append(link);link.click()})()");
    for (let attempt = 0; attempt < 80 && manager.store.state("native-chat").downloads[0]?.state !== "completed"; attempt++) await wait(50);
    const download = manager.store.state("native-chat").downloads[0];
    assert.equal(download?.state, "completed");
    assert.equal(fs.readFileSync(download.path, "utf8"), "managed browser download");
    assert.equal(new URL(download.url).pathname, "/download");
    const shortcuts = [];
    const stopShortcuts = manager.subscribe(event => { if (event.kind === "shortcut") { assert.equal(event.pageId, managed.id); shortcuts.push(event.action); } });
    managedContents.focus();
    managedContents.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    await settle(() => shortcuts.includes("address"), "Address shortcut was not forwarded to the toolbar");
    managedContents.sendInputEvent({ type: "keyDown", keyCode: "F", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    await settle(() => shortcuts.includes("find"), "Find shortcut was not forwarded to the toolbar");
    stopShortcuts();
    await managedContents.executeJavaScript("void window.open('/popup', '_blank')");
    await settle(() => manager.pages("native-chat").length === 2, "Popup did not become a managed tab");
    const popup = manager.pages("native-chat").find(value => value.id !== managed.id);
    await settle(() => manager.store.page(popup.id).status === "ready", "Popup did not load");
    assert.equal(await manager.contents(popup.id).executeJavaScript("!!window.opener"), true);
    await manager.execute({ sessionId: "native-chat", action: "select", pageId: managed.id });
    await manager.execute({ sessionId: "native-chat", action: "close-others", pageId: managed.id });
    assert.deepEqual(manager.pages("native-chat").map(value => value.id), [managed.id]);
    assert.equal(manager.store.page(popup.id) ?? null, null);
    await settle(() => (manager.store.page(managed.id)?.favicon ?? "").startsWith("data:image/svg+xml;base64,"), "The site icon did not reach the tab");
    record("native tab interactions", "page-scoped address/find shortcuts, popup opener, Close Others and the site icon for the tab");
    const extra = await manager.create("native-chat", `${url}/?extra`, "human");
    await settle(() => manager.store.page(extra.id).status === "ready", "Extra tab did not load");
    await manager.execute({ sessionId: "native-chat", action: "return" });
    await manager.execute({ sessionId: "native-chat", action: "close-handoff", pageId: extra.id });
    assert.equal(manager.store.page(extra.id), undefined);
    assert.equal(manager.store.state("native-chat").control, "agent");
    await manager.execute({ sessionId: "native-chat", action: "take" });
    record("tab close handoff", "closing a tab under Agent control closes the page and hands control back to the Agent");
    await manager.execute({ sessionId: "native-chat", action: "return" });
    await assert.rejects(manager.execute({ sessionId: "native-chat", action: "navigate", pageId: managed.id, url }), /Take browser control/);
    await manager.execute({ sessionId: "native-chat", action: "take" });
    await manager.execute({ sessionId: "native-chat", action: "release" });
    assert.equal(manager.store.state("native-chat").pages[0].status, "released");
    await manager.present({ sessionId: "native-chat", surfaceId: "smoke", pageId: managed.id, visible: true, bounds: { x: 20, y: 20, width: 650, height: 420 }, clip: { x: 20, y: 20, width: 650, height: 420 } });
    assert.equal(manager.contents(managed.id), undefined);
    record("managed host", "element selection captures a real crop, native downloads complete, and release retains the tab record");
  } finally { await manager.dispose(); }

  const recoveryDirectory = path.join(temporary, "recovery-store");
  const recoveryManager = new DesktopManagedBrowser({ directory: recoveryDirectory, downloadsDirectory: path.join(temporary, "recovery-downloads"), windowFor: () => main });
  const originalDialog = dialog.showMessageBox;
  try {
    const shared = await recoveryManager.create("restore-chat", url, "human");
    await settle(() => shared.status === "ready", "Shared recovery page did not load");
    let prompts = 0;
    dialog.showMessageBox = async () => { prompts++; return { response: 1, checkboxChecked: true }; };
    const sharedContents = recoveryManager.contents(shared.id);
    assert.equal(await sharedContents.executeJavaScript("Notification.requestPermission()", true), "granted");
    assert.equal(prompts, 1);
    assert.equal(await sharedContents.executeJavaScript("Notification.permission"), "granted");
    assert.equal(await sharedContents.executeJavaScript("Notification.requestPermission()", true), "granted");
    assert.equal(prompts, 1);
    const changed = await recoveryManager.execute({ sessionId: "restore-chat", action: "space-create", name: "Isolated recovery" });
    const spaceId = changed.spaces.at(-1).id;
    const isolated = await recoveryManager.create("restore-chat", url, "human", spaceId);
    await settle(() => isolated.status === "ready", "Isolated recovery page did not load");
    dialog.showMessageBox = async () => { prompts++; return { response: 0, checkboxChecked: false }; };
    const isolatedContents = recoveryManager.contents(isolated.id);
    assert.equal(await isolatedContents.executeJavaScript("Notification.requestPermission()", true), "denied");
    assert.equal(prompts, 2);
    assert.equal(await sharedContents.executeJavaScript("Notification.permission"), "granted");
    await recoveryManager.execute({ sessionId: "restore-chat", action: "permission-forget", spaceId: "shared", origin: url, permission: "notifications" });
    assert.notEqual(await sharedContents.executeJavaScript("Notification.permission"), "granted");
    record("permission routing", "remembered origin permission avoids a second prompt, an isolated space prompts separately and revocation removes the grant; dialog choices supplied by the test");
    isolatedContents.forcefullyCrashRenderer();
    await settle(() => isolated.status === "crashed", "Renderer crash did not preserve the tab and surface its status");
    const identity = isolatedContents.id;
    await recoveryManager.execute({ sessionId: "restore-chat", action: "reload", pageId: isolated.id });
    await settle(() => isolated.status === "ready", "Crashed page did not reload explicitly");
    assert.equal(recoveryManager.contents(isolated.id).id, identity);
    record("crash recovery", "a renderer crash retains the tab and its reason; explicit reload recovers the same webContents");
    await sharedContents.executeJavaScript("document.cookie='browser_login=retained; max-age=3600';document.querySelector('#text').value='unsaved';window.unsavedState=42");
    await sharedContents.session.cookies.flushStore();
    await recoveryManager.execute({ sessionId: "restore-chat", action: "select", pageId: shared.id });
    await recoveryManager.store.flush();
    fs.writeFileSync(path.join(temporary, "recovery.json"), JSON.stringify({ directory: recoveryDirectory, active: shared.id, dormant: isolated.id, url }));
  } finally { dialog.showMessageBox = originalDialog; await recoveryManager.dispose(); }

  const { ManagedBrowserRelay } = await import("../apps/desktop/dist/src/managed-browser-relay.js");
  const { spawn } = require("node:child_process");
  const runtimeDirectory = path.join(temporary, "runtime");
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const relayManager = new DesktopManagedBrowser({ directory: path.join(temporary, "relay-store"), downloadsDirectory: path.join(temporary, "relay-downloads"), windowFor: () => main });
  new ManagedBrowserRelay({ manager: relayManager, directory: () => runtimeDirectory });
  const child = spawn("bun", [path.join(__dirname, "browser-managed-runtime.ts"), runtimeDirectory, "runtime-chat"], { cwd: path.join(__dirname, "../omp-patch/vendor/oh-my-pi"), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", requestId = 0;
  const requests = new Map();
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); });
  child.stdout.on("data", chunk => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      let response; try { response = JSON.parse(line); } catch { continue; }
      const pending = requests.get(response.id); if (!pending) continue;
      clearTimeout(pending.timer); requests.delete(response.id);
      if (response.ok) pending.resolve(response.result); else pending.reject(new Error(response.error));
    }
  });
  child.on("exit", code => { for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error(`Runtime fixture exited ${code}: ${stderr}`)); } requests.clear(); });
  const request = (action, parameters, owner) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Runtime request timed out: ${action}; ${stderr}`)); }, 40000);
    requests.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, action, parameters, owner }) + "\n");
  });
  try {
    const opened = await request("invoke", { action: "open", url, timeout: 30 });
    assert.equal(opened.details.browser, "relay");
    const runtimePage = relayManager.pages("runtime-chat")[0]; assert.ok(runtimePage);
    const inputEvents = [];
    relayManager.contents(runtimePage.id).on("before-input-event", (event, input) => inputEvents.push({ type: input.type, key: input.key, prevented: event.defaultPrevented, focused: relayManager.contents(runtimePage.id)?.isFocused() }));
    const filled = await request("invoke", { action: "run", code: 'await tab.fill("#text", "Agent 同页"); return await page.$eval("#text", element => element.value);', timeout: 20 });
    assert.equal(filled.details.value, "Agent 同页", JSON.stringify(inputEvents));
    assert.equal(await relayManager.contents(runtimePage.id).executeJavaScript("document.querySelector('#text').value"), "Agent 同页");
    for (const owner of ["child", "isolated"]) {
      const shared = await request("invoke", { action: "run", code: 'return await page.$eval("#text", element => element.value);', timeout: 20 }, owner);
      assert.equal(shared.details.value, "Agent 同页");
      assert.equal(relayManager.pages("runtime-chat").length, 1);
    }
    await relayManager.execute({ sessionId: "runtime-chat", action: "take" });
    await assert.rejects(request("invoke", { action: "run", code: "return 1", timeout: 5 }), /user controls/i);
    for (const owner of ["child", "isolated"]) await assert.rejects(request("invoke", { action: "run", code: "return 1", timeout: 5 }, owner), /user controls/i);
    await relayManager.execute({ sessionId: "runtime-chat", action: "return" });
    const downloaded = await request("invoke", { action: "run", code: 'const waiting = tab.waitForDownload(); await tab.evaluate(() => { const link = document.createElement("a"); link.href = "/download"; document.body.append(link); link.click(); }); return await waiting;', timeout: 20 }).catch(error => { throw new Error(`${error}; native downloads: ${JSON.stringify(relayManager.store.state("runtime-chat").downloads)}`); });
    assert.equal(fs.readFileSync(downloaded.details.value.path, "utf8"), "managed browser download");
    assert.equal(new URL(downloaded.details.value.url).pathname, "/download");
    const identity = relayManager.contents(runtimePage.id).id;
    const transitions = [];
    const stopTransitions = relayManager.subscribe(event => { if (event.kind === "state" && event.state.sessionId === "runtime-chat") transitions.push(event.state.connection); });
    await request("rotate");
    await settle(() => transitions.includes("disconnected") && transitions.at(-1) === "connected", "New Runtime generation did not rebind");
    transitions.length = 0;
    await wait(2200);
    assert.equal(transitions.includes("disconnected"), false);
    await request("retire");
    await request("invoke", { action: "open", app: { target: url }, timeout: 20 });
    const rebound = await request("invoke", { action: "run", code: 'return await page.$eval("#text", element => element.value);', timeout: 20 }, "isolated");
    assert.equal(rebound.details.value, "Agent 同页");
    assert.equal(relayManager.contents(runtimePage.id).id, identity);
    stopTransitions();
    record("Runtime generation and child ownership", "registered normal and isolated descendants share the parent page and takeover gate; overlapping Runtime generations select the newest live connection without recreating the page");
    await request("release");
    assert.ok(relayManager.contents(runtimePage.id));
    const targets = await request("invoke", { action: "targets", timeout: 20 });
    assert.ok(targets.details.value.length);
    await request("invoke", { action: "open", name: "existing", app: { target: url }, timeout: 20 });
    const kept = await request("invoke", { action: "run", name: "existing", code: 'return await page.$eval("#text", element => element.value);', timeout: 20 });
    assert.equal(kept.details.value, "Agent 同页");
    await request("invoke", { action: "close", name: "existing", timeout: 20 });
    assert.equal(relayManager.contents(runtimePage.id), undefined);
    record("real Runtime relay", "browser tool edits the native page, obeys takeover, retains page on owner release and closes only on explicit close");
  } finally {
    try { await request("stop"); } catch { child.kill(); }
    await relayManager.dispose();
  }

  const output = path.resolve(__dirname, "../outputs/browser-native-smoke");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, `${process.platform}.png`), (await page.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, `${process.platform}.json`), JSON.stringify({ platform: process.platform, arch: process.arch, electron: process.versions.electron, results, manualRemaining: ["OS mouse hit testing through native shield", "physical Chinese IME", "native file drag/drop", "mixed-DPI dock geometry", "other operating system"] }, null, 2));
}

run().then(() => shutdown(0), error => { console.error(error); shutdown(1); });
async function shutdown(code) {
  console.log(`Native smoke finished: ${code}`);
  for (const entry of views) {
    if (!entry.window.isDestroyed()) entry.window.contentView.removeChildView(entry.clip);
    entry.clip.removeChildView(entry.page);
  }
  for (const item of contents) if (!item.isDestroyed()) {
    if (item.debugger.isAttached()) item.debugger.detach();
    item.close({ waitForBeforeUnload: false });
  }
  await wait(150);
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  await wait(100);
  server?.close();
  app.exit(code);
}
