/**
 * Production Desktop Runtime session port.
 *
 * Spawns the trusted managed executable under the selected workspace cwd
 * (`--cwd <dir>`), performs the Bridge bootstrap/handshake and wires a
 * `StudioRuntimeSessionController`; `rebind` stops the current Runtime and
 * spawns it again under a new workspace cwd. All of this stays in the
 * Main process — the Renderer never sees an executable path, endpoint,
 * token or PID.
 *
 * Startup rules:
 * - Without a selected workspace `start` returns `undefined` (read-only).
 *   `%APPDATA%\omp-studio` is never impersonated as a project directory.
 * - Without a managed installation (`installer.currentManifest()`) the
 *   port returns `undefined` instead of throwing, so a missing runtime
 *   keeps the whole app read-only instead of killing startup.
 * - The executable path comes ONLY from `currentManifest().entrypointPath`;
 *   `RuntimeResolution` never carries one.
 * - `stop` / `rebind` fail closed: the controller is disposed, the process
 *   is stopped and the bridge is closed — a dead Runtime is never reported
 *   as connected.
 *
 * Bridge token state lives under `<profile>/bridge/` (never inside the
 * user's project directory).
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { join } from "node:path";

import type { HostRuntimeHelloView } from "@omp-studio/host-client-api";
import {
  CommandLedger,
  HostBackend,
  NodeRuntimeProcessPort,
  StudioBridgeClient,
  StudioRuntimeSessionController,
  buildProcessProbeArgs,
  createBridgeBootstrap,
  createWindowsBridgeAclPort,
  type BridgeBootstrap,
  type RuntimeContainmentPort,
  type WindowsBridgeAclPort,
} from "@omp-studio/studio-host";
import type {
  EnvironmentId,
  RuntimeEpoch,
  RuntimeId,
  SessionBinding,
  StudioHelloResponse,
  ThreadId,
  WorkspaceId,
} from "@omp-studio/studio-protocol";

import type {
  DesktopRuntimeSession,
  DesktopRuntimeSessionContext,
  DesktopRuntimeSessionPort,
} from "./host-composition.js";

export interface DesktopRuntimeSessionPortOptions {
  /** Bridge token state lives under `<profile>/<bridgeDirectoryName>`; defaults to `bridge`. */
  readonly bridgeDirectoryName?: string;
  /** Injectable current-user ACL provider for the bridge directory/token. */
  readonly windowsAcl?: WindowsBridgeAclPort;
  /** Injectable socket connector (tests); defaults to `node:net` createConnection. */
  readonly connectSocket?: (endpoint: string) => Socket;
  /** Injectable process spawner (tests); defaults to `node:child_process` spawn. */
  readonly spawnProcess?: typeof spawn;
  /** Process containment; defaults to a plain kill-based fallback (no Job Object in P1). */
  readonly containment?: RuntimeContainmentPort;
  /** Studio protocol versions the Host supports; defaults to the protocol default. */
  readonly supportedProtocolVersions?: readonly number[];
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

/** P1 fallback containment: plain `kill()` with a force-kill fallback. */
const KILL_BASED_CONTAINMENT: RuntimeContainmentPort = {
  requestStop(process: ChildProcess): void {
    process.kill();
  },
  forceStop(process: ChildProcess): void {
    process.kill("SIGKILL");
  },
};

function helloView(hello: StudioHelloResponse, classification: SessionBinding["classification"]): HostRuntimeHelloView {
  return {
    runtimeId: hello.runtimeInstanceId,
    runtimeEpoch: Number(hello.runtimeEpoch),
    classification,
    backend: "studio-host",
    runtimeVersion: hello.runtimeVersion,
    upstreamVersion: hello.upstreamVersion,
    upstreamCommit: hello.upstreamCommit,
  };
}

export function createDesktopRuntimeSessionPort(
  options: DesktopRuntimeSessionPortOptions = {},
): DesktopRuntimeSessionPort {
  const containment = options.containment ?? KILL_BASED_CONTAINMENT;
  /** The selected workspace; `undefined` until the first pick/open rebind. */
  let workspace: { workspaceId: string; cwd: string } | undefined;
  /** Start context (profile directory) captured by `start`; needed by `rebind`. */
  let context: DesktopRuntimeSessionContext | undefined;
  let processPort: NodeRuntimeProcessPort | undefined;
  let bridge: StudioBridgeClient | undefined;
  let bundle: DesktopRuntimeSession | undefined;
  let alive = false;

  async function stopCurrent(): Promise<void> {
    if (bundle === undefined) {
      return;
    }
    const current = bundle;
    bundle = undefined;
    alive = false;
    current.controller.dispose();
    const port = processPort;
    processPort = undefined;
    if (port !== undefined) {
      await port.stop();
    }
    bridge?.close();
    bridge = undefined;
  }

  async function launch(): Promise<DesktopRuntimeSession | undefined> {
    const selected = workspace;
    const launchContext = context;
    if (selected === undefined || launchContext === undefined) {
      return undefined;
    }
    if (launchContext.resolution.classification === "rejected") {
      // Fail closed: a rejected resolution never gets a spawned runtime.
      return undefined;
    }
    // The executable path comes only from the managed installation manifest.
    const backend = new HostBackend({ stateDirectory: launchContext.profileDirectory });
    await backend.initialize();
    const installed = await backend.installer.currentManifest();
    if (installed === undefined) {
      return undefined;
    }

    const bridgeBootstrap: BridgeBootstrap =
      options.windowsAcl !== undefined || process.platform !== "win32"
        ? await createBridgeBootstrap(
            join(launchContext.profileDirectory, options.bridgeDirectoryName ?? "bridge"),
            process.platform,
            options.windowsAcl,
          )
        : await createBridgeBootstrap(
            join(launchContext.profileDirectory, options.bridgeDirectoryName ?? "bridge"),
            process.platform,
            createWindowsBridgeAclPort(),
          );

    const client = new StudioBridgeClient({
      endpoint: bridgeBootstrap.endpoint,
      token: bridgeBootstrap.token,
      ...(options.supportedProtocolVersions === undefined
        ? {}
        : { supportedProtocolVersions: options.supportedProtocolVersions }),
      ...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.connectSocket === undefined ? {} : { connectSocket: options.connectSocket }),
    });
    bridge = client;

    const binding: SessionBinding = {
      threadId: "thread-gui-main" as ThreadId,
      environmentId: "env-gui-main" as EnvironmentId,
      workspaceId: selected.workspaceId as WorkspaceId,
      runtimeId: "runtime-pending" as RuntimeId,
      runtimeEpoch: 1 as RuntimeEpoch,
      classification: launchContext.resolution.classification,
      backend: "studio-host",
      runtimeVersion: installed.manifest.runtimeVersion,
      upstreamVersion: installed.manifest.upstreamVersion,
      upstreamCommit: installed.manifest.upstreamCommit,
      capabilityHash: installed.manifest.capabilityHash,
      commandManifestHash: installed.manifest.commandManifestHash,
    };

    /** Filled by the readiness hook with the authenticated handshake hello. */
    let hello: StudioHelloResponse | undefined;
    const port = new NodeRuntimeProcessPort({
      executable: installed.entrypointPath,
      cwd: selected.cwd,
      args: () => buildProcessProbeArgs(["--cwd", selected.cwd], bridgeBootstrap),
      containment,
      waitUntilReady: async () => {
        // Readiness = authenticated Bridge handshake; the initial snapshot
        // happens through the controller refresh below.
        hello = await client.connect();
      },
      requestGracefulShutdown: async () => {
        await client.shutdown();
      },
      spawnOptions: { windowsHide: true, stdio: "ignore" },
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
    });
    processPort = port;
    await port.start(binding);

    const controller = new StudioRuntimeSessionController(client, new CommandLedger());
    await controller.refresh();
    if (hello === undefined) {
      throw new Error("Runtime Bridge handshake completed without a hello response");
    }
    const view = helloView(hello, launchContext.resolution.classification);
    const session: DesktopRuntimeSession = {
      controller,
      hello: () => (alive ? view : undefined),
      onPublication: (listener) =>
        client.onProjectionChanged(() => {
          const publication = controller.publication();
          if (publication !== undefined) listener(publication);
        }),
    };
    bundle = session;
    alive = true;
    return session;
  }

  return {
    async start(launchContext: DesktopRuntimeSessionContext): Promise<DesktopRuntimeSession | undefined> {
      context = launchContext;
      if (workspace === undefined) {
        // No project selected yet: stay read-only, never fabricate a cwd.
        return undefined;
      }
      return await launch();
    },

    async stop(): Promise<void> {
      await stopCurrent();
    },

    async rebind(next: { workspaceId: string; cwd: string }): Promise<DesktopRuntimeSession | undefined> {
      // Stop first; a failed relaunch must never pretend the old Runtime
      // is still connected.
      await stopCurrent();
      workspace = next;
      return await launch();
    },
  };
}
