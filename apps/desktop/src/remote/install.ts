import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { extractRuntimeArchive, verifySignedArtifact, parseRuntimeInstallationManifest, RUNTIME_ARTIFACT_LAYOUT } from "@omp-studio/runtime-installer";
import { runSsh, nodeRemoteCommand } from "./deploy.js";
import { hasActiveRemoteWork } from "./server.js";
import type { RemoteConnectionManager, RemoteMaintenance } from "./manager.js";

export async function installRemoteRuntime(manager: RemoteConnectionManager, id: string, archive: string, trustedKeys: Readonly<Record<string, string | Buffer>>): Promise<void> {
  return manager.maintenance(id, controls => install(manager, id, archive, trustedKeys, controls));
}

async function install(manager: RemoteConnectionManager, id: string, archive: string, trustedKeys: Readonly<Record<string, string | Buffer>>, controls: RemoteMaintenance): Promise<void> {
  const remote = manager.get(id);
  const profile = manager.profile(id);
  const authentication = manager.authentication(id);
  const temp = await mkdtemp(join(tmpdir(), "omp-remote-runtime-"));
  const stageName = `runtime-upload-${randomUUID()}`;
  let installDispatched = false;
  let shutdownRequested = false;
  try {
    await extractRuntimeArchive(archive, join(temp, "artifact"));
    const { manifest } = await verifySignedArtifact({ directory: join(temp, "artifact"), layout: RUNTIME_ARTIFACT_LAYOUT, parseManifest: parseRuntimeInstallationManifest, requireCovered: value => ["runtime-manifest.json", value.entrypoint], trustedKeys });
    if (manifest.platform !== `${remote.environment.platform}-${remote.environment.arch}`) throw new Error(`制品目标 ${manifest.platform} 与远端不匹配`);
    if (hasActiveRemoteWork(await remote.transport.bootstrap())) throw new Error("请先完成远端任务和待处理审批，再安装 Runtime");
    for (const name of ["runtime-manifest.json", "checksums.json", "runtime-signature.json", manifest.entrypoint]) {
      controls.progress(`正在上传 ${name}`);
      const file = join(temp, "artifact", name);
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(file)) digest.update(chunk);
      const hash = digest.digest("hex");
      await runSsh(profile, nodeRemoteCommand(`
        const fs=require('node:fs'),p=require('node:path'),crypto=require('node:crypto'),{pipeline}=require('node:stream');
        const dir=p.join(${JSON.stringify(remote.state)},${JSON.stringify(stageName)});
        fs.mkdirSync(dir,{recursive:true,mode:448});
        const file=p.join(dir,${JSON.stringify(name)}),out=fs.createWriteStream(file,{flags:'wx',mode:448}),hash=crypto.createHash('sha256');
        process.stdin.on('data',data=>hash.update(data));
        pipeline(process.stdin,out,error=>{
          if(error){process.stderr.write(error.message);process.exitCode=1;return;}
          if(hash.digest('hex')!==${JSON.stringify(hash)}){process.stderr.write('Upload checksum mismatch');process.exitCode=1;return;}
          process.stdout.write('ok');
        });
      `), createReadStream(file), 600_000, undefined, authentication);
    }
    controls.progress("正在停止空闲 Host 并安装 Runtime");
    shutdownRequested = true;
    await remote.transport.peer.request("shutdown");
    await controls.disconnect();
    const keys = Object.fromEntries(Object.entries(trustedKeys).map(([keyId, key]) => [keyId, key.toString()]));
    installDispatched = true;
    await runSsh(profile, nodeRemoteCommand(`
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
    `), undefined, 200_000, undefined, authentication);
  } finally {
    await rm(temp, { recursive: true, force: true });
    if (!installDispatched) {
      await runSsh(profile, nodeRemoteCommand(`require('node:fs').rmSync(require('node:path').join(${JSON.stringify(remote.state)},${JSON.stringify(stageName)}),{recursive:true,force:true});`), undefined, 30_000, undefined, authentication).catch(() => {});
    }
    if (shutdownRequested) {
      controls.progress("正在重新连接远端 Host");
      await controls.reconnect();
    }
  }
}
