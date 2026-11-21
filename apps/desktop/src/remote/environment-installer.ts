import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, posix, win32 } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyRemoteEnvironment, type SignedRemoteEnvironment } from "@omp-studio/runtime-installer";
import { withUpdateRequest } from "../update-request.js";
import { REMOTE_PROTOCOL_VERSION } from "./wire.js";
import { powershellCommand, quotePs, quoteSh } from "./probe.js";
import { remoteNodeCommand } from "./remote-command.js";
import { uploadRemoteFile } from "./file-transfer.js";
import { runSsh, type RemoteEnvironment, type RemoteInstallation } from "./deploy.js";
import type { SshAuthentication } from "./authentication.js";
import type { RemoteConnectionProfile, RemotePreparationStage } from "./shared.js";
import { desktopText } from "../desktop-language-shared.js";

export type PreparationProgress = (stage: RemotePreparationStage, message: string, receivedBytes?: number, totalBytes?: number) => void;
export interface EnvironmentInstallerOptions {
  cache: string; repo: string; appVersion: string; keys: Readonly<Record<string, string | Buffer>>;
  logEnvironmentFallback?(): void;
  fetcher?: typeof fetch; mirror?: () => Promise<string>;
  /** Local development and offline imports still authenticate this envelope. */
  localPackage?: { envelope: SignedRemoteEnvironment; archive: string };
}
async function digest(path: string): Promise<string> {
  const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest("hex");
}

export class RemoteEnvironmentInstaller {
  constructor(readonly options: EnvironmentInstallerOptions) {}

  async prepare(profile: RemoteConnectionProfile, environment: RemoteEnvironment, authentication: SshAuthentication | undefined, signal: AbortSignal, progress: PreparationProgress): Promise<RemoteInstallation> {
    const platform = `${environment.platform}-${environment.arch}`, paths = environment.platform === "win32" ? win32 : posix;
    const marker = paths.join(environment.root, "current-environment.json");
    const readMarker = environment.platform === "win32"
      ? powershellCommand(`if(Test-Path -LiteralPath ${quotePs(marker)}){Get-Content -LiteralPath ${quotePs(marker)} -Raw}`)
      : `if [ -f ${quoteSh(marker)} ]; then cat ${quoteSh(marker)}; fi`;
    const saved = await runSsh(profile, readMarker, undefined, 30_000, signal, authentication);
    if (saved.trim()) {
      const markerValue = JSON.parse(saved) as RemoteInstallation & { envelope?: SignedRemoteEnvironment };
      const installed = markerValue;
      if (markerValue.envelope) {
        const { manifest } = verifyRemoteEnvironment(markerValue.envelope, this.options.keys, this.options.repo, platform, markerValue.envelope.manifest.appVersion);
        if (manifest.appVersion === this.options.appVersion && manifest.protocolVersion === REMOTE_PROTOCOL_VERSION) {
          progress("verify", desktopText("正在验证已安装的私有运行环境", "Verifying installed private runtime environment"));
          environment.node = installed.node!;
          const hashCommand = environment.platform === "darwin" ? "shasum -a 256" : "sha256sum";
          const verifyInstalled = environment.platform === "win32"
            ? powershellCommand(`$ErrorActionPreference='Stop';if((Get-FileHash -LiteralPath ${quotePs(installed.node!)} -Algorithm SHA256).Hash.ToLower() -ne '${manifest.nodeSha256}'){throw 'Installed Node checksum mismatch'};if((Get-FileHash -LiteralPath ${quotePs(installed.entry)} -Algorithm SHA256).Hash.ToLower() -ne '${manifest.hostSha256}'){throw 'Installed Host checksum mismatch'}`)
            : `set -e; [ "$( ${hashCommand} ${quoteSh(installed.node!)} | cut -d ' ' -f1)" = '${manifest.nodeSha256}' ] && [ "$( ${hashCommand} ${quoteSh(installed.entry)} | cut -d ' ' -f1)" = '${manifest.hostSha256}' ]`;
          await runSsh(profile, verifyInstalled, undefined, 30_000, signal, authentication);
          await runSsh(profile, remoteNodeCommand(environment, `if(process.platform!==${JSON.stringify(environment.platform)}||process.arch!==${JSON.stringify(environment.arch)}||process.versions.node!==${JSON.stringify(manifest.nodeVersion)})throw Error('Private Node target or version mismatch');`), undefined, 30_000, signal, authentication);
          await this.start(profile, environment, installed, authentication, signal);
          return installed;
        }
      }
    }
    progress("download", desktopText("正在获取匹配远端系统的签名运行包", "Fetching signed runtime bundle matching the remote OS"));
    const mirror = await this.options.mirror?.() ?? "";
    const url = `https://github.com/${this.options.repo}/releases/download/v${this.options.appVersion}/remote-environment-${platform}.json`;
    const envelope = this.options.localPackage?.envelope ?? await withUpdateRequest({ url, stage: "manifest", mirror, signal, fetcher: this.options.fetcher }, async attempt => {
      const response = await attempt.request(); return JSON.parse(await response.text()) as SignedRemoteEnvironment;
    });
    const { manifest } = verifyRemoteEnvironment(envelope, this.options.keys, this.options.repo, platform, this.options.appVersion);
    if (manifest.protocolVersion !== REMOTE_PROTOCOL_VERSION) throw new Error(desktopText("远端运行包协议不匹配，请更新客户端", "Remote runtime bundle protocol mismatch; please update the client"));
    await mkdir(this.options.cache, { recursive: true });
    const archive = this.options.localPackage?.archive ?? join(this.options.cache, manifest.archive.sha256);
    if (!await stat(archive).then(s => s.size === manifest.archive.size).catch(() => false) || await digest(archive) !== manifest.archive.sha256) {
      if (this.options.localPackage) throw new Error(desktopText("本地远端运行包校验失败", "Local verification of the remote runtime bundle failed"));
      const temporary = `${archive}.${randomUUID()}.tmp`;
      try {
        await withUpdateRequest({ url: manifest.archive.url, stage: "artifact", mirror, signal, fetcher: this.options.fetcher }, async attempt => {
          const response = await attempt.request(); if (!response.body) throw new Error(desktopText("运行包下载为空", "Downloaded runtime bundle is empty"));
          let received = 0;
          const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { received += chunk.length; progress("download", desktopText("正在下载远端运行包", "Downloading remote runtime bundle"), received, manifest.archive.size); callback(null, chunk); } });
          await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), counter, createWriteStream(temporary), { signal: attempt.signal });
        });
        if (await digest(temporary) !== manifest.archive.sha256) throw new Error(desktopText("运行包下载摘要不匹配", "Downloaded runtime bundle digest mismatch"));
        await rename(temporary, archive);
      } finally { await rm(temporary, { force: true }); }
    }
    const stage = paths.join(environment.root, `.prepare-${randomUUID()}`), remoteArchive = paths.join(stage, environment.platform === "win32" ? "environment.zip" : "environment.tar.gz");
    let activated = false;
    try {
      progress("upload", desktopText("正在上传私有运行环境", "Uploading private runtime environment"), 0, manifest.archive.size);
      await uploadRemoteFile({ connection: profile, platform: environment.platform, localPath: archive, remoteDirectory: stage, remotePath: remoteArchive, signal, ...(authentication ? { authentication } : {}),
        progress: (receivedBytes, totalBytes) => progress("upload", desktopText("正在上传私有运行环境", "Uploading private runtime environment"), receivedBytes, totalBytes) });
      const unpacked = paths.join(stage, "environment"), destination = paths.join(environment.root, "environments", manifest.archive.sha256);
      progress("install", desktopText("正在校验并安装 Node、Host 和 Runtime", "Verifying and installing Node, Host, and Runtime"));
      const extract = environment.platform === "win32"
        ? powershellCommand(`$ErrorActionPreference='Stop';if((Get-FileHash -LiteralPath ${quotePs(remoteArchive)} -Algorithm SHA256).Hash.ToLower() -ne '${manifest.archive.sha256}'){throw 'Upload checksum mismatch'};Expand-Archive -LiteralPath ${quotePs(remoteArchive)} -DestinationPath ${quotePs(unpacked)};New-Item -ItemType Directory -Path ${quotePs(paths.dirname(destination))} -Force | Out-Null;if(Test-Path -LiteralPath ${quotePs(destination)}){Remove-Item -LiteralPath ${quotePs(unpacked)} -Recurse -Force}else{Move-Item -LiteralPath ${quotePs(unpacked)} -Destination ${quotePs(destination)}}`)
        : `set -e; digest=$( ${environment.platform === "darwin" ? "shasum -a 256" : "sha256sum"} ${quoteSh(remoteArchive)} | cut -d ' ' -f1 ); [ "$digest" = '${manifest.archive.sha256}' ] || { echo 'Upload checksum mismatch' >&2; exit 1; }; mkdir -p ${quoteSh(unpacked)} ${quoteSh(paths.dirname(destination))}; tar -xzf ${quoteSh(remoteArchive)} -C ${quoteSh(unpacked)}; if [ -d ${quoteSh(destination)} ]; then rm -rf ${quoteSh(unpacked)}; else mv ${quoteSh(unpacked)} ${quoteSh(destination)}; fi`;
      await runSsh(profile, extract, undefined, 180_000, signal, authentication);
      const installed: RemoteInstallation = { entry: paths.join(destination, "host.mjs"), node: paths.join(destination, "node", environment.platform === "win32" ? "node.exe" : "bin/node"), state: paths.join(environment.root, "state"), bundleVersion: manifest.hostSha256, environmentVersion: manifest.archive.sha256 };
      environment.node = installed.node!; environment.version = manifest.nodeVersion;
      const keys = Object.fromEntries(Object.entries(this.options.keys).map(([id, key]) => [id, key.toString()]));
      await runSsh(profile, remoteNodeCommand(environment, `const fs=require('node:fs'),p=require('node:path');if(process.platform!==${JSON.stringify(environment.platform)}||process.arch!==${JSON.stringify(environment.arch)})throw Error('Private Node target mismatch');const root=${JSON.stringify(destination)},keys=p.join(root,'trusted-keys');fs.mkdirSync(keys,{recursive:true,mode:448});const map={};for(const [id,key]of Object.entries(${JSON.stringify(keys)})){const name='key-'+Object.keys(map).length+'.pem';fs.writeFileSync(p.join(keys,name),key,{mode:384});map[id]=name;}fs.writeFileSync(p.join(keys,'trusted-keys.json'),JSON.stringify({keys:map}),{mode:384});`), undefined, 30_000, signal, authentication);
      // start checks the existing Host's busy guard before replacing it.
      await this.start(profile, environment, installed, authentication, signal);
      const { attachRemote } = await import("./deploy.js");
      const transport = await attachRemote(profile, environment, installed, signal, authentication);
      try {
        await transport.bootstrap();
        await transport.peer.request("shutdown");
      } finally { await transport.close(); }
      progress("verify", desktopText("正在验证并激活签名 Runtime", "Verifying and activating signed Runtime"));
      const install = `const cp=require('node:child_process');try{cp.execFileSync(process.execPath,${JSON.stringify([installed.entry, "install", "--state", installed.state, "--keys", paths.join(destination, "trusted-keys"), "--artifact", paths.join(destination, "runtime")])},{stdio:['ignore','pipe','pipe'],timeout:180000,windowsHide:true});}catch(e){process.stderr.write(String(e.stderr||e.message));process.exitCode=1;}`;
      await runSsh(profile, remoteNodeCommand(environment, install), undefined, 200_000, signal, authentication);
      await this.start(profile, environment, installed, authentication, signal);
      await runSsh(profile, remoteNodeCommand(environment, `const fs=require('node:fs');const file=${JSON.stringify(marker)},tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(${JSON.stringify({ ...installed, appVersion: this.options.appVersion, protocolVersion: REMOTE_PROTOCOL_VERSION, envelope })}),{mode:384});fs.renameSync(tmp,file);fs.rmSync(${JSON.stringify(stage)},{recursive:true,force:true});`), undefined, 30_000, signal, authentication);
      activated = true;
      return installed;
    } finally {
      if (!activated) {
        const cleanup = environment.platform === "win32"
          ? powershellCommand(`if(Test-Path -LiteralPath ${quotePs(stage)}){Remove-Item -LiteralPath ${quotePs(stage)} -Recurse -Force -ErrorAction SilentlyContinue}`)
          : `rm -rf -- ${quoteSh(stage)}`;
        await runSsh(profile, cleanup, undefined, 15_000, undefined, authentication).catch(() => {});
      }
    }
  }
  private async start(profile: RemoteConnectionProfile, environment: RemoteEnvironment, installed: RemoteInstallation, authentication: SshAuthentication | undefined, signal: AbortSignal): Promise<void> {
    let input: Buffer | undefined;
    if (profile.kind === "wsl") {
      try {
        const marker = "__OMP_ENV__\n";
        const capture = await runSsh(profile, '"${SHELL:-/bin/sh}" -lic ' + quoteSh('printf "\\n__OMP_ENV__\\n"; env -0') + ' </dev/null 2>/dev/null', undefined, 10_000, signal);
        const offset = capture.indexOf(marker);
        if (offset === -1) throw new Error("Login environment marker missing");
        const entries = capture.slice(offset + marker.length).split("\0").filter(Boolean).map(item => {
          const separator = item.indexOf("=");
          return [item.slice(0, separator), item.slice(separator + 1)] as const;
        }).filter(([key]) => !/^(?:PWD|OLDPWD|SHLVL|_|PS1|PS2|PROMPT_COMMAND|TERM|COLUMNS|LINES|STY|WSL_INTEROP|HIST.*|TMUX.*)$/u.test(key));
        input = Buffer.from(JSON.stringify(Object.fromEntries(entries)));
      } catch {
        signal.throwIfAborted();
        this.options.logEnvironmentFallback?.();
      }
    }
    const readEnvironment = input ? "Object.assign(process.env,JSON.parse(require('node:fs').readFileSync(0,'utf8')));" : "";
    const script = `${readEnvironment}const cp=require('node:child_process');try{cp.execFileSync(process.execPath,${JSON.stringify([installed.entry, "start", "--state", installed.state])},{timeout:90000,stdio:['ignore','pipe','pipe'],windowsHide:true});}catch(e){process.stderr.write(String(e.stderr||e.message));process.exitCode=1;}`;
    await runSsh(profile, remoteNodeCommand(environment, script), input, 105_000, signal, authentication);
  }
}
