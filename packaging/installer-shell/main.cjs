const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 480;

function resolveUiPath() {
  const candidates = [
    path.join(__dirname, "..", "ui", "index.html"),
    path.join(process.resourcesPath, "ui", "index.html"),
  ];
  const uiPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!uiPath) {
    throw new Error(`Installer UI not found. Checked: ${candidates.join(", ")}`);
  }
  return uiPath;
}

function createWindow() {
  const iconPath = path.join(__dirname, "..", "ui", "app-icon.png");
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: "#1d1d25",
    title: "OMP Studio 安装",
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[installer-shell] renderer ${sourceId}:${line}: ${message}`);
  });
  window.webContents.on("did-finish-load", () => {
    console.log(`[installer-shell] loaded ${window.webContents.getURL()}`);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`[installer-shell] UI failed to load (${errorCode}): ${errorDescription}`);
  });
  window.once("ready-to-show", () => window.show());

  window.loadFile(resolveUiPath(), { query: { host: "installer" } });
  return window;
}

function windowFromSender(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.on("installer-shell:minimize", (event) => {
  windowFromSender(event)?.minimize();
});

ipcMain.on("installer-shell:close", (event) => {
  windowFromSender(event)?.close();
});

app.whenReady().then(() => {
  app.setAppUserModelId("com.ompstudio.installer");
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
