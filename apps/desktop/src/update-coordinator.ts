import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  RuntimeInstaller, assertSafeVersion, createRuntimeArchive, extractRuntimeArchive, writeJsonAtomic, verifyUpdateManifest,
  verifySignedArtifact, RUNTIME_ARTIFACT_LAYOUT, parseRuntimeInstallationManifest,
  type ComponentRelease, type SignedUpdateManifest, type UpdateComponent, type UnifiedUpdateSnapshot,
  type ActivateOptions,
} from "@omp-studio/runtime-installer";
import { STUDIO_PROTOCOL_VERSION } from "@omp-studio/studio-protocol";
import { compareSemver } from "./chrome-app-update.js";
import { compareRuntimeVersions } from "./runtime-install.js";
import { discoverUpdates, type DiscoveredUpdates } from "./update-discovery.js";
import { cachedUpdatePath, downloadDifferentialArtifact, isVerifiedFile, type DifferentialInput } from "./differential-artifact.js";
import type { UpdatePrefs } from "./update-prefs-store.js";

interface Journal {
  schema: 2; authorized: boolean;
  pending: Partial<Record<UpdateComponent, SignedUpdateManifest>>;
  previous: Partial<Record<UpdateComponent, SignedUpdateManifest>>;
  watermarks: Record<string, number>;
  rollbackApp?: SignedUpdateManifest;
  rollbackRequested?: boolean;
  runtimeTrial?: { version: string; previousVersion?: string };
  lastError?: string;
}
export interface UpdateCoordinatorOptions {
  root: string; runtimeRoot: string; repo: string; platform: string; appVersion: string;
  keys: Readonly<Record<string, string | Buffer>>;
  prefs: { read(): Promise<UpdatePrefs> };
  snapshotChanged: (snapshot: UnifiedUpdateSnapshot) => void;
  isBusy: () => boolean;
  beforeQuit: () => Promise<void>;
  installDesktop: (path: string) => Promise<void>;
  restart: () => void; quit: () => void;
  differential?: DifferentialInput["differential"];
  fetcher?: typeof fetch;
  bundledRuntimeRoot?: string;
  initialInstallerPath?: string;
  /** Test seam; production always runs the signed executable's real smoke test. */
  activateOptions?: ActivateOptions;
}

export class UpdateCoordinator {
  private journal: Journal = { schema: 2, authorized: false, pending: {}, previous: {}, watermarks: {} };
  private found: DiscoveredUpdates = {};
  private controller: AbortController | undefined;
  private applying = false;
  private initialized = false;
  private journalInvalid = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private initialTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly installer: RuntimeInstaller;
  private readonly cache: string;
  private snapshot: UnifiedUpdateSnapshot;
  constructor(private readonly options: UpdateCoordinatorOptions) {
    this.cache = join(options.root, "cache");
    this.installer = new RuntimeInstaller(options.runtimeRoot, { trustedKeys: options.keys });
    this.snapshot = { schema: 2, checking: false, app: { component: "app", currentVersion: options.appVersion, phase: "idle" }, runtime: { component: "runtime", phase: "idle" } };
  }
  get state(): UnifiedUpdateSnapshot {
    return structuredClone({ ...this.snapshot, rollbackAppVersion: this.journal.rollbackApp?.manifest.app?.version, rollbackAppPending: this.journal.rollbackRequested === true });
  }
  get hasRuntimeTrial(): boolean { return this.journal.runtimeTrial !== undefined; }
  private emit(): void { this.options.snapshotChanged(this.state); }
  private save(): Promise<void> { return writeJsonAtomic(join(this.options.root, "transaction-v2.json"), this.journal); }
  private verify(value: unknown): SignedUpdateManifest { return verifyUpdateManifest(value, this.options.keys, this.options.repo, this.options.platform); }
  private async pruneCache(): Promise<void> {
    const retained = new Set<string>();
    for (const envelope of [...Object.values(this.journal.pending), ...Object.values(this.journal.previous), this.journal.rollbackApp]) {
      if (!envelope) continue;
      for (const component of [envelope.manifest.app, envelope.manifest.runtime]) if (component) { retained.add(component.file.sha256); retained.add(component.blockmap.sha256); }
    }
    for (const entry of await readdir(this.cache, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name) || retained.has(entry.name)) continue;
      const target = join(this.cache, entry.name);
      if (Date.now() - (await stat(target)).mtimeMs > 7 * 24 * 60 * 60 * 1000) await rm(target, { recursive: true, force: true });
    }
  }

  /** Called before creating Host, so no Runtime process can hold a candidate open. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await mkdir(this.cache, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(join(this.options.root, "transaction-v2.json"), "utf8")) as Journal;
      if (raw.schema !== 2 || typeof raw.authorized !== "boolean" || !raw.pending || !raw.previous || !raw.watermarks) throw new Error("Invalid update journal");
      for (const collection of [raw.pending, raw.previous]) for (const kind of ["app", "runtime"] as const) if (collection[kind]) collection[kind] = this.verify(collection[kind]);
      if (raw.rollbackApp) raw.rollbackApp = this.verify(raw.rollbackApp);
      if (raw.rollbackRequested !== undefined && typeof raw.rollbackRequested !== "boolean") throw new Error("Invalid rollback intent");
      if (raw.runtimeTrial) {
        assertSafeVersion(raw.runtimeTrial.version);
        if (raw.runtimeTrial.previousVersion) assertSafeVersion(raw.runtimeTrial.previousVersion);
        // Older builds persisted a trial `attempts` counter; it is no longer
        // part of the schema but must not invalidate a still-valid journal.
        delete (raw.runtimeTrial as Record<string, unknown>).attempts;
      }
      for (const sequence of Object.values(raw.watermarks)) if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid update watermark");
      this.journal = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.journalInvalid = true; this.snapshot.error = "更新状态损坏；请从诊断恢复或重新安装，已停止自动更新"; this.emit(); return; }
    }
    const app = this.journal.pending.app?.manifest.app;
    if (app && app.version === this.options.appVersion) {
      if (this.journal.previous.app) this.journal.rollbackApp = this.journal.previous.app;
      this.journal.previous.app = this.journal.pending.app!;
      delete this.journal.pending.app;
      delete this.journal.rollbackRequested;
    }
    // A failed desktop installation leaves authorization pending; never activate
    // a Runtime requiring that desktop until the new executable actually starts.
    const runtimeEnvelope = this.journal.pending.runtime;
    if (this.journal.authorized && this.journal.pending.app && runtimeEnvelope?.manifest.runtime) {
      this.snapshot.error = "桌面更新事务不完整，请使用历史 Setup 恢复";
      this.journal.authorized = false;
    }
    if (this.journal.authorized && !this.journal.pending.app && runtimeEnvelope?.manifest.runtime) {
      const release = runtimeEnvelope.manifest.runtime;
      try {
        this.assertRuntimeCompatible(release, this.options.appVersion);
        const archive = cachedUpdatePath(this.cache, release.file);
        if (!await isVerifiedFile(archive, release.file) && this.options.bundledRuntimeRoot) {
          await mkdir(join(this.cache, release.file.sha256), { recursive: true });
          await createRuntimeArchive(join(this.options.bundledRuntimeRoot, release.version), archive);
        }
        if (!await isVerifiedFile(archive, release.file)) throw new Error("Runtime archive checksum mismatch");
        const temp = await mkdtemp(join(this.options.root, "runtime-stage-"));
        try {
          await extractRuntimeArchive(archive, temp);
          const verified = await verifySignedArtifact({ directory: temp, layout: RUNTIME_ARTIFACT_LAYOUT, parseManifest: parseRuntimeInstallationManifest, requireCovered: m => ["runtime-manifest.json", m.entrypoint], trustedKeys: this.options.keys });
          if (verified.manifest.runtimeVersion !== release.version || verified.manifest.channel !== release.channel || verified.manifest.platform !== this.options.platform || verified.manifest.studioProtocol.min !== release.studioProtocol.min || verified.manifest.studioProtocol.max !== release.studioProtocol.max) throw new Error("Runtime archive does not match catalog");
          const previous = await this.installer.current();
          // Recovery may re-enter after current.json switched but before the
          // final journal save. Keep the original trial's rollback target.
          if (this.journal.runtimeTrial?.version !== release.version) {
            const previousVersion = previous?.runtimeVersion === release.version
              ? previous.previousRuntimeVersion : previous?.runtimeVersion;
            this.journal.runtimeTrial = { version: release.version, ...(previousVersion ? { previousVersion } : {}) };
          }
          await this.save();
          await this.installer.install(temp);
          await this.installer.activate(release.version, this.options.activateOptions);
          this.journal.previous.runtime = runtimeEnvelope;
          delete this.journal.pending.runtime;
        } finally { await rm(temp, { recursive: true, force: true }); }
      } catch (error) {
        // A resumed activation can fail while the candidate is already active.
        // Leave its trial available for the Host-startup rollback path.
        if ((await this.installer.current().catch(() => undefined))?.runtimeVersion !== this.journal.runtimeTrial?.version) delete this.journal.runtimeTrial;
        this.snapshot.runtime = { ...this.snapshot.runtime, phase: "failed", message: String(error) };
      }
    }
    this.journal.authorized = false;
    if (this.journal.lastError) this.snapshot.error = this.journal.lastError;
    const current = await this.installer.current().catch(() => undefined);
    this.snapshot.runtime.currentVersion = current?.runtimeVersion;
    for (const kind of ["app", "runtime"] as const) {
      const release = this.journal.pending[kind]?.manifest[kind];
      if (release && this.snapshot[kind].phase !== "failed") this.snapshot[kind] = { ...this.snapshot[kind], version: release.version, phase: "ready" };
    }
    await this.save(); await this.pruneCache().catch(() => {}); this.emit();
  }

  private assertRuntimeCompatible(release: ComponentRelease, appVersion: string, protocol: ComponentRelease["studioProtocol"] = { min: STUDIO_PROTOCOL_VERSION, max: STUDIO_PROTOCOL_VERSION }): void {
    if (compareSemver(appVersion, release.minAppVersion) < 0 || release.studioProtocol.min > protocol.max || release.studioProtocol.max < protocol.min) throw new Error("Runtime 需要兼容的桌面版本，请先更新桌面");
  }
  async check(): Promise<UnifiedUpdateSnapshot> {
    if (this.controller || this.applying || this.journalInvalid) return this.state;
    const controller = this.controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Update check timed out")), 60_000);
    this.snapshot.checking = true; this.snapshot.error = undefined; this.emit();
    try {
      const prefs = await this.options.prefs.read();
      const installedRuntime = await this.installer.currentManifest().catch(() => undefined);
      this.snapshot.runtime.currentVersion = installedRuntime?.manifest.runtimeVersion;
      if (this.journal.pending.runtime?.manifest.runtime?.channel !== undefined && this.journal.pending.runtime.manifest.runtime.channel !== prefs.runtimeChannel) {
        delete this.journal.pending.runtime;
        this.snapshot.runtime = { component: "runtime", currentVersion: this.snapshot.runtime.currentVersion, phase: "idle" };
      }
      this.found = await discoverUpdates({ repo: this.options.repo, platform: this.options.platform, keys: this.options.keys, mirror: prefs.mirrorPrefix, channel: prefs.runtimeChannel, signal: controller.signal, watermarks: this.journal.watermarks, currentVersions: { app: this.options.appVersion, runtime: this.snapshot.runtime.currentVersion }, ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}) });
      for (const kind of ["app", "runtime"] as const) {
        const baseline = this.found.baselines?.[kind], release = baseline?.manifest[kind];
        if (!release || this.journal.previous[kind]?.manifest[kind]?.file.sha256 === release.file.sha256) continue;
        const path = cachedUpdatePath(this.cache, release.file);
        await mkdir(join(this.cache, release.file.sha256), { recursive: true });
        try {
          if (!await isVerifiedFile(path, release.file)) {
            if (kind === "app" && this.options.initialInstallerPath && await isVerifiedFile(this.options.initialInstallerPath, release.file)) await cp(this.options.initialInstallerPath, path);
            else if (kind === "runtime") await createRuntimeArchive(join(this.options.runtimeRoot, "versions", release.version), path);
          }
          if (await isVerifiedFile(path, release.file)) this.journal.previous[kind] = baseline!;
        } catch { /* No usable base: next update downloads the complete artifact. */ }
      }
      for (const kind of ["app", "runtime"] as const) {
        const envelope = this.found[kind], release = envelope?.manifest[kind];
        if (!release) { if (!this.journal.pending[kind]) this.snapshot[kind] = { component: kind, currentVersion: this.snapshot[kind].currentVersion, phase: "idle" }; continue; }
        this.journal.watermarks[`${kind}:${release.channel}:${this.options.platform}`] = release.sequence;
        const current = this.snapshot[kind].currentVersion;
        const newer = kind === "app" ? compareSemver(release.version, current ?? "0.0.0") > 0 : installedRuntime?.manifest.channel !== release.channel || (compareRuntimeVersions(release.version, current ?? "0.0.0") ?? 1) > 0;
        if (!newer || (kind === "app" && release.version === prefs.skippedAppVersion)) {
          delete this.found[kind];
          if (!this.journal.pending[kind]) this.snapshot[kind] = { component: kind, currentVersion: current, phase: "idle" };
          continue;
        }
        if (!this.journal.pending[kind]) this.snapshot[kind] = { ...this.snapshot[kind], version: release.version, totalBytes: release.file.size };
        this.snapshot.releaseNotesUrl = envelope!.manifest.releaseNotesUrl;
      }
      await this.save();
    } catch (error) { this.snapshot.error = error instanceof Error ? error.message : String(error); }
    finally { clearTimeout(timeout); this.controller = undefined; this.snapshot.checking = false; this.emit(); }
    return this.state;
  }

  async prepare(target: UpdateComponent | "all" = "all"): Promise<void> {
    if (this.journalInvalid) throw new Error(this.snapshot.error);
    if (this.journal.rollbackRequested) throw new Error("桌面回滚已准备，请重启应用完成恢复");
    if (this.controller || this.applying) throw new Error("已有正在进行的更新任务");
    if (!this.found.app && !this.found.runtime) await this.check();
    if (this.snapshot.error) throw new Error(this.snapshot.error);
    if (this.controller || this.applying) throw new Error("已有正在进行的更新任务");
    const controller = this.controller = new AbortController();
    try {
      const prefs = await this.options.prefs.read();
      for (const kind of ["app", "runtime"] as const) {
        if (target !== "all" && target !== kind) continue;
        const envelope = this.found[kind], release = envelope?.manifest[kind];
        if (!release) continue;
        if (kind === "runtime" && release.channel !== prefs.runtimeChannel) throw new Error("Runtime 通道已更改，请重新检查更新");
        if (kind === "runtime") {
          const targetApp = this.journal.pending.app?.manifest.app?.version ?? this.options.appVersion;
          const protocol = this.journal.pending.app?.manifest.app?.studioProtocol ?? { min: STUDIO_PROTOCOL_VERSION, max: STUDIO_PROTOCOL_VERSION };
          if (compareSemver(targetApp, release.minAppVersion) < 0 || release.studioProtocol.min > protocol.max || release.studioProtocol.max < protocol.min) {
            this.snapshot.runtime = { ...this.snapshot.runtime, phase: "failed", message: "Runtime 需要兼容的桌面版本，请先更新桌面" }; this.emit();
            throw new Error(this.snapshot.runtime.message);
          }
        }
        this.snapshot[kind] = { ...this.snapshot[kind], version: release.version, phase: "downloading", message: undefined };
        this.emit();
        try {
          if (kind === "runtime" && release.channel === "stable" && this.journal.pending.app?.manifest.app?.bundledRuntimeVersion === release.version) {
            this.snapshot.runtime = { ...this.snapshot.runtime, method: "reuse", receivedBytes: 0, totalBytes: 0 };
          } else await downloadDifferentialArtifact({ release, previous: this.journal.previous[kind]?.manifest[kind], root: this.cache, mirror: prefs.mirrorPrefix, signal: controller.signal, fetcher: this.options.fetcher, differential: this.options.differential,
            progress: (method, receivedBytes, totalBytes, message) => { this.snapshot[kind] = { ...this.snapshot[kind], method, receivedBytes, totalBytes, message }; this.emit(); },
          });
          controller.signal.throwIfAborted();
          this.journal.pending[kind] = envelope!;
          await this.save();
          this.snapshot[kind].phase = "ready";
        } catch (error) {
          this.snapshot[kind].phase = controller.signal.aborted ? "cancelled" : "failed";
          this.snapshot[kind].message = error instanceof Error ? error.message : String(error);
          throw error;
        } finally { this.emit(); }
      }
    } finally { this.controller = undefined; }
  }
  cancel(): void { this.controller?.abort(new Error("Update cancelled")); }
  async apply(): Promise<{ ok: boolean; deferred?: boolean; message?: string }> {
    if (this.journalInvalid) return { ok: false, message: this.snapshot.error ?? "Invalid update journal" };
    if (this.controller || this.applying) return { ok: false, message: "更新尚未准备完成" };
    if (this.options.isBusy()) return { ok: true, deferred: true, message: "任务仍在运行，请完成后重启更新" };
    if (!this.journal.pending.app && !this.journal.pending.runtime) return { ok: false, message: "没有待应用的更新" };
    this.applying = true;
    let stopped = false;
    try {
      const prefs = await this.options.prefs.read();
      if (this.journal.pending.runtime?.manifest.runtime?.channel && this.journal.pending.runtime.manifest.runtime.channel !== prefs.runtimeChannel) throw new Error("Runtime 通道已更改，请重新检查更新");
      for (const kind of ["app", "runtime"] as const) {
        const envelope = this.journal.pending[kind];
        if (!envelope) continue;
        const release = this.verify(envelope).manifest[kind]!;
        const bundled = kind === "runtime" && release.channel === "stable" && this.journal.pending.app?.manifest.app?.bundledRuntimeVersion === release.version;
        if (!bundled && !await isVerifiedFile(cachedUpdatePath(this.cache, release.file), release.file)) throw new Error("Update checksum mismatch before apply");
      }
      // Pending components can come from different checks/preparation attempts.
      // Validate the final pair after authentication, immediately before quit.
      const targetApp = this.journal.pending.app?.manifest.app;
      const targetRuntime = this.journal.pending.runtime?.manifest.runtime;
      if (targetRuntime) {
        this.assertRuntimeCompatible(targetRuntime, targetApp?.version ?? this.options.appVersion,
          targetApp?.studioProtocol);
      } else if (targetApp) {
        const current = await this.installer.currentManifest();
        if (current && (current.manifest.studioProtocol.max < targetApp.studioProtocol.min || current.manifest.studioProtocol.min > targetApp.studioProtocol.max)) throw new Error("请同时准备兼容的 Runtime 更新");
      }
      if (this.options.isBusy()) return { ok: true, deferred: true };
      delete this.journal.lastError;
      this.journal.authorized = true; await this.save();
      await this.options.beforeQuit();
      stopped = true;
      const app = this.journal.pending.app?.manifest.app;
      if (app) {
        // Shutdown takes seconds; re-verify the exact bytes about to be
        // executed so a cache swap in that window cannot launch them.
        if (!await isVerifiedFile(cachedUpdatePath(this.cache, app.file), app.file)) throw new Error("Update checksum mismatch after shutdown");
        await this.options.installDesktop(cachedUpdatePath(this.cache, app.file));
        this.options.quit();
      } else this.options.restart();
      return { ok: true };
    } catch (error) {
      this.journal.authorized = false;
      this.journal.lastError = error instanceof Error ? error.message : String(error);
      await this.save();
      if (stopped) this.options.restart();
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally { this.applying = false; }
  }
  async rollbackDesktop(): Promise<{ ok: boolean; message?: string }> {
    if (this.controller || this.applying || this.options.isBusy()) return { ok: false, message: "请先完成任务和下载" };
    const envelope = this.journal.rollbackApp;
    if (!envelope?.manifest.app) return { ok: false, message: "没有可验证的上一桌面版本，请下载历史安装包恢复" };
    const app = this.verify(envelope).manifest.app!;
    const runtime = await this.installer.currentManifest();
    if (runtime && (runtime.manifest.studioProtocol.min > app.studioProtocol.max || runtime.manifest.studioProtocol.max < app.studioProtocol.min)) return { ok: false, message: "当前 Runtime 与上一桌面不兼容，请先回滚 Runtime" };
    const controller = this.controller = new AbortController();
    try {
      const prefs = await this.options.prefs.read();
      await downloadDifferentialArtifact({ release: app, root: this.cache, mirror: prefs.mirrorPrefix, signal: controller.signal, fetcher: this.options.fetcher, progress: () => {} });
      this.journal.pending = { app: envelope };
      this.journal.rollbackRequested = true;
      await this.save();
      this.snapshot.runtime = { component: "runtime", currentVersion: this.snapshot.runtime.currentVersion, phase: "idle" };
      this.snapshot.app = { ...this.snapshot.app, version: app.version, phase: "ready", message: "上一版本已准备，点击重启恢复" }; this.emit();
      return { ok: true };
    } catch (error) { return { ok: false, message: String(error) }; }
    finally { this.controller = undefined; }
  }
  /** Returns true only when Host should be recreated on the verified previous Runtime. */
  async completeStartup(ready: boolean, workspaceSelected: boolean): Promise<boolean> {
    const trial = this.journal.runtimeTrial;
    if (!trial || !workspaceSelected) return false;
    if (ready) { delete this.journal.runtimeTrial; await this.save(); return false; }
    try {
      if (!trial.previousVersion) throw new Error("没有可回退的 Runtime");
      const directory = join(this.options.runtimeRoot, "versions", trial.previousVersion);
      const old = await verifySignedArtifact({ directory, layout: RUNTIME_ARTIFACT_LAYOUT, parseManifest: parseRuntimeInstallationManifest, requireCovered: m => ["runtime-manifest.json", m.entrypoint], trustedKeys: this.options.keys });
      if (old.manifest.studioProtocol.min > STUDIO_PROTOCOL_VERSION || old.manifest.studioProtocol.max < STUDIO_PROTOCOL_VERSION) throw new Error("上一 Runtime 与当前桌面不兼容");
      await this.installer.activate(trial.previousVersion, this.options.activateOptions);
      this.snapshot.runtime = { component: "runtime", currentVersion: trial.previousVersion, phase: "failed", message: "新 Runtime 启动失败，已恢复上一版本" };
      delete this.journal.runtimeTrial; await this.save(); this.emit(); return true;
    } catch (error) {
      this.snapshot.runtime = { ...this.snapshot.runtime, phase: "failed", message: `Runtime 恢复失败：${String(error)}` };
      delete this.journal.runtimeTrial; await this.save(); this.emit(); return false;
    }
  }
  startBackground(): void {
    const tick = async () => {
      try {
        const prefs = await this.options.prefs.read();
        if (!prefs.autoCheck || this.controller || this.applying || this.journal.rollbackRequested) return;
        await this.check();
        if (!this.snapshot.error && prefs.autoDownload !== false) await this.prepare();
      } catch { /* Errors are represented by snapshot; no background dialog. */ }
    };
    this.initialTimer = setTimeout(() => void tick(), 15_000);
    this.timer = setInterval(() => void tick(), 4 * 60 * 60 * 1000);
    this.initialTimer.unref(); this.timer.unref();
  }
  dispose(): void { clearTimeout(this.initialTimer); clearInterval(this.timer); this.cancel(); }
}
