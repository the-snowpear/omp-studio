import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRemoteBundle, remoteInstallScript } from "../src/remote/deploy.js";

test("remote installation deploys and verifies the Worker before starting the new Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-deploy-worker-")), bundle = join(root, "bundle");
  await mkdir(bundle);
  const worker = Buffer.from('import {parentPort} from "node:worker_threads"; parentPort.postMessage("ready");');
  const hash = createHash("sha256").update(worker).digest("hex"), name = `archive-worker-${hash}.mjs`;
  await writeFile(join(bundle, name), worker);
  await writeFile(join(bundle, "host.mjs"), `import {Worker} from "node:worker_threads"; const w=new Worker(new URL("./${name}",import.meta.url)); w.once("message",async value=>{if(value!=="ready")process.exitCode=1;await w.terminate()});`);
  await writeFile(join(bundle, "host.json"), JSON.stringify({ files: [{ name, sha256: hash }] }));
  const payload = await loadRemoteBundle(bundle);
  const script = remoteInstallScript(join(root, "remote"), payload.sha256, payload.payloadHash);
  const install = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: "pipe" });
    let output = "", errors = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errors += data; });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(errors)));
    child.stdin.end(payload.payload);
  });
  const installed = JSON.parse(await install());
  assert.equal(installed.bundleVersion, payload.sha256);
  assert.deepEqual(await readFile(join(root, "remote", "versions", payload.sha256, name)), worker);
  assert.equal(JSON.parse(await install()).entry, installed.entry);
});
