/** Electron acceptance host for pin-harness.html. Uses an isolated profile and real PTYs; no Runtime/model calls. */
const { app, BrowserWindow, ipcMain, screen, Menu } = require("electron");
const { mkdirSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const root = resolve(__dirname, "..");
const profile = process.env.OMP_PIN_SMOKE_PROFILE || join(root, "output", "playwright", "pin-profile");
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.commandLine.appendSwitch("remote-debugging-port", "9337");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
let quitting = false;
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => app.quit());
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const { registerFloatingWindows } = await import(pathToFileURL(join(root, "apps/desktop/dist/src/floating-windows.js")));
  const { registerTerminalIpc } = await import(pathToFileURL(join(root, "apps/desktop/dist/src/terminal-ipc.js")));
  const { TerminalSessionManager, createNodePtySpawner } = await import(pathToFileURL(join(root, "apps/desktop/dist/src/terminal-pty.js")));
  const { secureWebPreferences, rendererOriginFor, isTrustedRendererUrl } = await import(pathToFileURL(join(root, "apps/desktop/dist/src/security.js")));
  const preloadPath = join(profile, "pin-preload.cjs");
  require("esbuild").buildSync({ stdin: { contents: `import ${JSON.stringify(join(root, "apps/desktop/src/preload.ts"))}; import { contextBridge, ipcRenderer } from "electron"; contextBridge.exposeInMainWorld("pinAcceptance", { closeMain: () => ipcRenderer.invoke("pin-smoke:close-main"), state: () => ipcRenderer.invoke("pin-smoke:state"), quit: () => ipcRenderer.invoke("pin-smoke:quit") });`, resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: preloadPath });
  ipcMain.on("omp-studio:desktop:perf-profile-cached", event => { event.returnValue = null; });
  const targetUrl = process.env.OMP_PIN_SMOKE_URL || "http://127.0.0.1:5189/pin-harness.html";
  const target = targetUrl.startsWith("file:") ? { kind: "file", path: require("node:url").fileURLToPath(targetUrl) } : { kind: "url", url: targetUrl };
  const allowedOrigin = rendererOriginFor(target);
  const parent = new BrowserWindow({ width: 1450, height: 900, show: true, webPreferences: { ...secureWebPreferences(preloadPath), backgroundThrottling: false } });
  ipcMain.handle("pin-smoke:close-main", () => { parent.close(); return true; });
  ipcMain.handle("pin-smoke:state", () => ({ mainVisible: parent.isVisible(), windows: BrowserWindow.getAllWindows().map(window => ({ id: window.id, title: window.getTitle(), visible: window.isVisible(), topmost: window.isAlwaysOnTop(), maximized: window.isMaximized(), minimized: window.isMinimized() })) }));
  ipcMain.handle("pin-smoke:quit", () => { setTimeout(() => app.quit(), 20); return true; });
  const floats = registerFloatingWindows({ parent, ipcMain, allowedOrigin, preloadPath, areas: () => screen.getAllDisplays().map(display => display.workArea), isQuitting: () => quitting, openExternal: () => {},
    onWindow: child => {
      console.log("FLOAT_CREATED", child.id);
      child.on("always-on-top-changed", (_event, topmost) => console.log("FLOAT_TOPMOST", child.id, topmost));
      child.webContents.on("console-message", event => { if (event.level === "error") console.error("FLOAT_ERROR", event.message); });
    },
    onVisibility: child => console.log("FLOAT_STATE", child.id, JSON.stringify({ visible: child.isVisible(), minimized: child.isMinimized(), maximized: child.isMaximized(), topmost: child.isAlwaysOnTop(), bounds: child.getBounds() })),
  });
  const spawner = createNodePtySpawner(true); let count = 0;
  const manager = new TerminalSessionManager({ spawner: { spawn(options) { console.log("PTY_SPAWN", ++count); return spawner.spawn(options); } }, resolveCwd: () => profile });
  const terminal = registerTerminalIpc({ ipcMain, manager, isTrustedSender: sender => sender === parent.webContents && isTrustedRendererUrl(sender.getURL(), allowedOrigin) });
  parent.on("close", event => { if (!quitting && floats.hasWindows()) { event.preventDefault(); parent.hide(); console.log("MAIN_HIDDEN"); } });
  parent.webContents.on("console-message", event => { if (event.level === "error") console.error("MAIN_ERROR", event.message); });
  app.on("before-quit", () => { floats.dispose(); terminal.dispose(); });
  await parent.loadURL(targetUrl);
  console.log("PIN_ACCEPTANCE_READY", targetUrl);
}).catch(error => { console.error(error); app.exit(1); });
