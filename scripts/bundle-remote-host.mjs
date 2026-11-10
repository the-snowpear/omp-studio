import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildSshAskpass } from "./build-ssh-askpass.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export async function copyRemoteHostBundle(source, destination) {
  const manifest = JSON.parse(await readFile(join(source, "host.json"), "utf8"));
  await mkdir(destination, { recursive: true });
  for (const entry of [{ name: "host.mjs", sha256: manifest.sha256 }, ...(manifest.files ?? [])]) {
    if (entry.name !== "host.mjs" && !/^archive-worker-[a-f0-9]{64}\.mjs$/.test(entry.name)) throw new Error("Unexpected Host artifact");
    const bytes = await readFile(join(source, entry.name));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("Host artifact checksum mismatch");
    await writeFile(join(destination, entry.name), bytes);
  }
  await cp(join(source, "host.json"), join(destination, "host.json"));
}
export async function bundleRemoteHost(output = join(root, "apps/desktop/dist/remote-host")) {
  const { build } = createRequire(join(root, "package.json"))("esbuild");
  await mkdir(output, { recursive: true });
  const archive = await build({ absWorkingDir: root, entryPoints: ["packages/studio-host/src/session-archive-worker.ts"], bundle: true, platform: "node", target: "node22", format: "esm", write: false, logLevel: "warning" });
  const workerBytes = archive.outputFiles[0].contents;
  const workerHash = createHash("sha256").update(workerBytes).digest("hex");
  const workerName = `archive-worker-${workerHash}.mjs`;
  await writeFile(join(output, workerName), workerBytes);
  await build({ absWorkingDir: root, entryPoints: ["apps/desktop/src/remote/main.ts"], bundle: true, platform: "node", target: "node22", format: "esm", external: ["electron", "node-pty"], outfile: join(output, "host.mjs"), logLevel: "warning", define: { __OMP_ARCHIVE_WORKER_FILE__: JSON.stringify(`./${workerName}`) }, banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
  await buildSshAskpass();
  const bytes = await readFile(join(output, "host.mjs"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(output, "host.json"), JSON.stringify({ version: 1, sha256, bytes: bytes.length, files: [{ name: workerName, sha256: workerHash, bytes: workerBytes.length }] }));
  return { directory: output, sha256, bytes: bytes.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await bundleRemoteHost(process.argv[2]));
