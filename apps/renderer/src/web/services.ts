import type { BrowserWebClientTransport } from "@omp-studio/transport-web/browser";
import type { WebDevice, WebStatus } from "../../../desktop/src/web/shared";
import type { ControlState } from "../../../desktop/src/web/control";
import type { SharedTerminal } from "../../../desktop/src/web/terminals";
import type {
  TerminalDataEvent,
  TerminalExitEvent,
} from "../../../desktop/src/terminal-shared";
import { activeLanguage } from "../i18n";
import { updateControlState } from "./controlState";

export async function installBrowserServices(
  transport: BrowserWebClientTransport,
  connectionChanged: (connected: boolean) => void,
) {
  const request = <T>(path: string, body?: unknown): Promise<T> =>
    transport.request(
      `/api/web/${path}`,
      body === undefined ? "GET" : "POST",
      body,
    ) as Promise<T>;
  const listeners = new Set<(state: ControlState) => void>();
  const dataListeners = new Set<(event: TerminalDataEvent) => void>();
  const exitListeners = new Set<(event: TerminalExitEvent) => void>();
  const sessionListeners = new Set<(rows: SharedTerminal[]) => void>();
  let rows: SharedTerminal[] = [];
  let ready: () => void = () => {};
  const terminalsReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const state = await request<ControlState & { deviceId: string }>("control");
  updateControlState(state, state.deviceId);
  await request("language", { locale: activeLanguage() });
  globalThis.ompWebControlVersion = state.version;
  let socket: WebSocket;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let attempts = 0;
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(
      `${location.origin.replace(/^http/, "ws")}/api/web/events`,
    );
    const retry = () => {
      connectionChanged(false);
      globalThis.ompWebControlVersion = "";
      updateControlState({ version: "" });
      if (stopped || ++attempts > 8) return;
      reconnectTimer = setTimeout(
        () => {
          void transport.restoreSession().then(connect).catch(retry);
        },
        Math.min(1000 * 2 ** (attempts - 1), 15000),
      );
    };
    socket.onclose = retry;
    socket.onopen = () => {
      attempts = 0;
      void request<ControlState>("control")
        .then((control) => {
          globalThis.ompWebControlVersion = control.version;
          updateControlState(control, state.deviceId);
          listeners.forEach((listener) => listener(control));
          connectionChanged(true);
        })
        .catch(() => socket.close());
    };
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.kind === "control.changed") {
        globalThis.ompWebControlVersion = event.control.version;
        updateControlState(event.control, state.deviceId);
        listeners.forEach((listener) => listener(event.control));
      }
      if (event.kind === "terminal.data") {
        const row = rows.find((row) => row.id === event.id);
        if (row) {
          row.output = (row.output + event.data).slice(-3 * 1024 * 1024);
          row.sequence = event.sequence;
        }
        dataListeners.forEach((listener) => listener(event));
      }
      if (event.kind === "terminal.exit") {
        const row = rows.find((row) => row.id === event.id);
        if (row) row.status = "ended";
        exitListeners.forEach((listener) => listener(event));
      }
      if (event.kind === "terminal.snapshot") {
        rows = event.rows;
        ready();
        sessionListeners.forEach((listener) => listener(rows));
      }
    };
  };
  connect();
  const subscribe = <T>(
    collection: Set<(event: T) => void>,
    listener: (event: T) => void,
  ) => {
    collection.add(listener);
    return () => {
      collection.delete(listener);
    };
  };
  globalThis.ompStudioWebAccess = {
    status: async () =>
      ({
        origin: location.origin,
        devices: await request<WebDevice[]>("devices"),
        control: await request("control"),
        addresses: [],
        deviceId: state.deviceId,
      }) as WebStatus,
    takeControl: async () => {
      const control = await request<ControlState>("control", {});
      globalThis.ompWebControlVersion = control.version;
      updateControlState(control, state.deviceId);
      return control;
    },
    pair: async () => {
      throw new Error("Generate pairing codes on the Host");
    },
    revoke: (id) => request("devices/revoke", { id }),
    rename: (id, name) => request("devices/rename", { id, name }),
    listen: async () => {
      throw new Error("Manage network access on the Host");
    },
    exportCertificate: async () => false,
    onControl: (listener) => subscribe(listeners, listener),
  };
  globalThis.ompStudioTerminal = {
    persistent: true,
    list: async () => {
      await terminalsReady;
      return rows.map((row) => ({ ...row }));
    },
    onSessions: (listener) => subscribe(sessionListeners, listener),
    create: (input) => request("terminals/create", input ?? {}),
    write: (id, data) => request("terminals/write", { id, data }),
    resize: (id, cols, rows) => request("terminals/resize", { id, cols, rows }),
    rebind: (input) => request("terminals/rebind", input),
    dispose: (id) => request("terminals/dispose", { id }),
    recordingStart: (input) => request("terminals/recordingStart", input),
    recordingStop: (id) => request("terminals/recordingStop", { id }),
    recordingStatus: (id) => request("terminals/recordingStatus", { id }),
    onData: (listener) => subscribe(dataListeners, listener),
    onExit: (listener) => subscribe(exitListeners, listener),
  };
  const browserChrome: Partial<NonNullable<typeof globalThis.ompStudioChrome>> =
    {
      setLanguage: async (locale) => {
        await request("language", { locale });
      },
      setConversationViewState: (value) => request("view", value),
      openUrl: async ({ url }: { url: string }) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
      beginMediaUpload: (input) => request("upload/begin", input),
      appendMediaUpload: (input) => {
        const bytes = new Uint8Array(input.bytes);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return request("upload/chunk", {
          uploadId: input.uploadId,
          sequence: input.sequence,
          data: btoa(binary),
        });
      },
      finishMediaUpload: (input) => request("upload/finish", input),
      abortMediaUpload: (input) => request("upload/abort", input),
      exportArtifact: async ({ artifactId }) => {
        const link = document.createElement("a");
        link.href = `/api/artifacts/${encodeURIComponent(artifactId)}`;
        link.download = artifactId;
        link.click();
        return { ok: true, cancelled: false };
      },
    };
  globalThis.ompStudioChrome = browserChrome as NonNullable<
    typeof globalThis.ompStudioChrome
  >;
  return {
    reconnect() {
      clearTimeout(reconnectTimer);
      attempts = 0;
      socket.onclose = null;
      socket.close();
      void transport
        .restoreSession()
        .then(connect)
        .catch(() => connectionChanged(false));
    },
    dispose() {
      stopped = true;
      clearTimeout(reconnectTimer);
      socket.onclose = null;
      socket.close();
    },
  };
}
