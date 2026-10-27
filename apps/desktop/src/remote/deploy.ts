import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { sshArguments, systemSshExecutable, type RemotePlatform, type SshConnection } from "./platform.js";
import { SshRemoteTransport } from "./transport.js";
import { sshAuthenticationRequest, type SshAuthentication } from "./authentication.js";
import { RemoteConnectionError, connectionCancelled, sshFailure } from "./errors.js";
import type { RemoteAttachment } from "./wire.js";

export interface RemoteEnvironment {
  platform: RemotePlatform; arch: string; home: string; node: string; version: string; root: string;
  shell?: "posix" | "powershell";
}
export interface RemoteInstallation { entry: string; state: string; bundleVersion?: string; node?: string; environmentVersion?: string; }

export async function runSsh(connection: SshConnection, command: string, input?: Buffer | Readable, timeoutMs = 30_000, signal?: AbortSignal, authentication?: SshAuthentication): Promise<string> {
  signal?.throwIfAborted();
  const authenticationRequest = sshAuthenticationRequest(connection, authentication);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(systemSshExecutable(), [...sshArguments(connection), command], { stdio: "pipe", windowsHide: true, ...(authenticationRequest ? { env: authenticationRequest.env } : {}) });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cancel = (): void => finish(connectionCancelled());
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (input instanceof Readable) { input.unpipe(child.stdin); input.destroy(); }
      if (error) { child.kill(); reject(error); } else resolve(stdout.trim());
    };
    const timer = setTimeout(() => finish(new RemoteConnectionError("network", "SSH 操作超时；已发送操作的结果未知，未自动重发")), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", chunk => { stdout += String(chunk); if (stdout.length > 1024 * 1024) finish(new Error("SSH response exceeded its limit")); });
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    child.once("error", error => finish(sshFailure("", error)));
    child.stdin.on("error", error => { if (!["EPIPE", "EOF", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "")) finish(sshFailure("", error)); });
    child.once("close", code => finish(code === 0 ? undefined : sshFailure(stderr, undefined, code)));
    if (signal?.aborted) { cancel(); return; }
    if (input instanceof Readable) { input.once("error", finish); input.pipe(child.stdin); }
    else child.stdin.end(input);
  }).finally(() => authenticationRequest?.dispose());
}

export function nodeRemoteCommand(script: string, executable = "node"): string {
  const encoded = Buffer.from(script).toString("base64");
  return `${executable === "node" ? "node" : `"${executable}"`} -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

export async function probeRemote(connection: SshConnection, signal?: AbortSignal, authentication?: SshAuthentication): Promise<RemoteEnvironment> {
  const { detectRemoteEnvironment } = await import("./probe.js");
  return detectRemoteEnvironment(connection, signal, authentication);
}

export async function deployRemote(connection: SshConnection, environment: RemoteEnvironment, bundleDirectory: string, signal?: AbortSignal, authentication?: SshAuthentication): Promise<RemoteInstallation> {
  const bytes = await readFile(join(bundleDirectory, "host.mjs"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const result = JSON.parse(await runSsh(connection, nodeRemoteCommand(`
    const fs=require('node:fs'),p=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
    const root=${JSON.stringify(environment.root)},hash=${JSON.stringify(sha256)};
    const dir=p.join(root,'versions',hash),entry=p.join(dir,'host.mjs'),state=p.join(root,'state');
    const chunks=[];let size=0;
    process.stdin.on('data',c=>{size+=c.length;if(size>16*1024*1024)throw Error('Host bundle too large');chunks.push(c)});
    process.stdin.on('end',()=>{
      const data=Buffer.concat(chunks);if(crypto.createHash('sha256').update(data).digest('hex')!==hash)throw Error('Host bundle checksum mismatch');
      fs.mkdirSync(dir,{recursive:true,mode:448});
      if(fs.existsSync(entry)){if(crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex')!==hash)throw Error('Installed Host bundle is corrupt');}
      else fs.writeFileSync(entry,data,{flag:'wx',mode:384});
      try { cp.execFileSync(process.execPath,[entry,'start','--state',state],{timeout:90000,stdio:['ignore','pipe','pipe'],windowsHide:true}); }
      catch(error){process.stderr.write(String(error.stderr||error.message));process.exitCode=1;return;}
      process.stdout.write(JSON.stringify({entry,state,bundleVersion:hash}));
    });
  `, environment.node), bytes, 105_000, signal, authentication)) as RemoteInstallation;
  return result;
}

export async function attachRemote(connection: SshConnection, environment: RemoteEnvironment, installation: RemoteInstallation, signal?: AbortSignal, authentication?: SshAuthentication, attachment?: RemoteAttachment, networkChannel = false): Promise<SshRemoteTransport> {
  const script = `const cp=require('node:child_process');const c=cp.spawn(process.execPath,${JSON.stringify([installation.entry, networkChannel ? "network" : "attach", "--state", installation.state])},{stdio:'inherit',windowsHide:true});c.on('exit',code=>process.exitCode=code||0);c.on('error',e=>{process.stderr.write(e.message);process.exitCode=1});`;
  const { remoteNodeCommand } = await import("./remote-command.js");
  return SshRemoteTransport.connect({ connection, shell: environment.platform === "win32" ? "cmd" : "posix", executable: "node", args: [], launchCommand: remoteNodeCommand(environment, script, installation.node), expectedPlatform: environment.platform, networkChannel, ...(installation.bundleVersion ? { expectedBundleVersion: installation.bundleVersion } : {}), ...(signal ? { signal } : {}), ...(authentication ? { authentication } : {}), ...(attachment ? { attachment } : {}) });
}
