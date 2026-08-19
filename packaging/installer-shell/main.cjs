const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 480;

const repoRoot = path.resolve(__dirname, "..", "..");
let previewDone = false;
let mainWindow = null;

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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function runtimeVersion() {
  const series = readJson(path.join(repoRoot, "omp-patch", "patches", "series.json"));
  const vendor = readJson(path.join(repoRoot, "omp-patch", "vendor", "oh-my-pi", "packages", "coding-agent", "package.json"));
  if (series && vendor && vendor.version) {
    const patch = typeof series.patchsetVersion === "string" ? series.patchsetVersion : `studio.${(series.patches || []).length}`;
    return `${vendor.version}-${patch}`;
  }
  return "dev";
}

function productVersion() {
  const pkg = readJson(path.join(repoRoot, "package.json"));
  return (pkg && pkg.version) || "0.1.0";
}

function specialFolders() {
  const home = os.homedir();
  const uniq = [];
  for (const item of [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Downloads"),
    process.env.WINDIR,
    home,
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    os.tmpdir(),
    process.env.ProgramData,
  ]) {
    if (!item) continue;
    const normalized = String(item).replace(/[\\/]+$/u, "");
    if (!uniq.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) uniq.push(normalized);
  }
  return uniq;
}

function getState() {
  const occupancy = process.env.OMP_INSTALLER_SCENARIO || "";
  return {
    productName: "OMP Studio",
    version: productVersion(),
    runtimeVersion: runtimeVersion(),
    arch: "x64",
    defaultPath: path.join(process.env.ProgramFiles || "C:\\Program Files", "OMP Studio"),
    existingVersion: "",
    existingPath: "",
    occupancy: occupancy === "fresh" || occupancy === "" ? null : occupancy,
    running: false,
    spaceRequiredMB: 350,
    specialFolders: specialFolders(),
  };
}

function statDir(selected) {
  const target = String(selected || "");
  const result = {
    exists: false,
    empty: true,
    hasProductFiles: false,
    freeBytes: 0,
    totalBytes: 0,
    drive: "",
  };
  try {
    result.exists = fs.existsSync(target) && fs.statSync(target).isDirectory();
    if (result.exists) {
      const entries = fs.readdirSync(target);
      result.empty = entries.length === 0;
      result.hasProductFiles =
        fs.existsSync(path.join(target, "OMP Studio.exe")) ||
        fs.existsSync(path.join(target, "Uninstall OMP Studio.exe"));
    }
    const root = path.parse(target).root;
    result.drive = root;
    if (root && typeof fs.statfsSync === "function") {
      const disk = fs.statfsSync(root);
      result.totalBytes = Number(disk.blocks) * Number(disk.bsize);
      result.freeBytes = Number(disk.bavail) * Number(disk.bsize);
    }
  } catch {
    /* preview host still returns the exists/empty flags */
  }
  return result;
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
  window.once("ready-to-show", () => window.show());
  window.loadFile(resolveUiPath(), { query: { host: "installer" } });
  mainWindow = window;
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

ipcMain.on("installer-shell:getState", (event) => {
  event.returnValue = getState();
});

ipcMain.on("installer-shell:statDir", (event, selected) => {
  event.returnValue = statDir(selected);
});

ipcMain.on("installer-shell:browse", (event, current) => {
  const window = windowFromSender(event);
  const picked = dialog.showOpenDialogSync(window ?? undefined, {
    title: "选择 OMP Studio 安装位置",
    defaultPath: current || undefined,
    properties: ["openDirectory", "createDirectory"],
  });
  event.returnValue = picked && picked[0] ? picked[0] : "";
});

ipcMain.on("installer-shell:startInstall", () => {
  previewDone = false;
  setTimeout(() => {
    previewDone = true;
  }, 4000);
});

ipcMain.on("installer-shell:poll", (event) => {
  event.returnValue = { done: previewDone };
});

ipcMain.on("installer-shell:finish", (event) => {
  windowFromSender(event)?.close();
});

ipcMain.on("installer-shell:killApp", (event) => {
  event.returnValue = true;
});

app.whenReady().then(() => {
  app.setAppUserModelId("com.ompstudio.installer");
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
