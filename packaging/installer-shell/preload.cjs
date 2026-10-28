const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("installerShell", Object.freeze({
  isHost: true,
  isLive: true,
  isPreview: true,
  minimize: () => ipcRenderer.send("installer-shell:minimize"),
  close: () => ipcRenderer.send("installer-shell:close"),
  drag: () => {},
  getState: () => ipcRenderer.sendSync("installer-shell:getState"),
  statDir: (selected) => ipcRenderer.sendSync("installer-shell:statDir", selected),
  browse: (current) => ipcRenderer.sendSync("installer-shell:browse", current) || "",
  startInstall: (opts) => ipcRenderer.sendSync("installer-shell:startInstall", opts),
  poll: () => ipcRenderer.sendSync("installer-shell:poll"),
  finish: (opts) => ipcRenderer.send("installer-shell:finish", opts),
  openReleaseNotes: () => ipcRenderer.send("installer-shell:openReleaseNotes"),
}));
