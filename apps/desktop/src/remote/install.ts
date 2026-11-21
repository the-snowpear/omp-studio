import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { extractRuntimeArchive, verifySignedArtifact, parseRuntimeInstallationManifest, RUNTIME_ARTIFACT_LAYOUT } from "@omp-studio/runtime-installer";
import { runSsh } from "./deploy.js";
import { remoteNodeCommand } from "./remote-command.js";
import { hasActiveRemoteWork } from "./server.js";
import { uploadRemoteFile } from "./file-transfer.js";
import type { RemoteConnectionManager, RemoteMaintenance } from "./manager.js";
import { desktopText } from "../desktop-language-shared.js";

export async function installRemoteRuntime(manager: RemoteConnectionManager, id: string, archive: string, trustedKeys: Readonly<Record<string, string | Buffer>>): Promise<void> {
  return manager.maintenance(id, controls => install(manager, id, archive, trustedKeys, controls));
}

async function install(manager: RemoteConnectionManager, id: string, archive: string, trustedKeys: Readonly<Record<string, string | Buffer>>, controls: RemoteMaintenance): Promise<void> {
  const remote = manager.get(id);
  const profile = manager.profile(id);
  const authentication = manager.authentication(id);
  const remotePath = remote.environment.platform === "win32" ? win32 : posix;
  const temp = await mkdtemp(join(tmpdir(), "omp-remote-runtime-"));
  const stageName = `runtime-upload-${randomUUID()}`;
  let installDispatched = false;
  let shutdownRequested = false;
  try {
    await extractRuntimeArchive(archive, join(temp, "artifact"));
    const { manifest } = await verifySignedArtifact({ directory: join(temp, "artifact"), layout: RUNTIME_ARTIFACT_LAYOUT, parseManifest: parseRuntimeInstallationManifest, requireCovered: value => ["runtime-manifest.json", value.entrypoint], trustedKeys });
    if (manifest.platform !== `${remote.environment.platform}-${remote.environment.arch}`) throw new Error(desktopText(`制品目标 ${manifest.platform} 与远端不匹配`, `Artifact target ${manifest.platform} does not match the remote machine`));
    if (hasActiveRemoteWork(await remote.transport.bootstrap())) throw new Error(desktopText("请先完成远端任务和待处理审批，再安装 Runtime", "Please finish remote tasks and pending approvals before installing Runtime"));
    for (const name of ["runtime-manifest.json", "checksums.json", "runtime-signature.json", manifest.entrypoint]) {
      controls.progress(desktopText(`正在上传 ${name}`, `Uploading ${name}`));
      const file = join(temp, "artifact", name);
      const remoteFile = remotePath.join(remote.state, stageName, name);
      await uploadRemoteFile({ connection: profile, platform: remote.environment.platform, localPath: file, remoteDirectory: remotePath.join(remote.state, stageName), remotePath: remoteFile, ...(authentication ? { authentication } : {}) });
    }
    controls.progress(desktopText("正在停止空闲 Host 并安装 Runtime", "Stopping idle Host and installing Runtime"));
    shutdownRequested = true;
    await remote.transport.peer.request("shutdown");
    await controls.disconnect();
    const keys = Object.fromEntries(Object.entries(trustedKeys).map(([keyId, key]) => [keyId, key.toString()]));
    installDispatched = true;
    await runSsh(profile, remoteNodeCommand(remote.environment, `
      const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');
      const state=${JSON.stringify(remote.state)},stage=p.join(state,${JSON.stringify(stageName)}),keys=p.join(state,${JSON.stringify(`${stageName}-keys`)}),values=${JSON.stringify(keys)};
      try {
        fs.mkdirSync(keys,{mode:448});
        const mapping={};
        for(const [id,key]of Object.entries(values)){const name='key-'+Object.keys(mapping).length+'.pem';fs.writeFileSync(p.join(keys,name),key,{flag:'wx',mode:384});mapping[id]=name;}
        fs.writeFileSync(p.join(keys,'trusted-keys.json'),JSON.stringify({keys:mapping}),{flag:'wx',mode:384});
        cp.execFileSync(process.execPath,[${JSON.stringify(remote.entry)},'install','--state',state,'--keys',keys,'--artifact',stage],{timeout:180000,stdio:['ignore','pipe','pipe']});
        process.stdout.write('installed');
      } catch(error) { process.stderr.write(String(error.stderr||error.message));process.exitCode=1; }
      finally { fs.rmSync(stage,{recursive:true,force:true});fs.rmSync(keys,{recursive:true,force:true}); }
    `, remote.node), undefined, 200_000, undefined, authentication);
  } finally {
    await rm(temp, { recursive: true, force: true });
    if (!installDispatched) {
      await runSsh(profile, remoteNodeCommand(remote.environment, `require('node:fs').rmSync(require('node:path').join(${JSON.stringify(remote.state)},${JSON.stringify(stageName)}),{recursive:true,force:true});`, remote.node), undefined, 30_000, undefined, authentication).catch(() => {});
    }
    if (shutdownRequested) {
      controls.progress(desktopText("正在重新连接远端 Host", "Reconnecting to remote Host"));
      await controls.reconnect();
    }
  }
}
