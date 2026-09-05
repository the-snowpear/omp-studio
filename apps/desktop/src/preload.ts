/**
 * Secure preload bridge (FRONTEND_INTEGRATION.md §9.1).
 *
 * Runs in a sandboxed renderer (contextIsolation + sandbox, no Node
 * integration) and exposes exactly one frozen object under
 * `window.ompStudio` (see {@link DESKTOP_BRIDGE_GLOBAL}):
 * `OmpStudioDesktopApi` with the fixed named methods bootstrap / query /
 * command / subscribe / close. Window chrome helpers (`ompStudioChrome`,
 * `ompStudioTerminal`) are separate frozen objects on named channels —
 * they are not Host transport.
 *
 * Hard guarantees:
 * - `ipcRenderer` is never exposed: it lives only inside this module's
 *   closure and the bridge adapter below.
 * - No generic `invoke(channel, payload)`: every call resolves to a fixed
 *   constant from `DESKTOP_IPC_CHANNELS` or a chrome channel constant.
 * - No arbitrary event forwarding: `ipcRenderer.on` binds only the fixed
 *   Host event channel and the terminal data/exit channels; unsubscribe
 *   removes the exact listener reference.
 * - No Node API or Host secret (token/endpoint/Runtime PID) leaks.
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";

import {
  createDesktopIpcBridge,
  DESKTOP_BRIDGE_GLOBAL,
  type DesktopIpcBridge,
} from "./ipc-validation.js";
import {
  TERMINAL_IPC_CHANNELS,
  type OmpStudioTerminalApi,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from "./terminal-shared.js";
import { createOmpStudioChromeApi, subscribeChannel } from "./chrome-api.js";

/**
 * Electron `ipcRenderer.on` calls `(IpcRendererEvent, payload)`. The Host
 * bridge must see only the payload — cloning the IPC event throws
 * "envelope contains a non-JSON value". Wrap like the terminal channels
 * and keep a WeakMap so `removeListener` still matches by identity.
 */
const hostEventWrappers = new WeakMap<
  (event: unknown, ...args: readonly unknown[]) => void,
  (event: unknown, ...args: readonly unknown[]) => void
>();

const sender: DesktopIpcBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      listener(payload);
    };
    hostEventWrappers.set(listener, wrapped);
    ipcRenderer.on(channel, wrapped);
  },
  removeListener: (channel, listener) => {
    const wrapped = hostEventWrappers.get(listener) ?? listener;
    hostEventWrappers.delete(listener);
    ipcRenderer.removeListener(channel, wrapped);
  },
};

const api = createDesktopIpcBridge(sender);

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_GLOBAL, api);
contextBridge.exposeInMainWorld("ompStudioChrome", createOmpStudioChromeApi(ipcRenderer, webUtils));

const terminalApi: OmpStudioTerminalApi = {
  create(size) {
    return ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.create, size ?? {}) as ReturnType<
      OmpStudioTerminalApi["create"]
    >;
  },
  write(id, data) {
    return ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.write, { id, data }) as Promise<void>;
  },
  resize(id, cols, rows) {
    return ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.resize, { id, cols, rows }) as Promise<void>;
  },
  dispose(id) {
    return ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.dispose, { id }) as Promise<void>;
  },
  onData(listener) {
    return subscribeChannel<TerminalDataEvent>(ipcRenderer, TERMINAL_IPC_CHANNELS.data, listener);
  },
  onExit(listener) {
    return subscribeChannel<TerminalExitEvent>(ipcRenderer, TERMINAL_IPC_CHANNELS.exit, listener);
  },
};

contextBridge.exposeInMainWorld("ompStudioTerminal", Object.freeze(terminalApi));
