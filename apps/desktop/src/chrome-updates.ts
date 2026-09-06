import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type RuntimeInstallationManifest,
  STUDIO_PROTOCOL_VERSION,
} from "@omp-studio/studio-protocol";
import {
  AppPayloadInstaller,
  RUNTIME_ARTIFACT_LAYOUT,
  parseRuntimeInstallationManifest,
  sha256File,
  verifySignedArtifact,
} from "@omp-studio/runtime-installer";

import {
  assertFreeSpace,
  createProgressThrottle,
  downloadOne,
} from "./artifact-download.js";
import { DEFAULT_GITHUB_REPO } from "./chrome-app-update.js";
import { extractTarGz } from "./tar-gz.js";
import {
  CHROME_UPDATES_CHANNELS,
  parseChromeUpdatesCancelInput,
  parseChromeUpdatesImportInput,
  parseChromeUpdatesPrefsSetInput,
  type UpdateApplyResult,
  type UpdateCheckResult,
  type UpdateImportResult,
  type UpdateStartResult,
} from "./chrome-updates-shared.js";
import {
  compareRuntimeVersions,
  type PendingArtifactRegistry,
} from "./runtime-install.js";
import {
  EXPECTED_NODE_PTY_VERSION,
  applyMirror,
  fetchUpdateIndex,
  planAppUpdate,
  planRuntimeUpdate,
  type UpdateIndex,
} from "./update-index.js";
import type { UpdatePrefs } from "./update-prefs-store.js";

export interface ChromeUpdatesSender {
  isDestroyed(): boolean;
  getURL(): string;
}

export interface ChromeUpdatesIpcMain {
  handle(
    channel: string,
    listener: (event: { sender: ChromeUpdatesSender }, payload?: unknown) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface OpenDialogOptionsLike {
  title?: string;
  properties?: Array<
    | "openFile"
    | "openDirectory"
    | "multiSelections"
    | "showHiddenFiles"
    | "createDirectory"
    | "promptToCreate"
    | "noResolveAliases"
    | "treatPackageAsDirectory"
    | "dontAddToRecent"
  >;
  filters?: Array<{ name: string; extensions: string[] }>;
  defaultPath?: string;
}

export interface ChromeUpdatesIpcOptions {
  readonly ipcMain: ChromeUpdatesIpcMain;
  readonly isTrustedSender: (sender: ChromeUpdatesSender) => boolean;
  readonly send: (channel: string, payload: unknown) => void;
  readonly prefs: {
    read(): Promise<UpdatePrefs>;
    write(patch: Partial<UpdatePrefs>): Promise<UpdatePrefs>;
  };
  readonly stagingRoot: string;
  readonly trustedKeys: Readonly<Record<string, string | Buffer>>;
  readonly platform: string;
  readonly pendingArtifact: PendingArtifactRegistry;
  readonly showOpenDialog: (options: OpenDialogOptionsLike) => Promise<{ canceled: boolean; filePaths: string[] }>;
  readonly fetcher?: typeof fetch | undefined;
  readonly repo?: string | undefined;
  readonly appVersion?: string | undefined;
  readonly bundledAppVersion?: string | undefined;
  readonly payloadVersion?: string | undefined;
  readonly runtime?: { readonly electron: string; readonly modules: string; readonly nodePty: string } | undefined;
  readonly studioProtocol?: number | undefined;
  readonly getInstalledRuntimeVersion?: (() => Promise<string | undefined>) | undefined;
  readonly appPayloadInstaller?: AppPayloadInstaller | undefined;
  readonly isBusy?: (() => boolean) | undefined;
  readonly relaunch?: ((options?: { args?: string[] }) => void) | undefined;
  readonly quit?: (() => void) | undefined;
  readonly openPath?: ((path: string) => Promise<string>) | undefined;
  readonly rollbackRuntime?: (() => Promise<void>) | undefined;
  readonly pruneRuntimes?: (() => Promise<void>) | undefined;
}

export interface ChromeUpdatesIpcHandle {
  dispose(): void;
}

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[A-Za-z]:[\\/][^\s"'<>|:?*]*/g, "[path]")
    .replace(/(?:^|\s)\/[^\s"'<>|:?*]+/g, " [path]");
}

async function runStartupGc(
  stagingRoot: string,
  getInstalledRuntimeVersion?: (() => Promise<string | undefined>) | undefined,
): Promise<void> {
  try {
    const runtimeRoot = join(stagingRoot, "runtime");
    const entries = await readdir(runtimeRoot, { withFileTypes: true }).catch(() => []);
    const installed = await getInstalledRuntimeVersion?.().catch(() => undefined);
    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(runtimeRoot, entry.name);
      let shouldDelete = false;

      try {
        const st = await stat(dirPath);
        if (now - st.mtimeMs > SEVEN_DAYS_MS) {
          shouldDelete = true;
        }
      } catch {
        // ignore
      }

      if (!shouldDelete && installed !== undefined) {
        const cmp = compareRuntimeVersions(entry.name, installed);
        if (cmp !== undefined && cmp <= 0) {
          shouldDelete = true;
        }
      }

      if (shouldDelete) {
        await rm(dirPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    // GC failure is silent
  }
}

export function registerChromeUpdatesIpc(options: ChromeUpdatesIpcOptions): ChromeUpdatesIpcHandle {
  const ipc = options.ipcMain;
  let cachedIndex: UpdateIndex | undefined;
  let cachedCanaryIndex: UpdateIndex | undefined;
  let activeJob: { jobId: string; kind: "app" | "runtime"; abortController: AbortController } | null = null;
  let pendingAppPayloadVersion: string | undefined = undefined;
  let pendingInstaller: { path: string; size: number; sha256: string } | undefined;
  let pendingAppJobId: string | undefined;
  let pendingRuntimeJobId: string | undefined;
  let applying = false;

  const startupGc = runStartupGc(options.stagingRoot, options.getInstalledRuntimeVersion);

  const loadIndex = async (prefs: UpdatePrefs, signal?: AbortSignal, channel: "stable" | "canary" = "stable"): Promise<UpdateIndex> => {
    const index = await fetchUpdateIndex({
      repo: options.repo ?? DEFAULT_GITHUB_REPO,
      mirrorPrefix: prefs.mirrorPrefix,
      trustedKeys: options.trustedKeys,
      lastSequence: channel === "canary" ? prefs.lastCanaryIndexSequence ?? 0 : prefs.lastIndexSequence,
      channel,
      arch: options.platform.endsWith("-arm64") ? "arm64" : "x64",
      fetcher: options.fetcher,
      signal,
    });
    signal?.throwIfAborted();
    const saved = await options.prefs.write(channel === "canary"
      ? { lastCanaryIndexSequence: index.sequence } : { lastIndexSequence: index.sequence });
    if (index.sequence < (channel === "canary" ? saved.lastCanaryIndexSequence ?? 0 : saved.lastIndexSequence)) throw new Error("Update index is older than local watermark");
    if (channel === "canary") cachedCanaryIndex = index;
    else cachedIndex = index;
    return index;
  };

  const removeAll = (): void => {
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.versionGet);
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.check);
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.startApp);
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.startRuntime);
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.importLocal);
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.cancel);
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.apply);
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.rollback);
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.rollbackRuntime);
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.pruneRuntime);
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.prefsGet);
    ipc.removeHandler(CHROME_UPDATES_CHANNELS.prefsSet);
  };

  removeAll();

  ipc.handle(CHROME_UPDATES_CHANNELS.versionGet, (event) => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) return null;
    return { version: options.appVersion, bundledVersion: options.bundledAppVersion ?? options.appVersion, payloadVersion: options.payloadVersion };
  });

  ipc.handle(CHROME_UPDATES_CHANNELS.check, async (event): Promise<UpdateCheckResult | null> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
      return null;
    }
    try {
      const prefs = await options.prefs.read();
      const index = await loadIndex(prefs);

      const currentAppVersion = options.appVersion ?? "0.1.3";
      const runtimeAbi = options.runtime ?? {
        electron: process.versions.electron,
        modules: process.versions.modules,
        nodePty: EXPECTED_NODE_PTY_VERSION,
      };
      const studioProtocol = options.studioProtocol ?? STUDIO_PROTOCOL_VERSION;
      const installedRuntimeVersion = await options.getInstalledRuntimeVersion?.();

      const appPlan = planAppUpdate({
        index,
        currentAppVersion,
        bundledAppVersion: options.bundledAppVersion,
        runtime: runtimeAbi,
        platform: options.platform,
        skippedVersion: prefs.skippedAppVersion,
        preferHot: prefs.preferHotUpdate,
      });

      let runtimeIndex = index;
      let runtimeError: string | undefined;
      if (prefs.runtimeChannel === "canary") {
        try { runtimeIndex = await loadIndex(prefs, undefined, "canary"); }
        catch (error) { runtimeError = sanitizeErrorMessage(error); }
      }
      const runtimePlan = planRuntimeUpdate({
        index: runtimeIndex,
        installedRuntimeVersion,
        channel: prefs.runtimeChannel,
        platform: options.platform,
        appVersion: options.bundledAppVersion ?? currentAppVersion,
        studioProtocol,
      });

      const appResult: UpdateCheckResult["app"] =
        appPlan.kind === "none"
          ? { plan: "none" }
          : appPlan.kind === "hot"
            ? {
                plan: "hot",
                version: appPlan.version,
                sizeBytes: appPlan.payload.size,
                releaseNotesUrl: index.app.releaseNotesUrl,
              }
            : {
                plan: "full",
                version: appPlan.version,
                reason: appPlan.reason,
                sizeBytes: appPlan.setup.size,
                releaseNotesUrl: index.app.releaseNotesUrl,
              };

      const runtimeResult: UpdateCheckResult["runtime"] =
        runtimeError !== undefined ? { plan: "blocked", reason: runtimeError } : runtimePlan.kind === "none"
          ? { plan: "none" }
          : runtimePlan.kind === "available"
            ? {
                plan: "available",
                runtimeVersion: runtimePlan.runtimeVersion,
                sizeBytes: runtimePlan.totalBytes,
              }
            : {
                plan: "blocked",
                reason: runtimePlan.reason,
              };

      return {
        checkedAt: new Date().toISOString(),
        app: { ...appResult, currentVersion: currentAppVersion, bundledVersion: options.bundledAppVersion ?? currentAppVersion },
        runtime: runtimeResult,
      };
    } catch (error) {
      return {
        checkedAt: new Date().toISOString(),
        app: { plan: "none", currentVersion: options.appVersion, bundledVersion: options.bundledAppVersion },
        runtime: { plan: "none" },
        error: sanitizeErrorMessage(error),
      };
    }
  });

  ipc.handle(CHROME_UPDATES_CHANNELS.startApp, async (event): Promise<UpdateStartResult> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
      return { ok: false, message: "Untrusted sender" };
    }

    if (activeJob !== null || applying) {
      return { ok: false, message: "已有正在进行的更新任务" };
    }

    // Claim the job slot immediately to prevent concurrent startApp calls
    // from passing the concurrency check during the async fetchUpdateIndex.
    const jobId = `app-${randomUUID()}`;
    const abortController = new AbortController();
    activeJob = { jobId, kind: "app", abortController };

    let currentPrefs: UpdatePrefs;
    let index: UpdateIndex;
    try {
      currentPrefs = await options.prefs.read();
      index = await loadIndex(currentPrefs, abortController.signal);
      abortController.signal.throwIfAborted();
    } catch (error) {
      activeJob = null;
      return { ok: false, message: sanitizeErrorMessage(error) };
    }

    const currentAppVersion = options.appVersion ?? "0.0.0";
    const runtimeAbi = options.runtime ?? {
      electron: process.versions.electron,
      modules: process.versions.modules,
      nodePty: EXPECTED_NODE_PTY_VERSION,
    };

    const plan = planAppUpdate({
      index,
      currentAppVersion,
      bundledAppVersion: options.bundledAppVersion,
      runtime: runtimeAbi,
      platform: options.platform,
      skippedVersion: currentPrefs.skippedAppVersion,
      preferHot: currentPrefs.preferHotUpdate,
    });

    if (plan.kind === "none" || (plan.kind === "hot" && !options.appPayloadInstaller) || (plan.kind === "full" && !options.openPath)) {
      activeJob = null;
      return {
        ok: false,
        message: plan.kind === "none" ? "当前无可用的应用更新" : "应用更新安装器不可用",
      };
    }

    const payloadInfo = plan.kind === "hot" ? plan.payload : plan.setup;
    const targetVersion = plan.version;

    void (async () => {
      let throttle: ReturnType<typeof createProgressThrottle> | undefined;
      try {
        await startupGc;
        abortController.signal.throwIfAborted();
        const stagingVerDir = join(options.stagingRoot, "app", targetVersion);
        const tarGzPath = join(stagingVerDir, plan.kind === "hot" ? "payload.tar.gz" : "setup.exe");
        const treeDir = join(stagingVerDir, "tree");

        await mkdir(stagingVerDir, { recursive: true });
        await assertFreeSpace(options.stagingRoot, payloadInfo.size * 3);

        throttle = createProgressThrottle((receivedBytes, totalBytes) => {
          if (abortController.signal.aborted) return;
          options.send(CHROME_UPDATES_CHANNELS.progress, {
            jobId,
            kind: "app",
            phase: "downloading",
            step: 1,
            steps: 3,
            receivedBytes,
            totalBytes,
            message: "正在下载应用更新...",
          });
        });

        const payloadUrl = applyMirror(currentPrefs.mirrorPrefix, payloadInfo.url);
        await downloadOne({
          url: payloadUrl,
          destination: tarGzPath,
          expectedSha256: payloadInfo.sha256,
          expectedSize: payloadInfo.size,
          signal: abortController.signal,
          onProgress: throttle.report,
          fetcher: options.fetcher,
        });
        throttle.flush();
        abortController.signal.throwIfAborted();

        options.send(CHROME_UPDATES_CHANNELS.progress, {
          jobId,
          kind: "app",
          phase: "verifying",
          step: 2,
          steps: 3,
          message: "正在解压并校验负载签名...",
        });

        if (plan.kind === "hot") {
          await rm(treeDir, { recursive: true, force: true });
          await mkdir(treeDir, { recursive: true });
          await extractTarGz(tarGzPath, treeDir, undefined, abortController.signal);
          abortController.signal.throwIfAborted();
          const manifest = await options.appPayloadInstaller!.install(treeDir);
          abortController.signal.throwIfAborted();
          if (manifest.payloadVersion !== targetVersion || manifest.platform !== plan.payload.platform || manifest.payloadFormat !== plan.payload.payloadFormat || manifest.clientContractVersion !== plan.payload.clientContractVersion || manifest.studioProtocol.min !== plan.payload.studioProtocol.min || manifest.studioProtocol.max !== plan.payload.studioProtocol.max || manifest.abi.electron !== plan.payload.abi.electron || manifest.abi.modules !== plan.payload.abi.modules || manifest.abi.nodePty !== plan.payload.abi.nodePty) {
            throw new Error("App payload manifest does not match signed update index");
          }
          pendingAppPayloadVersion = manifest.payloadVersion;
          pendingInstaller = undefined;
        } else {
          pendingInstaller = { path: tarGzPath, size: payloadInfo.size, sha256: payloadInfo.sha256 };
          pendingAppPayloadVersion = undefined;
        }
        pendingAppJobId = jobId;

        options.send(CHROME_UPDATES_CHANNELS.progress, {
          jobId,
          kind: "app",
          phase: "awaiting-apply",
          step: 3,
          steps: 3,
          message: "应用负载已就绪，等待重启应用",
        });
      } catch (error) {
        const sanitized = sanitizeErrorMessage(error);
        options.send(CHROME_UPDATES_CHANNELS.progress, {
          jobId,
          kind: "app",
          phase: abortController.signal.aborted ? "cancelled" : "failed",
          step: 1,
          steps: 3,
          message: sanitized,
        });
      } finally {
        throttle?.dispose();
        if (activeJob?.jobId === jobId) activeJob = null;
      }
    })();

    return { ok: true, jobId };
  });

  ipc.handle(CHROME_UPDATES_CHANNELS.startRuntime, async (event): Promise<UpdateStartResult> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
      return { ok: false, message: "Untrusted sender" };
    }

    if (activeJob !== null || applying) {
      return { ok: false, message: "已有正在进行的更新任务" };
    }

    const jobId = randomUUID();
    const abortController = new AbortController();
    activeJob = { jobId, kind: "runtime", abortController };

    void (async () => {
      let throttle: ReturnType<typeof createProgressThrottle> | undefined;
      try {
        await startupGc;
        abortController.signal.throwIfAborted();
        const prefs = await options.prefs.read();
        let index = prefs.runtimeChannel === "canary" ? cachedCanaryIndex : cachedIndex;
        const watermark = prefs.runtimeChannel === "canary" ? prefs.lastCanaryIndexSequence ?? 0 : prefs.lastIndexSequence;
        if (index === undefined || index.sequence < watermark || index.runtime.channel !== prefs.runtimeChannel) {
          index = await loadIndex(prefs, abortController.signal, prefs.runtimeChannel);
        }

        const currentAppVersion = options.appVersion ?? "0.1.3";
        const studioProtocol = options.studioProtocol ?? STUDIO_PROTOCOL_VERSION;
        const installedRuntimeVersion = await options.getInstalledRuntimeVersion?.();

        const runtimePlan = planRuntimeUpdate({
          index,
          installedRuntimeVersion,
          channel: prefs.runtimeChannel,
          platform: options.platform,
          appVersion: options.bundledAppVersion ?? currentAppVersion,
          studioProtocol,
        });

        if (runtimePlan.kind !== "available") {
          const reason =
            runtimePlan.kind === "blocked" ? `更新被阻止: ${runtimePlan.reason}` : "当前已是最新版本";
          options.send(CHROME_UPDATES_CHANNELS.progress, {
            jobId,
            kind: "runtime",
            phase: "failed",
            step: 0,
            steps: 3,
            message: reason,
          });
          return;
        }

        const targetDir = join(options.stagingRoot, "runtime", index.runtime.runtimeVersion);
        await mkdir(targetDir, { recursive: true });

        const totalBytes = index.runtime.files.reduce((sum, f) => sum + f.size, 0);
        await assertFreeSpace(targetDir, totalBytes * 1.15 + 256 * 1024 * 1024);

        const sortedFiles = [...index.runtime.files].sort((a, b) => {
          const isExeA = a.name.endsWith(".exe") ? 1 : 0;
          const isExeB = b.name.endsWith(".exe") ? 1 : 0;
          return isExeA - isExeB;
        });

        throttle = createProgressThrottle((received, total) => {
          if (abortController.signal.aborted) return;
          options.send(CHROME_UPDATES_CHANNELS.progress, {
            jobId,
            kind: "runtime",
            phase: "downloading",
            step: 1,
            steps: 3,
            receivedBytes: received,
            totalBytes: total,
            message: `正在下载 OMP Runtime (${Math.round((received / total) * 100)}%)...`,
          });
        });

        const fileProgress = new Map<string, number>();

        for (const file of sortedFiles) {
          if (abortController.signal.aborted) {
            throw abortController.signal.reason ?? new Error("Download aborted");
          }

          const mirroredUrl = applyMirror(prefs.mirrorPrefix, file.url);
          const destPath = join(targetDir, file.name);

          await downloadOne({
            url: mirroredUrl,
            destination: destPath,
            expectedSha256: file.sha256,
            expectedSize: file.size,
            signal: abortController.signal,
            fetcher: options.fetcher,
            onProgress(recv) {
              fileProgress.set(file.name, recv);
              let overallRecv = 0;
              for (const v of fileProgress.values()) {
                overallRecv += v;
              }
              throttle!.report(overallRecv, totalBytes);
            },
          });

          if (file.name === "runtime-manifest.json") {
            const manifestRaw = await readFile(destPath, "utf8");
            const manifestJson = JSON.parse(manifestRaw) as { runtimeVersion?: string };
            if (manifestJson.runtimeVersion !== index.runtime.runtimeVersion) {
              throw new Error(
                `工件清单版本 (${manifestJson.runtimeVersion}) 与索引声明版本 (${index.runtime.runtimeVersion}) 不一致`,
              );
            }
          }
        }

        throttle.flush();

        options.send(CHROME_UPDATES_CHANNELS.progress, {
          jobId,
          kind: "runtime",
          phase: "verifying",
          step: 2,
          steps: 3,
          message: "正在验签工件...",
        });

        const verified = await verifySignedArtifact({
          directory: targetDir,
          layout: RUNTIME_ARTIFACT_LAYOUT,
          parseManifest: parseRuntimeInstallationManifest,
          requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
          trustedKeys: options.trustedKeys,
        });
        abortController.signal.throwIfAborted();

        if (verified.manifest.runtimeVersion !== index.runtime.runtimeVersion) {
          throw new Error("工件清单版本与索引不一致");
        }
        if (verified.manifest.platform !== options.platform) {
          throw new Error(`平台不匹配: 期望 ${options.platform}, 实际 ${verified.manifest.platform}`);
        }
        if (verified.manifest.channel !== prefs.runtimeChannel) {
          throw new Error(`通道不匹配: 期望 ${prefs.runtimeChannel}, 实际 ${verified.manifest.channel}`);
        }

        options.pendingArtifact.set(targetDir);
        pendingRuntimeJobId = jobId;
        options.send(CHROME_UPDATES_CHANNELS.progress, {
          jobId,
          kind: "runtime",
          phase: "awaiting-apply",
          step: 3,
          steps: 3,
          message: "工件已验签，准备安装",
          runtimeChannel: verified.manifest.channel,
        });
      } catch (err) {
        if (abortController.signal.aborted) {
          options.send(CHROME_UPDATES_CHANNELS.progress, {
            jobId,
            kind: "runtime",
            phase: "cancelled",
            step: 0,
            steps: 3,
            message: "已取消更新",
          });
        } else {
          const sanitized = sanitizeErrorMessage(err);
          options.send(CHROME_UPDATES_CHANNELS.progress, {
            jobId,
            kind: "runtime",
            phase: "failed",
            step: 0,
            steps: 3,
            message: sanitized,
          });
        }
      } finally {
        throttle?.dispose();
        if (activeJob?.jobId === jobId) {
          activeJob = null;
        }
      }
    })();

    return { ok: true, jobId };
  });

  ipc.handle(CHROME_UPDATES_CHANNELS.importLocal, async (event, payload): Promise<UpdateImportResult> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
      return { ok: false, message: "Untrusted sender" };
    }

    const input = parseChromeUpdatesImportInput(payload);
    if (input === undefined) {
      return { ok: false, message: "无效的导入参数" };
    }

    if (input.kind !== "runtime") {
      return { ok: false, message: "当前仅支持导入 Runtime 工件" };
    }

    if (activeJob !== null || applying) return { ok: false, message: "已有正在进行的更新任务" };
    const jobId = randomUUID();
    const abortController = new AbortController();
    activeJob = { jobId, kind: "runtime", abortController };
    try {
    await startupGc;

    let dialogOpts: OpenDialogOptionsLike;
    if (input.source === "directory") {
      dialogOpts = {
        title: "选择 OMP Runtime 目录",
        properties: ["openDirectory"],
      };
    } else {
      dialogOpts = {
        title: "选择 OMP Runtime 清单",
        properties: ["openFile"],
        filters: [{ name: "OMP Runtime 工件", extensions: ["json"] }],
      };
    }

    const picked = await options.showOpenDialog(dialogOpts);
    if (picked.canceled || !picked.filePaths || picked.filePaths.length === 0) {
      return { ok: false, cancelled: true };
    }

    const chosen = picked.filePaths[0]!;
    const directory = input.source === "directory" ? chosen : dirname(chosen);
    abortController.signal.throwIfAborted();

    options.send(CHROME_UPDATES_CHANNELS.progress, {
      jobId,
      kind: "runtime",
      phase: "verifying",
      step: 1,
      steps: 3,
      message: "正在验签工件...",
    });

    let verified: { manifest: RuntimeInstallationManifest };
    try {
      verified = await verifySignedArtifact({
        directory,
        layout: RUNTIME_ARTIFACT_LAYOUT,
        parseManifest: parseRuntimeInstallationManifest,
        requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
        trustedKeys: options.trustedKeys,
      });
    } catch (error) {
      const sanitized = sanitizeErrorMessage(error);
      options.send(CHROME_UPDATES_CHANNELS.progress, {
        jobId,
        kind: "runtime",
        phase: "failed",
        step: 1,
        steps: 3,
        message: sanitized,
      });
      return { ok: false, message: sanitized };
    }

    const currentPrefs = await options.prefs.read();
    abortController.signal.throwIfAborted();
    if (verified.manifest.platform !== options.platform) {
      const msg = `平台不匹配: 期望 ${options.platform}, 实际 ${verified.manifest.platform}`;
      options.send(CHROME_UPDATES_CHANNELS.progress, {
        jobId,
        kind: "runtime",
        phase: "failed",
        step: 1,
        steps: 3,
        message: msg,
      });
      return { ok: false, message: msg };
    }

    if (verified.manifest.channel !== currentPrefs.runtimeChannel) {
      const msg = `通道不匹配: 期望 ${currentPrefs.runtimeChannel}, 实际 ${verified.manifest.channel}`;
      options.send(CHROME_UPDATES_CHANNELS.progress, {
        jobId,
        kind: "runtime",
        phase: "failed",
        step: 1,
        steps: 3,
        message: msg,
      });
      return { ok: false, message: msg };
    }

    options.pendingArtifact.set(directory);
    pendingRuntimeJobId = jobId;
    options.send(CHROME_UPDATES_CHANNELS.progress, {
      jobId,
      kind: "runtime",
      phase: "awaiting-apply",
      step: 2,
      steps: 3,
      message: "工件已验签，准备安装",
      runtimeChannel: verified.manifest.channel,
    });

    return {
      ok: true,
      jobId,
      runtimeVersion: verified.manifest.runtimeVersion,
      runtimeChannel: verified.manifest.channel,
    };
    } catch (error) {
      return { ok: false, message: sanitizeErrorMessage(error) };
    } finally {
      if (activeJob?.jobId === jobId) activeJob = null;
    }
  });

  ipc.handle(CHROME_UPDATES_CHANNELS.cancel, async (event, payload): Promise<void> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
      return;
    }
    const input = parseChromeUpdatesCancelInput(payload);
    if (input === undefined) return;

    if (applying) return;
    let cancelledKind: "app" | "runtime";
    if (activeJob !== null && activeJob.jobId === input.jobId) {
      activeJob.abortController.abort();
      cancelledKind = activeJob.kind;
      // Keep the slot until all file work has settled; cancellation is cooperative.
    } else if (pendingAppJobId === input.jobId) {
      cancelledKind = "app";
    } else if (pendingRuntimeJobId === input.jobId) {
      cancelledKind = "runtime";
    } else {
      return;
    }

    if (pendingRuntimeJobId === input.jobId) {
      options.pendingArtifact.set(undefined);
      pendingRuntimeJobId = undefined;
    }
    if (pendingAppJobId === input.jobId) {
      pendingAppPayloadVersion = undefined;
      pendingInstaller = undefined;
      pendingAppJobId = undefined;
    }

    options.send(CHROME_UPDATES_CHANNELS.progress, {
      jobId: input.jobId,
      kind: cancelledKind,
      phase: "cancelled",
      step: 0,
      steps: 1,
      message: "已取消更新",
    });
  });

  ipc.handle(CHROME_UPDATES_CHANNELS.apply, async (event): Promise<UpdateApplyResult> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
      return { ok: false, message: "Untrusted sender" };
    }
    if (activeJob !== null || applying) return { ok: false, message: "已有正在进行的更新任务" };
    if (pendingAppPayloadVersion === undefined && pendingInstaller === undefined) {
      return { ok: false, message: "没有待应用的更新" };
    }

    applying = true;
    try {
      if (options.isBusy?.()) return { ok: true, deferred: true };
      if (pendingInstaller !== undefined) {
        if (!options.openPath) return { ok: false, message: "应用更新安装器不可用" };
        if ((await stat(pendingInstaller.path)).size !== pendingInstaller.size || await sha256File(pendingInstaller.path) !== pendingInstaller.sha256) {
          throw new Error("Installer checksum mismatch");
        }
        if (options.isBusy?.()) return { ok: true, deferred: true };
        const error = await options.openPath(pendingInstaller.path);
        if (error) throw new Error(error);
        pendingInstaller = undefined;
        pendingAppJobId = undefined;
        options.quit?.();
        return { ok: true };
      }
      if (!options.appPayloadInstaller) return { ok: false, message: "应用负载安装器不可用" };
      await options.appPayloadInstaller.activate(pendingAppPayloadVersion!);
      pendingAppPayloadVersion = undefined;
      pendingAppJobId = undefined;

      const args = [...process.argv.slice(1).filter((arg) => arg !== "--omp-restarted"), "--omp-restarted"];
      options.relaunch?.({ args });
      options.quit?.();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: sanitizeErrorMessage(error) };
    } finally {
      applying = false;
    }
  });

  ipc.handle(CHROME_UPDATES_CHANNELS.rollback, async (event): Promise<UpdateApplyResult> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
      return { ok: false, message: "Untrusted sender" };
    }
    if (!options.appPayloadInstaller) {
      return { ok: false, message: "应用负载安装器不可用" };
    }
    if (activeJob !== null || applying) return { ok: false, message: "已有正在进行的更新任务" };

    applying = true;
    try {
      if (options.isBusy?.()) return { ok: true, deferred: true };
      await options.appPayloadInstaller.rollback();
      pendingAppPayloadVersion = undefined;
      pendingInstaller = undefined;
      pendingAppJobId = undefined;

      const args = [...process.argv.slice(1).filter((arg) => arg !== "--omp-restarted"), "--omp-restarted"];
      options.relaunch?.({ args });
      options.quit?.();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: sanitizeErrorMessage(error) };
    } finally {
      applying = false;
    }
  });

  ipc.handle(CHROME_UPDATES_CHANNELS.prefsGet, async (event): Promise<UpdatePrefs | null> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
      return null;
    }
    try {
      return await options.prefs.read();
    } catch {
      return null;
    }
  });

  for (const [channel, action] of [
    [CHROME_UPDATES_CHANNELS.rollbackRuntime, options.rollbackRuntime],
    [CHROME_UPDATES_CHANNELS.pruneRuntime, options.pruneRuntimes],
  ] as const) {
    ipc.handle(channel, async (event): Promise<UpdateApplyResult> => {
      if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) return { ok: false, message: "Untrusted sender" };
      if (!action) return { ok: false, message: "Runtime maintenance unavailable" };
      if (activeJob !== null || applying || options.isBusy?.()) return { ok: false, message: "Runtime is busy" };
      applying = true;
      try {
        await action();
        return { ok: true };
      } catch (error) {
        return { ok: false, message: sanitizeErrorMessage(error) };
      } finally {
        applying = false;
      }
    });
  }

  ipc.handle(CHROME_UPDATES_CHANNELS.prefsSet, async (event, payload): Promise<UpdatePrefs | null> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
      return null;
    }
    const patch = parseChromeUpdatesPrefsSetInput(payload);
    if (patch === undefined) return null;
    try {
      return await options.prefs.write(patch);
    } catch {
      return null;
    }
  });

  return Object.freeze({
    dispose(): void {
      activeJob?.abortController.abort();
      removeAll();
    },
  });
}
