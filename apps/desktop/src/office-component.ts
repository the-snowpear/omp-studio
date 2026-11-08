import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isInside, writeJsonAtomic } from "@omp-studio/runtime-installer";
import { downloadOne } from "./artifact-download.js";
import type { FileResources } from "./file-resources.js";
import type { OfficeComponentState } from "./file-viewer-shared.js";
import { verifyOfficeComponent, type SignedOfficeComponent } from "./office-component-manifest.js";
import { runOfficeProcess } from "./office-process.js";

const execute = promisify(execFile);
export class OfficeComponent {
  private state: OfficeComponentState = { id: "office-preview", status: "not-installed" };
  private listeners = new Set<(state: OfficeComponentState) => void>();
  private installed: SignedOfficeComponent | undefined;
  private available: SignedOfficeComponent | undefined;
  private initialized: Promise<void> | undefined;
  private installing: Promise<OfficeComponentState> | undefined;
  private controller: AbortController | undefined;
  private conversionQueue: Promise<unknown> = Promise.resolve();
  private conversions = new Map<string, Promise<string>>();
  private conversionControllers = new Set<AbortController>();
  readonly platform: string;
  constructor(readonly root: string, readonly keys: Readonly<Record<string, string | Buffer>>, readonly options: { platform?: string; manifestUrl?: string; fetcher?: typeof fetch; mirror?: () => string } = {}) { this.platform = options.platform ?? `${process.platform}-${process.arch}`; }
  subscribe(listener: (state: OfficeComponentState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(patch: Partial<OfficeComponentState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(this.state); return this.state; }
  private init(): Promise<void> {
    return this.initialized ??= (async () => {
      try {
        const installed = verifyOfficeComponent(JSON.parse(await readFile(join(this.root, "installed.json"), "utf8")), this.keys, this.platform);
        await access(join(this.root, "versions", installed.manifest.version, installed.manifest.entrypoint));
        this.installed = installed; this.publish({ status: "ready", installedVersion: installed.manifest.version });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.publish({ status: "error", message: String(error) }); }
    })();
  }
  async getState(check = false): Promise<OfficeComponentState> {
    await this.init();
    if (!check || this.controller) return this.state;
    this.publish({ status: "checking", message: "" });
    try {
      const url = this.options.manifestUrl ?? `https://github.com/the-snowpear/omp-studio/releases/download/office-preview/office-preview-${this.platform}.json`;
      const response = await (this.options.fetcher ?? fetch)(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(response.status === 404 ? "该平台的 Office 组件尚未发布，请稍后检查" : `组件清单下载失败 (${response.status})`);
      this.available = verifyOfficeComponent(await response.json(), this.keys, this.platform);
      return this.publish({ status: this.installed ? "ready" : "not-installed", availableVersion: this.available.manifest.version, downloadBytes: this.available.manifest.archive.bytes });
    } catch (error) { return this.publish({ status: this.installed ? "ready" : "error", message: error instanceof Error ? error.message : String(error) }); }
  }
  async install(): Promise<OfficeComponentState> {
    if (this.installing) return this.installing;
    const run = this.performInstall(); this.installing = run;
    try { return await run; } finally { this.installing = undefined; this.controller = undefined; }
  }
  private async performInstall(): Promise<OfficeComponentState> {
    await this.getState(true);
    const envelope = this.available;
    if (!envelope) return this.state;
    if (this.installed?.manifest.version === envelope.manifest.version) {
      if (this.installed.manifest.archive.sha256 !== envelope.manifest.archive.sha256) return this.publish({ message: "同版本组件内容不一致，需要新的组件版本" });
      return this.publish({ status: "ready", message: "已安装最新版本" });
    }
    const controller = new AbortController(); this.controller = controller;
    const staging = join(this.root, `.staging-${randomUUID()}`), archive = join(this.root, `${envelope.manifest.version}.zip`);
    try {
      await mkdir(staging, { recursive: true });
      this.publish({ status: "downloading", receivedBytes: 0, message: "" });
      await downloadOne({ url: envelope.manifest.archive.url, destination: archive, expectedSha256: envelope.manifest.archive.sha256, expectedSize: envelope.manifest.archive.bytes, signal: controller.signal, fetcher: this.options.fetcher, mirror: this.options.mirror?.(), onProgress: receivedBytes => this.publish({ receivedBytes }) });
      this.publish({ status: "installing" });
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
      await this.removeOwned(archive);
      return this.publish({ status: "ready", installedVersion: envelope.manifest.version, message: "", receivedBytes: envelope.manifest.archive.bytes });
    } catch (error) { return this.publish({ status: this.installed ? "ready" : "error", message: controller.signal.aborted ? "已取消安装" : error instanceof Error ? error.message : String(error) }); }
    finally { await this.removeOwned(staging); }
  }
  cancel() { this.controller?.abort(); }
  async uninstall(): Promise<OfficeComponentState> {
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
  async convert(resources: FileResources, id: string, owner: number): Promise<string> {
    await this.init();
    if (!this.installed) throw new Error("请先安装 Office 文档预览组件");
    const lease = resources.get(id, owner), installed = this.installed;
    if (!/\.(docx?|pptx?|odt|odp|rtf)$/i.test(lease.file.name)) throw new Error("此文件不需要 Office 转换");
    const key = createHash("sha256").update(JSON.stringify([lease.target.targetId, lease.file.id, lease.file.version, installed.manifest.version])).digest("hex");
    const directory = join(this.root, "cache", key), pdf = join(directory, "input.pdf");
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
        await resources.copy(id, input, controller.signal);
        await runOfficeProcess(join(this.root, "versions", installed.manifest.version, installed.manifest.entrypoint), [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--nologo", "--nodefault", "--nofirststartwizard", "--norestore", "--convert-to", "pdf", "--outdir", directory, input], controller.signal);
        await access(pdf).catch(() => { throw new Error("Office 转换未生成预览。文件可能已加密或格式不受支持。"); });
        await this.removeOwned(input);
        return pdf;
      } catch (error) { await this.removeOwned(directory); throw error; }
      finally { await this.removeOwned(profile); }
    });
    this.conversionQueue = operation; this.conversions.set(operationKey, operation);
    try { return await operation; }
    finally { this.conversions.delete(operationKey); this.conversionControllers.delete(controller); lease.controller.signal.removeEventListener("abort", abort); }
  }
  dispose() { this.cancel(); for (const controller of this.conversionControllers) controller.abort(); this.listeners.clear(); }
}
