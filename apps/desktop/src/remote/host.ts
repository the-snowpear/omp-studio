import { randomUUID } from "node:crypto";
import { join, resolve, isAbsolute } from "node:path";
import { privateEndpoint, type PlatformPort } from "@omp-studio/platform";
import { WorkspaceRegistry, createProcessProbe } from "@omp-studio/studio-host";
import { createOmpWorkspaceService } from "@omp-studio/host-client-api/workspaces";
import type { WorkspaceId, WorkspaceListReadModel } from "@omp-studio/client-contract";
import { createDesktopHostComposition } from "../host-composition.js";
import { createDesktopRuntimeSessionPort } from "../runtime-session.js";
import { createDesktopGitService } from "../git-service.js";
import { createDesktopGithubService } from "../github-service.js";
import { GitWriteQueue, HostProcessRunner } from "../git-process.js";
import { createWorkspaceFileService } from "../workspace-files.js";
import { createWorkspaceSessionCatalog } from "../session-commands.js";
import { createHostFileLog } from "../host-log.js";
import { loadInstallerTrustedKeys } from "../runtime-install.js";
import { remoteAuthority } from "./authority.js";
import type { DesktopHostComposition } from "../types.js";
import { remotePlatform, secureRemoteDirectory } from "./platform.js";

export interface RemoteHostOptions {
  readonly stateDirectory: string;
  readonly runtimeDirectory: string;
  readonly trustedKeysDirectory: string;
}

export interface RemoteHost {
  readonly composition: DesktopHostComposition;
  workspacePath(workspaceId: string): string;
  registerWorkspace(path: string): Promise<WorkspaceListReadModel>;
  close(): Promise<void>;
}

/** Headless composition shares domain services, never imports the Electron factory. */
export async function createRemoteHost(options: RemoteHostOptions): Promise<RemoteHost> {
  const platform = remotePlatform(process.platform);
  const stateDirectory = resolve(options.stateDirectory);
  await secureRemoteDirectory(stateDirectory);
  const registry = new WorkspaceRegistry(join(stateDirectory, "workspaces.json"));
  await registry.load();
  const log = createHostFileLog({ directory: join(stateDirectory, "logs") });
  const runtimes = createDesktopRuntimeSessionPort({ log });
  const runner = new HostProcessRunner();
  const queue = new GitWriteQueue();
  const pickDirectory = async (): Promise<undefined> => { throw new Error("Choose a remote directory with workspace.register"); };
  const git = createDesktopGitService({ registry, runner, queue, pickDirectory, preferencesPath: join(stateDirectory, "git-preferences.json") });
  const github = createDesktopGithubService({ registry, runner, queue });
  let cwd = registry.activeWorkspaceId ? registry.get(registry.activeWorkspaceId)?.canonicalPath : undefined;
  let composition: DesktopHostComposition | undefined;
  const offWorkspace = runtimes.attachWorkspaceSink?.(workspace => { cwd = workspace.cwd; });
  const workspaces = createOmpWorkspaceService({ registry, pickDirectory, onActivated: async stored => {
    cwd = stored.canonicalPath;
    await composition?.rebindWorkspace({ workspaceId: stored.workspaceId, cwd }, { launchIfMissing: false });
  } });
  const { key: authorityKey, liveness } = remoteAuthority(stateDirectory);
  const unavailable = async (): Promise<never> => { throw new Error("Desktop system actions are unavailable on this remote Host"); };
  const port: PlatformPort = {
    platform,
    appDataDirectory: async () => stateDirectory,
    runtimeExecutableName: () => platform === "win32" ? "omp.exe" : "omp",
    createPrivateEndpoint: async () => privateEndpoint(platform === "win32" ? "named-pipe" : "unix-socket", randomUUID()),
    createProcessContainment: () => ({ attach: unavailable, requestStop: unavailable, forceStop: unavailable, release: unavailable }),
    revealPath: unavailable,
    openExternal: unavailable,
  };
  const dispose = (): void => { offWorkspace?.(); runner.cancelAll(); git.dispose(); };
  try {
    const installer = await loadInstallerTrustedKeys(options.trustedKeysDirectory, { environment: false }) ?? { trustedKeys: {} };
    composition = await createDesktopHostComposition({
      platform: port,
      authorityLock: { acquire: async () => {
        if (!await liveness.acquire(authorityKey)) throw new Error("A remote Host already owns this profile");
        return { authorityId: randomUUID(), epoch: randomUUID(), release: () => liveness.release(authorityKey) };
      } },
      privateEndpoint: { createCurrentUserOnly: async () => ({ endpoint: await port.createPrivateEndpoint(stateDirectory), release: async () => {} }) },
      installer,
      managedInstall: { installDirectory: resolve(options.runtimeDirectory), trustedKeysDirectory: resolve(options.trustedKeysDirectory), environmentTrustedKeys: false, locateArtifact: async () => undefined },
      resolver: { probe: createProcessProbe() },
      runtimeSession: runtimes,
      facade: {
        hostLog: log,
        workspaces,
        workspaceFiles: createWorkspaceFileService({ registry }),
        git, github,
        catalog: createWorkspaceSessionCatalog(() => cwd, async workspaceId => registry.get(workspaceId)?.canonicalPath),
        getWorkspaceCwd: () => cwd,
        getActiveWorkspace: () => {
          const stored = registry.activeWorkspaceId ? registry.get(registry.activeWorkspaceId) : undefined;
          return stored ? { workspaceId: stored.workspaceId, cwd: stored.canonicalPath } : undefined;
        },
        resolveImportWorkspace: async workspaceId => registry.get(workspaceId)?.canonicalPath,
        registerImportedWorkspace: async path => (await registry.upsertByPath(path, undefined, undefined, false)).workspaceId,
        disposeHostOperations: dispose,
      },
    });
    const host = composition;
    return {
      composition: host,
      workspacePath(workspaceId) {
        const stored = registry.get(workspaceId);
        if (!stored) throw new Error("Unknown remote workspace");
        return stored.canonicalPath;
      },
      async registerWorkspace(path) {
        if (!isAbsolute(path)) throw new Error("Remote workspace path must be absolute on the remote system");
        const stored = await registry.upsertByPath(path, undefined, undefined, false);
        return workspaces.open({ workspaceId: stored.workspaceId as WorkspaceId });
      },
      close: () => host.shutdown(),
    };
  } catch (error) { dispose(); throw error; }
}
