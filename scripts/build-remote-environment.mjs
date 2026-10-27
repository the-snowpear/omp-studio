import { createHash, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { verifySignedArtifact, parseRuntimeInstallationManifest, RUNTIME_ARTIFACT_LAYOUT, remoteEnvironmentSigningBytes } from "../packages/runtime-installer/dist/src/index.js";
import { REMOTE_PROTOCOL_VERSION } from "../apps/desktop/dist/src/remote/wire.js";
import { assertExecutableTarget, assertNativeTargetBuild, resolveTargetPlatform } from "./target-platform.mjs";
import { readRuntimeSigningKeys } from "./runtime-signing-keys.mjs";
import { defaultArtifactDirectory, deriveRuntimeVersion, readPatchSeries, readUpstreamVersion } from "./runtime-artifact.mjs";

export const PRIVATE_NODE_VERSION = "24.17.0";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function hashFile(path) { const digest = createHash("sha256"); for await (const bytes of createReadStream(path)) digest.update(bytes); return digest.digest("hex"); }
async function signingKey() {
  if (process.env.OMP_RUNTIME_SIGNING_KEY && process.env.OMP_RUNTIME_SIGNING_KEY_ID) return { keyId: process.env.OMP_RUNTIME_SIGNING_KEY_ID, privateKey: await readFile(process.env.OMP_RUNTIME_SIGNING_KEY) };
  return readRuntimeSigningKeys();
}
async function download(url, path) {
  const response = await fetch(url); if (!response.ok) throw new Error(`Download ${response.status}: ${url}`);
  await writeFile(path, new Uint8Array(await response.arrayBuffer()));
}
function ps(script) { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "inherit", windowsHide: true }); }
const quotePs = text => `'${text.replaceAll("'", "''")}'`;

/** Release-time complete archive; the remote machine downloads no dependencies. */
export async function buildRemoteEnvironment(options = {}) {
  const platform = options.platform ?? resolveTargetPlatform();
  assertNativeTargetBuild(platform);
  const appVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? "the-snowpear/omp-studio";
  const runtime = options.runtime ?? process.env.OMP_ARTIFACT_DIR ?? defaultArtifactDirectory(platform, deriveRuntimeVersion(await readUpstreamVersion(), await readPatchSeries()));
  const table = JSON.parse(await readFile(join(root, "packaging/keys/trusted-keys.json"), "utf8"));
  const keys = Object.fromEntries(await Promise.all(Object.entries(table.keys).map(async ([id, name]) => [id, await readFile(join(root, "packaging/keys", name))])));
  const verified = await verifySignedArtifact({ directory: runtime, layout: RUNTIME_ARTIFACT_LAYOUT, parseManifest: parseRuntimeInstallationManifest, requireCovered: m => ["runtime-manifest.json", m.entrypoint], trustedKeys: options.trustedKeys ?? keys });
  if (verified.manifest.platform !== platform) throw new Error("Remote Runtime target mismatch");
  const output = options.output ?? join(root, "outputs/remote-environments", platform); await mkdir(output, { recursive: true });
  const stage = await mkdtemp(join(tmpdir(), "omp-remote-environment-"));
  try {
    const payload = join(stage, "payload"); await mkdir(payload);
    const os = platform.split("-")[0], arch = platform.split("-")[1];
    const distribution = `node-v${PRIVATE_NODE_VERSION}-${os === "win32" ? "win" : os}-${arch}`;
    const name = `${distribution}.${os === "win32" ? "zip" : "tar.gz"}`;
    const archive = options.nodeArchive ?? join(stage, name);
    if (!options.nodeArchive) {
      await download(`https://nodejs.org/dist/v${PRIVATE_NODE_VERSION}/${name}`, archive);
      const response = await fetch(`https://nodejs.org/dist/v${PRIVATE_NODE_VERSION}/SHASUMS256.txt`);
      if (!response.ok) throw new Error("Node checksums unavailable");
      const expected = (await response.text()).split(/\r?\n/u).find(line => line.endsWith(`  ${name}`))?.slice(0, 64);
      if (!expected || await hashFile(archive) !== expected) throw new Error("Official Node archive checksum mismatch");
    }
    if (os === "win32") ps(`Expand-Archive -LiteralPath ${quotePs(archive)} -DestinationPath ${quotePs(stage)}`);
    else execFileSync("tar", ["-xzf", archive, "-C", stage]);
    await mkdir(join(payload, "node", os === "win32" ? "" : "bin"), { recursive: true });
    const nodeName = os === "win32" ? "node.exe" : "bin/node";
    const nodePath = join(payload, "node", nodeName);
    await cp(join(stage, distribution, nodeName), nodePath); if (os !== "win32") await chmod(nodePath, 0o755);
    assertExecutableTarget(nodePath, platform);
    const identity = execFileSync(nodePath, ["-p", "JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node})"], { encoding: "utf8", windowsHide: true });
    if (JSON.parse(identity).version !== PRIVATE_NODE_VERSION) throw new Error("Private Node version mismatch");
    await cp(join(root, "apps/desktop/dist/remote-host/host.mjs"), join(payload, "host.mjs"));
    await mkdir(join(payload, "runtime"));
    for (const name of ["runtime-manifest.json", "runtime-signature.json", "checksums.json", verified.manifest.entrypoint]) await cp(join(runtime, name), join(payload, "runtime", name));
    if (os !== "win32") await chmod(join(payload, "runtime", verified.manifest.entrypoint), 0o755);
    const asset = `omp-studio-remote-${appVersion}-${platform}.${os === "win32" ? "zip" : "tar.gz"}`;
    const file = join(output, asset);
    if (os === "win32") {
      const { zipSync } = createRequire(import.meta.url)("fflate");
      const files = {};
      const collect = async (path, prefix = "") => { for (const entry of await readdir(path, { withFileTypes: true })) { const next = prefix + entry.name; if (entry.isDirectory()) await collect(join(path, entry.name), `${next}/`); else files[next] = await readFile(join(path, entry.name)); } };
      await collect(payload); await writeFile(file, zipSync(files, { level: 1 }));
    } else execFileSync("tar", ["-czf", file, "-C", payload, "."]);
    const bytes = await readFile(file);
    const manifest = { schema: 1, repo, platform, appVersion, runtimeVersion: verified.manifest.runtimeVersion, nodeVersion: PRIVATE_NODE_VERSION, protocolVersion: REMOTE_PROTOCOL_VERSION, hostSha256: hash(await readFile(join(payload, "host.mjs"))), nodeSha256: await hashFile(nodePath), archive: { asset, url: `https://github.com/${repo}/releases/download/v${appVersion}/${asset}`, size: bytes.length, sha256: hash(bytes) } };
    const key = await signingKey();
    const envelope = { manifest, signature: { algorithm: "ed25519", keyId: key.keyId, value: sign(null, remoteEnvironmentSigningBytes(manifest), key.privateKey).toString("base64url") } };
    await writeFile(join(output, `remote-environment-${platform}.json`), JSON.stringify(envelope, null, 2));
    console.log(`Remote environment ready: ${platform} ${manifest.runtimeVersion} (${bytes.length} bytes)`);
    return { file, envelope };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildRemoteEnvironment();
