/**
 * Desktop Host factory (FRONTEND_INTEGRATION.md §9.2).
 *
 * `createDesktopHostFactory` wires the real Win32 seam classes
 * (Win32PlatformPort, Win32AuthorityLock, Win32PrivateEndpoint) plus the
 * HostBackend resolver environment from injected native services, then
 * delegates to `createDesktopHostComposition`. `createProductionHostFactory`
 * supplies the production pure-Node realizations of those services so the
 * desktop Main entry stays decoupled from Win32 seam details.
 *
 * Realizations implemented here:
 * - app data directory: `%APPDATA%\omp-studio` (fallback under the user
 *   home) — the profile/state directory owned by the current user;
 * - authority lock: atomic `wx` exclusive-create, strict read and
 *   compare-and-remove over the lock file; owner liveness is a process-lifetime
 *   exclusive named pipe / unix socket. A crashed owner is treated as dead so
 *   the next instance can take over; a live owner still fails closed.
 * - private endpoint: `whoami` SID lookup, CSPRNG authority, exclusive
 *   registry reservation under `%APPDATA%\omp-studio-endpoints` and an
 *   owner-only ACL (`icacls`) on the reservation;
 * - resolver: the real `createProcessProbe` (the probe is the only runtime
 *   execution this slice performs, and only for verification).
 *
 * The Runtime session port (spawning the trusted executable, Bridge
 * bootstrap/handshake, session controller) is a Main/native seam injected
 * through `DesktopHostFactoryOptions.runtimeSession`; until it is wired the
 * production composition resolves the runtime but opens read-only.
 *
 * Secrets policy: no Bridge token, endpoint, PID/process handle or
 * executable/session path ever crosses the returned composition's public
 * surface; native values stay inside this module and the composition.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { app, dialog } from "electron";

import type { ArchId, WorkspaceId } from "@omp-studio/client-contract";
import { createOmpWorkspaceService } from "@omp-studio/host-client-api/workspaces";
import type { Win32PlatformServices, Win32AuthorityLockServices, Win32EndpointProviders } from "@omp-studio/platform-win32";
import { Win32PlatformPort, Win32AuthorityLock, Win32PrivateEndpoint } from "@omp-studio/platform-win32";
import type { DarwinPlatformServices, DarwinEndpointProviders } from "@omp-studio/platform-darwin";
import { DarwinPlatformPort, DarwinPrivateEndpoint } from "@omp-studio/platform-darwin";
import { WorkspaceRegistry, createProcessProbe, parseWindowsUserSid, type RuntimeResolverEnvironment } from "@omp-studio/studio-host";
import type { RuntimePreference } from "@omp-studio/studio-protocol";
import type { PlatformPort } from "@omp-studio/platform";

import {
  createDesktopHostComposition,
  type DesktopFacadeSeams,
  type DesktopRuntimeSessionPort,
} from "./host-composition.js";
import { createHostFileLog } from "./host-log.js";
import { createDesktopGitService } from "./git-service.js";
import { createDesktopGithubService } from "./github-service.js";
import { GitWriteQueue, HostProcessRunner } from "./git-process.js";
import { createDesktopRuntimeSessionPort } from "./runtime-session.js";
import { createWorkspaceFileService } from "./workspace-files.js";
import { packagedRuntimeInstallLayout, type DesktopManagedInstallOptions } from "./runtime-install.js";
import type { DesktopHostComposition, DesktopHostFactory } from "./types.js";

const execFileAsync = promisify(execFile);

/** Environment scope recorded in the authority lock metadata. */
const DEFAULT_ENVIRONMENT_KEY = "desktop";

/** State directory name under the user's application data root. */
const STATE_DIRECTORY_NAME = "omp-studio";

/** Endpoint reservation registry root under the user's application data root. */
const ENDPOINT_REGISTRY_DIRECTORY_NAME = "omp-studio-endpoints";

/** Injectable inputs for {@link createDesktopHostFactory} (Windows). */
export interface DesktopHostFactoryOptionsWin32 {
  readonly platform: "win32";
  /** Native platform operations backing Win32PlatformPort. */
  readonly services: Win32PlatformServices;
  /** Native filesystem/liveness/clock/random operations backing the authority lock. */
  readonly authorityLockServices: Win32AuthorityLockServices;
  /** Native SID/authority/reservation/ACL operations backing Win32PrivateEndpoint. */
  readonly endpointProviders: Win32EndpointProviders;
  /** Environment scope recorded in the lock metadata; defaults to "desktop". */
  readonly environmentKey?: string;
  /** Resolver environment injected into HostBackend (probe included). */
  readonly resolver?: Omit<RuntimeResolverEnvironment, "managedLookup">;
  /** Runtime resolution preference; defaults to `{ kind: "managed" }`. */
  readonly preference?: RuntimePreference;
  /** Client-visible arch; defaults from the running process. */
  readonly arch?: ArchId;
  /** Runtime start/stop port; absent means the composition stays read-only. */
  readonly runtimeSession?: DesktopRuntimeSessionPort;
  /** When set, wires a real `runtime.install` against local signed artifacts. */
  readonly managedInstall?: DesktopManagedInstallOptions;
  /** Facade seam providers; absent slots fail closed. */
  readonly facade?: DesktopFacadeSeams;
}

/** Injectable inputs for {@link createDesktopHostFactory} (macOS). */
export interface DesktopHostFactoryOptionsDarwin {
  readonly platform: "darwin";
  /** Native platform operations backing DarwinPlatformPort. */
  readonly services: DarwinPlatformServices;
  /** Native filesystem/liveness/clock/random operations backing the authority lock. */
  readonly authorityLockServices: Win32AuthorityLockServices;
  /** Native authority/reservation/permission operations backing DarwinPrivateEndpoint. */
  readonly endpointProviders: DarwinEndpointProviders;
  /** Environment scope recorded in the lock metadata; defaults to "desktop". */
  readonly environmentKey?: string;
  /** Resolver environment injected into HostBackend (probe included). */
  readonly resolver?: Omit<RuntimeResolverEnvironment, "managedLookup">;
  /** Runtime resolution preference; defaults to `{ kind: "managed" }`. */
  readonly preference?: RuntimePreference;
  /** Client-visible arch; defaults from the running process. */
  readonly arch?: ArchId;
  /** Runtime start/stop port; absent means the composition stays read-only. */
  readonly runtimeSession?: DesktopRuntimeSessionPort;
  /** When set, wires a real `runtime.install` against local signed artifacts. */
  readonly managedInstall?: DesktopManagedInstallOptions;
  /** Facade seam providers; absent slots fail closed. */
  readonly facade?: DesktopFacadeSeams;
}

/** Injectable inputs for {@link createDesktopHostFactory}. */
export type DesktopHostFactoryOptions = DesktopHostFactoryOptionsWin32 | DesktopHostFactoryOptionsDarwin;

/**
 * Wires the real platform seam classes around the injected native services and
 * delegates composition to {@link createDesktopHostComposition}.
 */
export function createDesktopHostFactory(options: DesktopHostFactoryOptions): DesktopHostFactory {
  return {
    async create(): Promise<DesktopHostComposition> {
      let platform: PlatformPort;
      let authorityLock: any;
      let privateEndpoint: any;

      if (options.platform === "win32") {
        platform = new Win32PlatformPort(options.services);
        const profileDirectory = await platform.appDataDirectory();
        // The production authority lock creates its metadata file directly
        // with `wx`; provision the per-user profile directory first.
        await mkdir(profileDirectory, { recursive: true });
        authorityLock = new Win32AuthorityLock({
          profileDirectory,
          environmentKey: options.environmentKey ?? DEFAULT_ENVIRONMENT_KEY,
          services: options.authorityLockServices,
        });
        privateEndpoint = new Win32PrivateEndpoint(options.endpointProviders);
      } else {
        platform = new DarwinPlatformPort(options.services);
        const profileDirectory = await platform.appDataDirectory();
        await mkdir(profileDirectory, { recursive: true });
        authorityLock = new Win32AuthorityLock({
          profileDirectory,
          environmentKey: options.environmentKey ?? DEFAULT_ENVIRONMENT_KEY,
          services: options.authorityLockServices,
        });
        privateEndpoint = new DarwinPrivateEndpoint(options.endpointProviders);
      }

      return await createDesktopHostComposition({
        platform,
        authorityLock,
        privateEndpoint,
        ...(options.runtimeSession === undefined ? {} : { runtimeSession: options.runtimeSession }),
        ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
        ...(options.preference === undefined ? {} : { preference: options.preference }),
        ...(options.arch === undefined ? {} : { arch: options.arch }),
        ...(options.managedInstall === undefined ? {} : { managedInstall: options.managedInstall }),
        ...(options.facade === undefined ? {} : { facade: options.facade }),
      });
    },
  };
}

/** User application-data root shared by the production services. */
function userAppDataRoot(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
}

/** Production workspace registry path (paths live only in the Host). */
function productionWorkspaceRegistryPath(): string {
  return join(userAppDataRoot(), STATE_DIRECTORY_NAME, "workspaces.json");
}

/** Production system directory picker; `undefined` = user cancelled. */
function createProductionPickDirectory(): () => Promise<string | undefined> {
  return async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "打开本地文件夹",
    });
    if (result.canceled || result.filePaths[0] === undefined) {
      return undefined;
    }
    return result.filePaths[0];
  };
}

/** Production pure-Node realizations of the native platform operations (Windows). */
function createProductionWin32PlatformServices(): Win32PlatformServices {
  return {
    async appDataDirectory(): Promise<string> {
      return join(userAppDataRoot(), STATE_DIRECTORY_NAME);
    },
    async createCurrentUserOnlyEndpoint(profileDirectory: string): Promise<string> {
      // PlatformPort path: reserve a fresh authority in the shared registry
      // and apply the owner-only ACL, mirroring Win32PrivateEndpoint's flow.
      const providers = createProductionWin32EndpointProviders();
      const sid = await providers.currentUserSid();
      const authority = await providers.generateEndpointAuthority();
      const reserved = await providers.reserveEndpoint(authority, profileDirectory);
      if (!reserved) {
        throw new Error("private endpoint reservation collided; failing closed");
      }
      try {
        await providers.applyOwnerOnlyAcl(authority, sid);
      } catch (error) {
        await bestEffort(() => providers.releaseEndpoint(authority));
        throw error;
      }
      return authority;
    },
    async revealInExplorer(path: string): Promise<void> {
      await execFileAsync("explorer.exe", [`/select,${path}`]);
    },
    async openExternal(url: string): Promise<void> {
      await execFileAsync("explorer.exe", [url]);
    },
    // Runtime containment is a native (Job Object) milestone; nothing in P1
    // spawns a session runtime, so these fail explicitly rather than pretend
    // to contain a process they cannot control.
    async attachProcess(): Promise<void> {
      throw new Error("native process containment is not wired in this build");
    },
    async requestProcessStop(): Promise<void> {
      throw new Error("native process containment is not wired in this build");
    },
    async forceProcessStop(): Promise<void> {
      throw new Error("native process containment is not wired in this build");
    },
    async releaseProcess(): Promise<void> {
      throw new Error("native process containment is not wired in this build");
    },
  };
}

/** Production pure-Node realizations of the native platform operations (macOS). */
function createProductionDarwinPlatformServices(): DarwinPlatformServices {
  return {
    async appDataDirectory(): Promise<string> {
      return join(userAppDataRoot(), STATE_DIRECTORY_NAME);
    },
    async createCurrentUserOnlyEndpoint(profileDirectory: string): Promise<string> {
      // PlatformPort path: reserve a fresh authority in the shared registry
      // and apply owner-only permissions, mirroring DarwinPrivateEndpoint's flow.
      const providers = createProductionDarwinEndpointProviders();
      const authority = await providers.generateEndpointAuthority();
      const reserved = await providers.reserveEndpoint(authority, profileDirectory);
      if (!reserved) {
        throw new Error("private endpoint reservation collided; failing closed");
      }
      try {
        await providers.applyOwnerOnlyPermissions(authority);
      } catch (error) {
        await bestEffort(() => providers.releaseEndpoint(authority));
        throw error;
      }
      return authority;
    },
    async revealInFinder(path: string): Promise<void> {
      await execFileAsync("open", ["-R", path]);
    },
    async openExternal(url: string): Promise<void> {
      await execFileAsync("open", [url]);
    },
    // Runtime containment is a native milestone; nothing in P1
    // spawns a session runtime, so these fail explicitly rather than pretend
    // to contain a process they cannot control.
    async attachProcess(): Promise<void> {
      throw new Error("native process containment is not wired in this build");
    },
    async requestProcessStop(): Promise<void> {
      throw new Error("native process containment is not wired in this build");
    },
    async forceProcessStop(): Promise<void> {
      throw new Error("native process containment is not wired in this build");
    },
    async releaseProcess(): Promise<void> {
      throw new Error("native process containment is not wired in this build");
    },
  };
}

/**
 * Process-lifetime exclusive listener proving the current owner is alive.
 * Windows uses a named pipe; POSIX uses a temp-dir unix socket. Crash or
 * process exit releases the address automatically, so a leftover metadata
 * file is no longer treated as a live owner.
 */
const liveProofs = new Map<string, Server>();

function liveProofAddress(environmentKey: string): string {
  const safe = environmentKey.replace(/[^A-Za-z0-9._-]/gu, "_");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\omp-studio-authority-${safe}`;
  }
  return join(tmpdir(), `omp-studio-authority-${safe}.sock`);
}

function environmentKeyFromLockContent(content: string): string {
  const parsed = JSON.parse(content) as { environmentKey?: unknown };
  if (typeof parsed.environmentKey !== "string" || parsed.environmentKey.length === 0) {
    throw new Error("authority lock content is missing environmentKey");
  }
  return parsed.environmentKey;
}

function listenExclusive(address: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const fail = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once("error", fail);
    server.listen(address, () => {
      server.off("error", fail);
      resolve(server);
    });
  });
}

async function acquireLiveProof(environmentKey: string): Promise<boolean> {
  const address = liveProofAddress(environmentKey);
  if (liveProofs.has(address)) {
    return true;
  }
  try {
    liveProofs.set(address, await listenExclusive(address));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      return false;
    }
    throw error;
  }
}

async function releaseLiveProof(environmentKey: string): Promise<void> {
  const address = liveProofAddress(environmentKey);
  const server = liveProofs.get(address);
  if (server === undefined) {
    return;
  }
  liveProofs.delete(address);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (process.platform !== "win32") {
    await bestEffort(() => unlink(address));
  }
}

async function isLiveProofHeld(environmentKey: string): Promise<boolean> {
  const address = liveProofAddress(environmentKey);
  if (liveProofs.has(address)) {
    return true;
  }
  try {
    const probe = await listenExclusive(address);
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });
    if (process.platform !== "win32") {
      await bestEffort(() => unlink(address));
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      return true;
    }
    throw error;
  }
}

/** Production authority lock services over the profile lock file. */
function createProductionAuthorityLockServices(): Win32AuthorityLockServices {
  return {
    async createExclusive(lockFilePath: string, content: string): Promise<boolean> {
      let handle: FileHandle;
      try {
        handle = await open(lockFilePath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return false;
        }
        throw error;
      }
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
      const environmentKey = environmentKeyFromLockContent(content);
      if (!(await acquireLiveProof(environmentKey))) {
        await bestEffort(() => unlink(lockFilePath));
        return false;
      }
      return true;
    },
    async read(lockFilePath: string): Promise<string | null> {
      try {
        return await readFile(lockFilePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    async compareAndRemove(lockFilePath: string, expectedContent: string): Promise<boolean> {
      let current: string;
      try {
        current = await readFile(lockFilePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
      if (current !== expectedContent) {
        return false;
      }
      try {
        await unlink(lockFilePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
      await releaseLiveProof(environmentKeyFromLockContent(expectedContent));
      return true;
    },
    async isOwnerAlive(metadata): Promise<boolean> {
      return isLiveProofHeld(metadata.environmentKey);
    },
    nowIso: () => new Date().toISOString(),
    randomId: () => randomBytes(16).toString("base64url"),
  };
}

/** Production private-endpoint providers over the shared reservation registry (Windows). */
function createProductionWin32EndpointProviders(): Win32EndpointProviders {
  const registryRoot = (): string => join(userAppDataRoot(), ENDPOINT_REGISTRY_DIRECTORY_NAME);
  const reservationPath = (authority: string): string => join(registryRoot(), authority);
  return {
    async currentUserSid(): Promise<string> {
      const whoami = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
      const { stdout } = await execFileAsync(whoami, ["/user", "/fo", "csv", "/nh"]);
      return parseWindowsUserSid(stdout);
    },
    generateEndpointAuthority: () => randomBytes(24).toString("base64url"),
    async reserveEndpoint(authority: string, profileDirectory: string): Promise<boolean> {
      const path = reservationPath(authority);
      try {
        await mkdir(registryRoot(), { recursive: true });
        await mkdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return false;
        }
        throw error;
      }
      try {
        await writeFile(join(path, "reservation.json"), JSON.stringify({ profileDirectory, createdAt: new Date().toISOString() }), {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error) {
        await bestEffort(() => rm(path, { recursive: true, force: true }));
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return false;
        }
        throw error;
      }
      return true;
    },
    async applyOwnerOnlyAcl(authority: string, sid: string): Promise<void> {
      // The reservation registry entry is the owned resource; the runtime
      // pipe itself inherits current-user protection from the spawning user.
      const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
      await execFileAsync(icacls, [reservationPath(authority), "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`]);
    },
    async releaseEndpoint(authority: string): Promise<void> {
      try {
        await rm(reservationPath(authority), { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    },
  };
}

/** Production private-endpoint providers over the shared reservation registry (macOS). */
function createProductionDarwinEndpointProviders(): DarwinEndpointProviders {
  const registryRoot = (): string => join(userAppDataRoot(), ENDPOINT_REGISTRY_DIRECTORY_NAME);
  const reservationPath = (authority: string): string => join(registryRoot(), authority);
  return {
    generateEndpointAuthority: () => randomBytes(24).toString("base64url"),
    async reserveEndpoint(authority: string, profileDirectory: string): Promise<boolean> {
      const path = reservationPath(authority);
      try {
        await mkdir(registryRoot(), { recursive: true, mode: 0o700 });
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return false;
        }
        throw error;
      }
      try {
        await writeFile(join(path, "reservation.json"), JSON.stringify({ profileDirectory, createdAt: new Date().toISOString() }), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await bestEffort(() => rm(path, { recursive: true, force: true }));
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return false;
        }
        throw error;
      }
      return true;
    },
    async applyOwnerOnlyPermissions(authority: string): Promise<void> {
      // The reservation registry entry is the owned resource with 0700 permissions
      // already applied during mkdir. No additional chmod needed.
    },
    async releaseEndpoint(authority: string): Promise<void> {
      try {
        await rm(reservationPath(authority), { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    },
  };
}

/** Packaged extraFiles layout; unpackaged keeps AppData runtimes + repo artifact discovery. */
function productionManagedInstall(): DesktopManagedInstallOptions {
  const layout = packagedRuntimeInstallLayout({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
  });
  return {
    seedOnStart: true,
    ...(layout === undefined
      ? {}
      : {
          installDirectory: layout.installDirectory,
          artifactRoot: layout.artifactRoot,
          trustedKeysDirectory: layout.keysDirectory,
        }),
  };
}

export interface ProductionDesktopHostFactory extends DesktopHostFactory {
  /** Resolve an opaque workspaceId to its Host-owned canonical cwd. */
  resolveWorkspaceCwd(workspaceId: string): Promise<string>;
  /** Current active workspace cwd, used by the local PTY manager. */
  activeWorkspaceCwd(): string | undefined;
}

/**
 * Production factory plus the narrow Main-only workspace lookup used by
 * Desktop chrome (external editor / file manager / local terminal cwd).
 * These methods stay in the Main process and never cross the Host facade.
 * Packaged builds keep the live `omp.exe` under `$INSTDIR\runtime`.
 */
export function createProductionHostFactory(options?: {
  readonly openUrl?: (url: string) => Promise<void>;
  readonly revealDirectory?: (absDir: string) => Promise<void>;
}): ProductionDesktopHostFactory {
  const registry = new WorkspaceRegistry(productionWorkspaceRegistryPath());
  let registryReady: Promise<void> | undefined;
  const ensureRegistry = (): Promise<void> => {
    registryReady ??= registry.load();
    return registryReady;
  };
  const pickDirectory = createProductionPickDirectory();
  const hostLog = createHostFileLog({
    directory: join(userAppDataRoot(), STATE_DIRECTORY_NAME, "logs"),
  });
  const runtimeSession = createDesktopRuntimeSessionPort({ log: hostLog });
  const gitProcessRunner = new HostProcessRunner();
  const gitWriteQueue = new GitWriteQueue();
  const git = createDesktopGitService({
    registry,
    pickDirectory,
    preferencesPath: join(userAppDataRoot(), STATE_DIRECTORY_NAME, "git-preferences.json"),
    runner: gitProcessRunner,
    queue: gitWriteQueue,
  });
  const github = createDesktopGithubService({ registry, runner: gitProcessRunner, queue: gitWriteQueue });
  let activeComposition: DesktopHostComposition | undefined;
  const workspaceCwd: { current: string | undefined } = { current: undefined };
  const innerWorkspaces = createOmpWorkspaceService({
    registry,
    pickDirectory,
    onActivated: async (stored) => {
      workspaceCwd.current = stored.canonicalPath;
      await activeComposition?.rebindWorkspace({
        workspaceId: stored.workspaceId,
        cwd: stored.canonicalPath,
      });
    },
  });
  const workspaces = {
    list: () => innerWorkspaces.list(),
    pick: (input?: { readonly name?: string }) => innerWorkspaces.pick(input),
    async open(input: { readonly workspaceId: WorkspaceId }) {
      const alreadyActive = registry.activeWorkspaceId === input.workspaceId;
      const runtimeBound = activeComposition?.status === "ready";
      const model = await innerWorkspaces.open(input);
      if (alreadyActive && !runtimeBound) {
        const stored = registry.get(input.workspaceId);
        if (stored !== undefined) {
          workspaceCwd.current = stored.canonicalPath;
          await activeComposition?.rebindWorkspace({
            workspaceId: stored.workspaceId,
            cwd: stored.canonicalPath,
          });
        }
      }
      return model;
    },
  };
  const facade: DesktopFacadeSeams = {
    hostLog,
    ...(options?.openUrl === undefined ? {} : { openUrl: options.openUrl }),
    ...(options?.revealDirectory === undefined ? {} : { revealDirectory: options.revealDirectory }),
    workspaces,
    workspaceFiles: createWorkspaceFileService({ registry }),
    git,
    github,
    disposeHostOperations: () => {
      gitProcessRunner.cancelAll();
      git.dispose();
    },
    getWorkspaceCwd: () => workspaceCwd.current,
    getActiveWorkspace: () => {
      const activeId = registry.activeWorkspaceId;
      if (activeId === undefined) {
        return undefined;
      }
      const stored = registry.get(activeId);
      if (stored === undefined) {
        return undefined;
      }
      return { workspaceId: stored.workspaceId, cwd: stored.canonicalPath };
    },
  };
  const baseOptions = {
    authorityLockServices: createProductionAuthorityLockServices(),
    resolver: { probe: createProcessProbe() },
    runtimeSession,
    managedInstall: productionManagedInstall(),
    facade,
  };
  const factory = createDesktopHostFactory({
    ...(process.platform === "darwin"
      ? {
          platform: "darwin" as const,
          services: createProductionDarwinPlatformServices(),
          endpointProviders: createProductionDarwinEndpointProviders(),
        }
      : {
          platform: "win32" as const,
          services: createProductionWin32PlatformServices(),
          endpointProviders: createProductionWin32EndpointProviders(),
        }),
    ...baseOptions,
  });
  return {
    async create(): Promise<DesktopHostComposition> {
      // The registry file is loaded once, before the first composition can
      // serve any renderer query.
      await ensureRegistry();
      const activeId = registry.activeWorkspaceId;
      if (activeId !== undefined) {
        const stored = registry.list().find((entry) => entry.workspaceId === activeId);
        if (stored !== undefined) workspaceCwd.current = stored.canonicalPath;
      }
      const composition = await factory.create();
      activeComposition = composition;
      return composition;
    },
    async resolveWorkspaceCwd(workspaceId: string): Promise<string> {
      await ensureRegistry();
      const stored = registry.get(workspaceId);
      if (stored === undefined) {
        throw new Error(`desktop workspace shell: unknown workspace id ${workspaceId}`);
      }
      return stored.canonicalPath;
    },
    activeWorkspaceCwd(): string | undefined {
      return workspaceCwd.current;
    },
  };
}

async function bestEffort(run: () => void | Promise<void>): Promise<void> {
  try {
    // Normalize sync seam callbacks (void) to a promise so cleanup failures
    // stay caught here; the caller rethrows the original failure.
    await Promise.resolve(run());
  } catch {
    // Cleanup must not mask the original failure.
  }
}
