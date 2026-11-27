import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ClientTransport, ClientEvent } from "@omp-studio/client-contract";
import { eventMatchesScope } from "@omp-studio/client";
import { desktopPaths } from "../platform/desktop-paths.js";
import { createHostFileLog } from "../host-log.js";
import type {
  ProductionDesktopHostFactory,
  ProductionHostOptions,
} from "../host-factory.js";
import type { DesktopHostComposition } from "../types.js";
import type { RemotePeer } from "../remote/wire.js";
import {
  getDesktopLanguage,
  onDesktopLanguageChange,
} from "../desktop-language-shared.js";
import { attachArtifactLibrary } from "../artifact-library.js";
import { SharedArtifactLibrary } from "./artifacts.js";
import { connectLocalChannel, type HostCall } from "./local-channel.js";
import type { ControlState } from "./control.js";

export interface SharedHostLaunch {
  port?: number;
  executable: string;
  entry: string;
  rendererDirectory: string;
  installLayout?: ProductionHostOptions["installLayout"];
  packaged?: boolean;
}

export async function ensureSharedHost(
  options: SharedHostLaunch,
): Promise<RemotePeer> {
  const state = desktopPaths().stateRoot;
  const version = createHash("sha256")
    .update(await readFile(options.entry))
    .digest("hex");
  try {
    const existing = await connectLocalChannel(state);
    const identity = await existing.request<{ bundleVersion: string }>(
      "host.call",
      { action: "identity" },
    );
    if (identity.bundleVersion === version) return existing;
    existing.close();
    throw new Error(
      "The running Host has a different version. Finish its tasks and terminals, run omp-studio-web stop, then reopen Studio.",
    );
  } catch (error) {
    if (
      !["ENOENT", "ECONNREFUSED"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
  const log = createHostFileLog({ directory: desktopPaths().logsRoot });
  await mkdir(desktopPaths().logsRoot, { recursive: true });
  log.write("info", "host.start", "Starting shared Host");
  if (process.platform === "win32") {
    const launchFile = join(desktopPaths().logsRoot, `host-launch-${randomUUID()}.json`);
    await writeFile(launchFile, JSON.stringify(options), { mode: 0o600 });
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const argumentsText = [options.entry, "serve", "--options-file", launchFile]
      .map(value => `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/\\+$/u, '$&$&')}"`).join(" ");
    // Match the remote Host launcher. WMI starts outside Electron's process
    // lifetime, while an inherited child can hold Chromium's Windows teardown.
    const commandLine = `"${options.executable}" ${argumentsText}`;
    const script = `$env:ELECTRON_RUN_AS_NODE='1';$environment=[string[]]@(Get-ChildItem Env: | ForEach-Object { $_.Name+'='+$_.Value });$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0;EnvironmentVariables=$environment};$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${quote(commandLine)};CurrentDirectory=${quote(process.cwd())};ProcessStartupInformation=$startup};if($result.ReturnValue -ne 0){throw ('Shared Host start failed: '+$result.ReturnValue)}`;
    try {
      await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15_000 });
      for (let attempt = 0; attempt < 240; attempt++) {
        try { return await connectLocalChannel(state); }
        catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        await new Promise(done => setTimeout(done, 250));
      }
      throw new Error(`Shared Host did not become ready. See ${desktopPaths().logsRoot}`);
    } finally { await rm(launchFile, { force: true }); }
  }
  const output = await open(
    join(desktopPaths().logsRoot, "shared-host.log"),
    "a",
    0o600,
  );
  try {
    const child = spawn(
      options.executable,
      [
        options.entry,
        "serve",
        "--options",
        JSON.stringify({ ...options, bundleVersion: version }),
      ],
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", output.fd, output.fd],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    child.once("exit", (code) => {
      failure = new Error(
        `Shared Host exited (${code}). See ${join(desktopPaths().logsRoot, "shared-host.log")}`,
      );
    });
    child.unref();
    for (let attempt = 0; attempt < 240; attempt++) {
      try {
        return await connectLocalChannel(state);
      } catch (error) {
        if (
          !["ENOENT", "ECONNREFUSED"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
      if (failure) throw failure;
      await new Promise((done) => setTimeout(done, 250));
    }
    throw new Error(
      `Shared Host did not become ready. See ${join(desktopPaths().logsRoot, "shared-host.log")}`,
    );
  } finally {
    await output.close();
  }
}

export class SharedHostConnection {
  control: ControlState = { version: "" };
  id = "";
  readonly #listeners = new Set<(event: any) => void>();
  constructor(readonly peer: RemotePeer) {
    peer.onEvent((event) => {
      const value = event as any;
      if (value.kind === "control.changed") this.control = value.control;
      for (const listener of this.#listeners) listener(value);
    });
  }
  async initialize(takeIfFree = false): Promise<void> {
    const identity = await this.call<{ id: string; control: ControlState }>(
      "identity",
    );
    this.id = identity.id;
    this.control = identity.control;
    if (takeIfFree && !identity.control.owner) await this.takeControl();
  }
  async takeControl(name = "Desktop"): Promise<ControlState> {
    this.control = await this.call("control.take", { name });
    return this.control;
  }
  call<T = unknown>(
    action: string,
    input?: unknown,
    contextId?: string,
  ): Promise<T> {
    return this.peer.request<T>(
      "host.call",
      {
        action,
        input,
        ...(contextId ? { contextId } : {}),
        version: this.control.version,
      } satisfies HostCall,
      240_000,
    );
  }
  onEvent(listener: (event: any) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  async close(): Promise<void> {
    if (this.peer.input.closed) return;
    const closed = new Promise<void>(resolve => this.peer.input.once("close", () => resolve()));
    this.peer.close();
    await closed;
  }
  transport(contextId?: string): ClientTransport {
    const listeners = new Set<(event: ClientEvent) => void>();
    const off = this.onEvent((event) => {
      if (event.kind === "host.event" && event.contextId === (contextId ?? ""))
        for (const listener of listeners) listener(event.event);
    });
    let subscribed: Promise<unknown> | undefined;
    const subscribe = () =>
      (subscribed ??= this.call("subscribe", undefined, contextId));
    return {
      supportsContexts: true,
      openContext: async (scope) => {
        const result = await this.call<{ contextId: string }>(
          "context.open",
          scope,
        );
        return this.transport(result.contextId);
      },
      bootstrap: async () => {
        await subscribe();
        return this.call("bootstrap", undefined, contextId);
      },
      query: (request) => this.call("query", request, contextId),
      command: (request) => this.call("command", request, contextId),
      subscribe: (scope, listener) => {
        const selected = (event: ClientEvent) => {
          if (eventMatchesScope(event, scope)) listener(event);
        };
        listeners.add(selected);
        void subscribe().catch(() => {});
        return () => {
          listeners.delete(selected);
        };
      },
      close: async () => {
        off();
        listeners.clear();
        if (contextId) await this.call("context.close", undefined, contextId);
      },
    };
  }
}

export interface SharedDesktopHostFactory extends ProductionDesktopHostFactory {
  connection(): Promise<SharedHostConnection>;
  stopForRuntimeRecovery(): Promise<void>;
}

export function createSharedDesktopHostFactory(
  launch: SharedHostLaunch,
  hooks: Pick<
    ProductionHostOptions,
    | "onPtyInputWait"
    | "beforeCreate"
    | "afterCreate"
    | "loginEnvironment"
    | "pickDirectory"
    | "openUrl"
    | "revealDirectory"
    | "systemFiles"
  > = {},
): SharedDesktopHostFactory {
  const log = createHostFileLog({ directory: desktopPaths().logsRoot });
  let connecting: Promise<SharedHostConnection> | undefined;
  let snapshot: {
    busy: boolean;
    cwd?: string;
    restartBlocker?: string;
    runtimeStatus: "ready" | "read-only";
  } = { busy: false, runtimeStatus: "read-only" };
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const connection = () =>
    (connecting ??= (async () => {
      await hooks.loginEnvironment;
      const result = new SharedHostConnection(await ensureSharedHost(launch));
      result.peer.handle(async (method, raw) => {
        const call = raw as HostCall;
        if (method !== "host.call")
          throw new Error("Unsupported desktop callback");
        switch (call.action) {
          case "ptyInputWait":
            return hooks.onPtyInputWait?.(call.input);
          case "pickDirectory":
            return hooks.pickDirectory?.();
          case "openUrl":
            return hooks.openUrl?.(call.input);
          case "revealDirectory":
            return hooks.revealDirectory?.(call.input);
          case "trash":
            return hooks.systemFiles?.trash?.(call.input);
          case "knownFolders": {
            const folders = hooks.systemFiles?.knownFolders;
            return typeof folders === "function" ? folders() : folders;
          }
          default:
            throw new Error("Unsupported desktop callback");
        }
      });
      await result.call("desktop.attach");
      await result.initialize(true);
      await result.call("language", getDesktopLanguage());
      const offLanguage = onDesktopLanguageChange((locale) => {
        void result
          .call("language", locale)
          .catch((error) => log.write("warn", "host.language", String(error)));
      });
      result.peer.onClose(() => {
        clearInterval(timer);
        timer = undefined;
        offLanguage();
        connecting = undefined;
      });
      return result;
    })().catch(error => {
      connecting = undefined;
      throw error;
    }));
  const refresh = async () => {
    snapshot = await (await connection()).call("status");
  };
  return {
    log,
    connection,
    async stopForRuntimeRecovery() {
      disposed = true;
      clearInterval(timer);
      timer = undefined;
      const client = await connection();
      const stopped = new Promise<void>((resolve) =>
        client.peer.onClose(() => resolve()),
      );
      await client.call("shutdown");
      await stopped;
    },
    async create() {
      disposed = false;
      attachArtifactLibrary(
        desktopPaths().stateRoot,
        new SharedArtifactLibrary(desktopPaths().stateRoot, {
          call: async (action, input, contextId) =>
            (await connection()).call(action, input, contextId),
        }),
      );
      await hooks.beforeCreate?.();
      const client = await connection();
      await refresh();
      timer ??= setInterval(() => {
        if (!disposed) void refresh().catch(() => {});
      }, 2000);
      timer.unref();
      const transport = client.transport();
      const composition: DesktopHostComposition = {
        facade: Object.defineProperty(transport, "hasPendingCommands", {
          get: () => snapshot.busy,
        }) as DesktopHostComposition["facade"],
        transport,
        get status() {
          return snapshot.runtimeStatus;
        },
        whenRuntimeReady: async () => {
          await transport.bootstrap();
          await refresh();
        },
        reload: async () => composition,
        rebindWorkspace: async (workspace) => {
          if (workspace)
            await transport.command({
              commandName: "workspace.open",
              input: {
                workspaceId:
                  workspace.workspaceId as import("@omp-studio/client-contract").WorkspaceId,
              },
              requestId: randomUUID() as any,
              idempotencyKey: randomUUID() as any,
            });
        },
        shutdown: async () => {
          disposed = true;
          clearInterval(timer);
          timer = undefined;
          await transport.close();
          await client.close();
        },
        confirmClose: async () => true,
        isBusy: () => snapshot.busy,
        rollbackRuntime: () => client.call("runtime.rollback"),
        pruneRuntimes: () => client.call("runtime.prune"),
        updateRestartBlocker: () => snapshot.restartBlocker,
      };
      if (await hooks.afterCreate?.(composition, Boolean(snapshot.cwd)))
        return this.create();
      return composition;
    },
    resolveWorkspaceCwd: async (workspaceId) =>
      (await connection()).call("workspace.path", { workspaceId }),
    activeWorkspaceCwd: () => snapshot.cwd,
    isBusy: () => snapshot.busy,
    updateRestartBlocker: () => snapshot.restartBlocker,
    rollbackRuntime: async () => (await connection()).call("runtime.rollback"),
    pruneRuntimes: async () => (await connection()).call("runtime.prune"),
    shutdownForUpdate: async (started) => {
      const client = await connection();
      const stopped = new Promise<void>((resolve) =>
        client.peer.onClose(() => resolve()),
      );
      await client.call("shutdown", { update: true });
      disposed = true;
      clearInterval(timer);
      timer = undefined;
      await stopped;
      started();
    },
  };
}
