const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("installerShell", Object.freeze({
  isHost: true,
  minimize: () => ipcRenderer.send("installer-shell:minimize"),
  close: () => ipcRenderer.send("installer-shell:close"),
}));
