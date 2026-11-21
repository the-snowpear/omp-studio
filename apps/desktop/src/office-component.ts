import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isInside, writeJsonAtomic } from "@omp-studio/runtime-installer";
import { assertFreeSpace, createProgressThrottle, downloadOne } from "./artifact-download.js";
import type { FileResources } from "./file-resources.js";
import type { OfficeComponentState } from "./file-viewer-shared.js";
import { verifyOfficeComponent, type SignedOfficeComponent } from "./office-component-manifest.js";
import { runOfficeProcess } from "./office-process.js";
import { desktopText } from "./desktop-language-shared.js";

const execute = promisify(execFile);
const SUPPORTED_PLATFORMS = new Set(["win32-x64", "win32-arm64", "darwin-arm64"]);
export class OfficeComponent {
  private state: OfficeComponentState;
  private listeners = new Set<(state: OfficeComponentState) => void>();
  private installed: SignedOfficeComponent | undefined;
  private available: SignedOfficeComponent | undefined;
  private initialized: Promise<void> | undefined;
  private installing: Promise<OfficeComponentState> | undefined;
  private installingVersion: string | undefined;
  private controller: AbortController | undefined;
  private conversionQueue: Promise<unknown> = Promise.resolve();
  private conversions = new Map<string, Promise<string>>();
  private conversionControllers = new Set<AbortController>();
  private engineUsers = new Map<string, number>();
  readonly platform: string;
  constructor(readonly root: string, readonly keys: Readonly<Record<string, string | Buffer>>, readonly options: { platform?: string; manifestUrl?: string; fetcher?: typeof fetch; mirror?: () => string } = {}) {
    this.platform = options.platform ?? `${process.platform}-${process.arch}`;
    this.state = this.isSupported() ? { id: "office-preview", status: "not-installed" } : this.unsupportedState();
  }
  private isSupported(): boolean { return SUPPORTED_PLATFORMS.has(this.platform); }
  private unsupportedState(): OfficeComponentState { return { id: "office-preview", status: "unsupported", message: desktopText("此平台暂不支持 Office 文档预览组件", "Office document preview is not available on this platform") }; }
  subscribe(listener: (state: OfficeComponentState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(patch: Partial<OfficeComponentState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(this.state); return this.state; }
  private init(): Promise<void> {
    return this.initialized ??= (async () => {
      if (!this.isSupported()) return;
      try {
        const installed = verifyOfficeComponent(JSON.parse(await readFile(join(this.root, "installed.json"), "utf8")), this.keys, this.platform);
        await access(join(this.root, "versions", installed.manifest.version, installed.manifest.entrypoint));
        this.installed = installed; this.publish({ status: "ready", installedVersion: installed.manifest.version });
        await this.pruneInstalledVersions(installed.manifest.version);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.publish({ status: "error", message: String(error) }); }
    })();
  }
  async getState(check = false): Promise<OfficeComponentState> {
    if (!this.isSupported()) return this.unsupportedState();
    await this.init();
    if (!check || this.controller) return this.state;
    const controller = new AbortController(); this.controller = controller;
    try { return await this.checkManifest(controller.signal); }
    finally { if (this.controller === controller) this.controller = undefined; }
  }
  private async checkManifest(signal: AbortSignal): Promise<OfficeComponentState> {
    if (!this.isSupported()) return this.unsupportedState();
    this.publish({ status: "checking", message: "" });
    try {
      const url = this.options.manifestUrl ?? `https://github.com/the-snowpear/omp-studio/releases/download/office-preview/office-preview-${this.platform}.json`;
      const response = await (this.options.fetcher ?? fetch)(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      if (!response.ok) throw new Error(response.status === 404 ? desktopText("该平台的 Office 组件尚未发布，请稍后检查", "Office component has not been published for this platform yet; check back later") : desktopText(`组件清单下载失败 (${response.status})`, `Failed to download component manifest (${response.status})`));
      this.available = verifyOfficeComponent(await response.json(), this.keys, this.platform);
      return this.publish({ status: this.installed ? "ready" : "not-installed", availableVersion: this.available.manifest.version, downloadBytes: this.available.manifest.archive.bytes });
    } catch (error) { return this.publish({ status: this.installed ? "ready" : signal.aborted ? "not-installed" : "error", message: signal.aborted ? desktopText("已取消操作", "Operation cancelled") : error instanceof Error ? error.message : String(error) }); }
  }
  async install(): Promise<OfficeComponentState> {
    if (!this.isSupported()) return this.unsupportedState();
    if (this.installing) return this.installing;
    const run = this.performInstall(); this.installing = run;
    try { return await run; } finally { this.installing = undefined; this.controller = undefined; }
  }
  private async performInstall(): Promise<OfficeComponentState> {
    const controller = new AbortController(); this.controller = controller;
    await this.init(); await this.checkManifest(controller.signal);
    if (controller.signal.aborted) return this.state;
    const envelope = this.available;
    if (!envelope) return this.state;
    if (this.installed?.manifest.version === envelope.manifest.version) {
      if (this.installed.manifest.archive.sha256 !== envelope.manifest.archive.sha256) return this.publish({ message: desktopText("同版本组件内容不一致，需要新的组件版本", "Component contents differ for the same version; a new version is required") });
      return this.publish({ status: "ready", message: desktopText("已安装最新版本", "Latest version is already installed") });
    }
    const staging = join(this.root, `.staging-${randomUUID()}`), archive = join(this.root, `${envelope.manifest.version}.zip`);
    const progress = createProgressThrottle(receivedBytes => this.publish({ receivedBytes }));
    this.installingVersion = envelope.manifest.version;
    try {
      await assertFreeSpace(this.root, envelope.manifest.archive.bytes * 3);
      await mkdir(staging, { recursive: true });
      this.publish({ status: "downloading", receivedBytes: 0, message: "" });
      await downloadOne({ url: envelope.manifest.archive.url, destination: archive, expectedSha256: envelope.manifest.archive.sha256, expectedSize: envelope.manifest.archive.bytes, signal: controller.signal, fetcher: this.options.fetcher, mirror: this.options.mirror?.(), onProgress: (receivedBytes, totalBytes) => progress.report(receivedBytes, totalBytes) });
      progress.flush();
      this.publish({ status: "installing" });
      await assertFreeSpace(this.root, envelope.manifest.archive.bytes * 2);
      if (process.platform === "win32") await execute(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", staging], { windowsHide: true, signal: controller.signal, timeout: 180_000 });
      else await execute("/usr/bin/ditto", ["-xk", archive, staging], { signal: controller.signal, timeout: 180_000 });
      const engine = join(staging, envelope.manifest.entrypoint);
      await execute(engine, ["--version"], { windowsHide: true, signal: controller.signal, timeout: 30_000 });
      const destination = join(this.root, "versions", envelope.manifest.version);
      await mkdir(join(this.root, "versions"), { recursive: true });
      await this.removeOwned(destination);
      await rename(staging, destination);
      await writeJsonAtomic(join(this.root, "installed.json"), envelope);
      this.installed = envelope;
      await this.pruneInstalledVersions(envelope.manifest.version);
      await this.removeOwned(archive);
      return this.publish({ status: "ready", installedVersion: envelope.manifest.version, message: "", receivedBytes: envelope.manifest.archive.bytes });
    } catch (error) { return this.publish({ status: this.installed ? "ready" : "error", message: controller.signal.aborted ? desktopText("已取消安装", "Installation cancelled") : error instanceof Error ? error.message : String(error) }); }
    finally { this.installingVersion = undefined; progress.dispose(); await this.removeOwned(staging); }
  }
  cancel() { this.controller?.abort(); }
  async uninstall(): Promise<OfficeComponentState> {
    if (!this.isSupported()) return this.unsupportedState();
    this.cancel(); await this.installing;
    for (const controller of this.conversionControllers) controller.abort();
    await this.conversionQueue.catch(() => {});
    for (const path of ["versions", "cache", "profiles", "installed.json"]) await this.removeOwned(join(this.root, path));
    for (const file of await readdir(this.root).catch(() => [])) if (/\.zip(?:\..*)?$/.test(file) || file.startsWith(".staging-")) await this.removeOwned(join(this.root, file));
    this.installed = undefined;
    this.state = { id: "office-preview", status: "not-installed", ...(this.available ? { availableVersion: this.available.manifest.version, downloadBytes: this.available.manifest.archive.bytes } : {}) };
    return this.publish({});
  }
  private async removeOwned(path: string) {
    if (!isInside(this.root, path) || resolve(path) === resolve(this.root)) throw new Error("Invalid component cleanup path");
    await rm(path, { recursive: true, force: true });
  }
  private async pruneInstalledVersions(keepVersion: string | undefined): Promise<void> {
    const versions = join(this.root, "versions");
    for (const entry of await readdir(versions, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name === keepVersion || (this.engineUsers.get(entry.name) ?? 0) > 0) continue;
      await this.removeOwned(join(versions, entry.name)).catch(() => {});
    }
  }
  private async releaseEngine(version: string): Promise<void> {
    const users = this.engineUsers.get(version) ?? 0;
    if (users > 1) {
      this.engineUsers.set(version, users - 1);
      return;
    }
    this.engineUsers.delete(version);
    if (version !== this.installed?.manifest.version && version !== this.installingVersion) {
      await this.removeOwned(join(this.root, "versions", version)).catch(() => {});
    }
  }
  private async pruneCache(keepKey: string, resources: FileResources): Promise<void> {
    const cacheDir = join(this.root, "cache");
    const entries = await readdir(cacheDir, { withFileTypes: true }).catch(() => []);
    const busyKeys = new Set([...this.conversions.keys()].map(op => op.split(":")[0]));
    busyKeys.add(keepKey);
    const items: { key: string; path: string; size: number; mtimeMs: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(cacheDir, entry.name);
      const info = await stat(join(dir, "preview.pdf")).catch(() => undefined);
      if (!info) continue;
      items.push({ key: entry.name, path: dir, size: info.size, mtimeMs: info.mtimeMs });
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let totalBytes = items.reduce((sum, item) => sum + item.size, 0);
    let count = items.length;
    for (let index = items.length - 1; index >= 0 && (count > 32 || totalBytes > 268_435_456); index--) {
      const candidate = items[index]!;
      if (busyKeys.has(candidate.key) || resources.activePdfPaths().has(resolve(join(candidate.path, "preview.pdf")))) continue;
      try { await this.removeOwned(candidate.path); count--; totalBytes -= candidate.size; } catch { /* Keep failed removals in the cache accounting. */ }
    }
  }
  async convert(resources: FileResources, id: string, owner: number): Promise<string> {
    await this.init();
    if (!this.isSupported()) throw new Error(this.unsupportedState().message);
    if (!this.installed) throw new Error(desktopText("请先安装 Office 文档预览组件", "Install the Office document preview component first"));
    const installed = this.installed, version = installed.manifest.version;
    this.engineUsers.set(version, (this.engineUsers.get(version) ?? 0) + 1);
    try {
      const lease = resources.get(id, owner);
      if (!/\.(docx?|docm|pptx?|pptm|odt|ods|odp|rtf)$/i.test(lease.file.name)) throw new Error(desktopText("此文件不需要 Office 转换", "This file does not require Office conversion"));
      const key = createHash("sha256").update(JSON.stringify([lease.target.targetId, lease.file.id, lease.file.version, version])).digest("hex");
      const directory = join(this.root, "cache", key), pdf = join(directory, "preview.pdf");
      resources.setPdf(id, pdf);
      if (await access(pdf).then(() => true, () => false)) return pdf;
      const operationKey = `${key}:${id}`;
      const running = this.conversions.get(operationKey); if (running) return running;
      const controller = new AbortController(); this.conversionControllers.add(controller);
      const abort = () => controller.abort(); lease.controller.signal.addEventListener("abort", abort, { once: true });
      const operation = this.conversionQueue.catch(() => {}).then(async () => {
        controller.signal.throwIfAborted();
        if (await access(pdf).then(() => true, () => false)) return pdf;
        const profile = join(this.root, "profiles", randomUUID());
        try {
          await mkdir(directory, { recursive: true }); await mkdir(join(profile, "user"), { recursive: true });
          await writeFile(join(profile, "user", "registrymodifications.xcu"), '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item><item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item></oor:items>');
          const input = join(directory, `input${extname(lease.file.name).toLowerCase()}`);
          await assertFreeSpace(directory, lease.file.size);
          await resources.copy(id, input, controller.signal);
          await runOfficeProcess(join(this.root, "versions", version, installed.manifest.entrypoint), [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--nologo", "--nodefault", "--nofirststartwizard", "--norestore", "--convert-to", "pdf", "--outdir", directory, input], controller.signal);
          const generated = join(directory, "input.pdf");
          await access(generated).catch(() => { throw new Error(desktopText("Office 转换未生成预览。文件可能已加密或格式不受支持。", "Office conversion did not produce a preview. The file may be encrypted or in an unsupported format.")); });
          await this.removeOwned(input);
          await rename(generated, pdf);
          await this.pruneCache(key, resources).catch(() => {});
          return pdf;
        } catch (error) { await this.removeOwned(directory); throw error; }
        finally { await this.removeOwned(profile); }
      });
      this.conversionQueue = operation; this.conversions.set(operationKey, operation);
      try { return await operation; }
      finally { this.conversions.delete(operationKey); this.conversionControllers.delete(controller); lease.controller.signal.removeEventListener("abort", abort); }
    } finally { await this.releaseEngine(version); }
  }
  dispose() { this.cancel(); for (const controller of this.conversionControllers) controller.abort(); this.listeners.clear(); }
}
