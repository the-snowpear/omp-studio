import { createHash, sign } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap.js";
import { createRuntimeArchive, verifySignedArtifact, RUNTIME_ARTIFACT_LAYOUT, parseRuntimeInstallationManifest, verifyUpdateManifest, updateSigningBytes, createTrustedKeyVerifier, parseRuntimeSignatureManifest } from "@omp-studio/runtime-installer";
import { STUDIO_PROTOCOL_VERSION } from "@omp-studio/studio-protocol";
import { resolveTargetArch } from "./windows-architecture.mjs";
import { compareRuntimeVersions } from "../apps/desktop/dist/src/runtime-install.js";

export async function releaseKeys(root) {
  const table = JSON.parse(await readFile(join(root, "packaging/keys/trusted-keys.json"), "utf8"));
  const keys = {};
  for (const [id, name] of Object.entries(table.keys)) keys[id] = await readFile(join(root, "packaging/keys", name));
  return keys;
}
export async function describeFile(path, baseUrl) {
  const data = await readFile(path);
  return { asset: basename(path), url: `${baseUrl}/${basename(path)}`, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), sha512: createHash("sha512").update(data).digest("base64") };
}
export async function buildUpdateAssetsV2(options = {}) {
  const useEnvironment = options.useEnvironment ?? options.signingKey === undefined;
  const root = options.root ?? resolve(".");
  const arch = options.arch ?? resolveTargetArch(), platform = `win32-${arch}`;
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? "the-snowpear/omp-studio";
  const appVersion = options.appVersion ?? JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const runtimeOnly = options.runtimeOnly ?? (useEnvironment && process.env.OMP_RELEASE_KIND === "runtime");
  const out = options.out ?? join(root, "outputs/release", arch);
  await mkdir(out, { recursive: true });
  const keys = options.keys ?? await releaseKeys(root);
  const signingKey = options.signingKey ?? await readFile(process.env.OMP_RUNTIME_SIGNING_KEY);
  const keyId = options.keyId ?? process.env.OMP_RUNTIME_SIGNING_KEY_ID;
  if (!keys[keyId]) throw new Error("Release signing key is not trusted");
  let runtimeDir = options.runtimeDir;
  if (!runtimeDir) {
    const dirs = await readdir(join(root, "packaging/runtime-payload"), { withFileTypes: true });
    const versions = dirs.filter(d => d.isDirectory() && !d.name.startsWith("."));
    if (versions.length !== 1) throw new Error("Expected exactly one staged Runtime");
    runtimeDir = join(root, "packaging/runtime-payload", versions[0].name);
  }
  const verified = await verifySignedArtifact({ directory: runtimeDir, layout: RUNTIME_ARTIFACT_LAYOUT, parseManifest: parseRuntimeInstallationManifest, requireCovered: m => ["runtime-manifest.json", m.entrypoint], trustedKeys: keys });
  const rt = verified.manifest;
  if (rt.platform !== platform) throw new Error("Runtime architecture mismatch");
  const tag = options.tag ?? (useEnvironment ? process.env.OMP_RELEASE_TAG : undefined) ?? (runtimeOnly ? `runtime-v${rt.runtimeVersion}` : `v${appVersion}`);
  if (!/^(?:v|runtime-v)[\w.-]+$/.test(tag)) throw new Error("Invalid release tag");
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  const previous = [];
  if (options.previous) previous.push(...options.previous.map(v => verifyUpdateManifest(v, keys, repo, platform)));
  const previousDir = options.previousCatalogDir ?? (useEnvironment ? process.env.OMP_PREVIOUS_CATALOG_DIR : undefined);
  if (previousDir) for (const entry of await readdir(previousDir)) if (entry.endsWith(".json")) previous.push(verifyUpdateManifest(JSON.parse(await readFile(join(previousDir, entry), "utf8")), keys, repo, platform));
  // A desktop seed must never move an independently published channel backwards.
  // Check all history, including catalogs produced before this guard existed.
  for (const envelope of previous) {
    const published = envelope.manifest.runtime;
    if (!published || published.channel !== rt.channel) continue;
    const order = compareRuntimeVersions(rt.runtimeVersion, published.version);
    if (order === undefined) throw new Error("Cannot order Runtime release versions");
    if (order < 0) throw new Error(`Runtime ${rt.runtimeVersion} would hide newer published Runtime ${published.version}; use the newer signed Runtime`);
  }
  // An old desktop tag must never shadow a newer published desktop: consumers
  // only follow the highest app sequence, which this build is about to mint.
  if (!runtimeOnly) {
    for (const envelope of previous) {
      const published = envelope.manifest.app;
      if (!published || published.channel !== "stable") continue;
      const order = compareRuntimeVersions(appVersion, published.version);
      if (order === undefined) throw new Error("Cannot order app release versions");
      if (order < 0) throw new Error(`App ${appVersion} would hide newer published app ${published.version}; use the newer desktop tag`);
    }
  }
  const nextSequence = (kind, channel) => 1 + Math.max(0, ...previous.map(e => e.manifest[kind]?.channel === channel ? e.manifest[kind].sequence : 0));
  const archivePath = join(out, `OMP-Studio-Runtime-${rt.runtimeVersion}-windows-${arch}.zip`);
  await createRuntimeArchive(runtimeDir, archivePath);
  await buildBlockMap(archivePath, "gzip", `${archivePath}.blockmap`);
  const runtime = { version: rt.runtimeVersion, sequence: nextSequence("runtime", rt.channel), channel: rt.channel,
    file: await describeFile(archivePath, base), blockmap: await describeFile(`${archivePath}.blockmap`, base),
    minAppVersion: options.runtimeMinAppVersion ?? ((useEnvironment ? process.env.OMP_RUNTIME_MIN_APP_VERSION?.trim() : undefined) || appVersion),
    studioProtocol: rt.studioProtocol };
  // Reuse an immutable Runtime version only when its exact signed bytes match.
  const oldRuntime = previous.map(e => e.manifest.runtime).find(r => r?.version === runtime.version);
  if (oldRuntime && (oldRuntime.file.sha256 !== runtime.file.sha256 || oldRuntime.channel !== runtime.channel)) throw new Error("Runtime version reused with different bytes or channel");
  const manifest = { schema: 2, repo, platform, generatedAt: new Date().toISOString(), releaseNotesUrl: `https://github.com/${repo}/releases/tag/${tag}`, runtime };
  if (!runtimeOnly) {
    const setup = options.setupPath ?? join(root, `outputs/installer/OMP-Studio-Setup-${appVersion}-windows-${arch}.exe`);
    const dest = join(out, basename(setup));
    if (resolve(setup) !== resolve(dest)) await cp(setup, dest);
    await buildBlockMap(dest, "gzip", `${dest}.blockmap`);
    manifest.app = { version: appVersion, sequence: nextSequence("app", "stable"), channel: "stable",
      file: await describeFile(dest, base), blockmap: await describeFile(`${dest}.blockmap`, base), minAppVersion: "0.0.0",
      studioProtocol: { min: STUDIO_PROTOCOL_VERSION, max: STUDIO_PROTOCOL_VERSION }, bundledRuntimeVersion: rt.runtimeVersion };
  }
  const envelope = { manifest, signature: { algorithm: "ed25519", keyId, value: sign(null, updateSigningBytes(manifest), signingKey).toString("base64url") } };
  verifyUpdateManifest(envelope, keys, repo, platform);
  await writeFile(join(out, `updates-${platform}.json`), JSON.stringify(envelope, null, 2) + "\n");
  const previousPath = options.previousIndex ?? (useEnvironment ? process.env.OMP_PREVIOUS_UPDATE_INDEX : undefined);
  if (!runtimeOnly && previousPath) await buildMigrationIndex({ previousPath, out, arch, manifest, keys, signingKey, keyId });
  const notes = releaseNotes(manifest);
  await writeFile(join(out, "release-notes.md"), notes);
  return { manifest, out, notes };
}
export async function buildMigrationIndex({ previousPath, out, arch, manifest, keys, signingKey, keyId }) {
  const bytes = await readFile(previousPath);
  const signature = parseRuntimeSignatureManifest(JSON.parse(await readFile(previousPath.replace(/\.json$/, ".sig.json"), "utf8")));
  if (signature.payloadSha256 !== createHash("sha256").update(bytes).digest("hex") || !createTrustedKeyVerifier(keys).verify(signature, bytes)) throw new Error("Previous migration index signature invalid");
  const old = JSON.parse(bytes.toString("utf8"));
  if (old.repo !== manifest.repo || old.runtime.platform !== manifest.platform) throw new Error("Migration index identity mismatch");
  const name = arch === "x64" ? "update-index" : "update-index-win32-arm64";
  if (old.app.releaseNotesUrl?.endsWith("#update-v2-migration")) {
    await cp(previousPath, join(out, `${name}.json`));
    await cp(previousPath.replace(/\.json$/, ".sig.json"), join(out, `${name}.sig.json`));
    return;
  }
  const { sha512: _sha512, ...setup } = manifest.app.file;
  const value = { schema: 1, sequence: old.sequence + 1, generatedAt: manifest.generatedAt, repo: manifest.repo,
    app: { version: manifest.app.version, setup, releaseNotesUrl: `${manifest.releaseNotesUrl}#update-v2-migration` },
    runtime: { ...old.runtime, minAppVersion: manifest.app.version } };
  const payload = Buffer.from(JSON.stringify(value));
  await writeFile(join(out, `${name}.json`), payload);
  await writeFile(join(out, `${name}.sig.json`), JSON.stringify({ algorithm: "ed25519", keyId, payloadSha256: createHash("sha256").update(payload).digest("hex"), signature: sign(null, payload, signingKey).toString("base64url") }));
}
export function releaseNotes(manifest) {
  const app = manifest.app, rt = manifest.runtime;
  return `# ${app ? `OMP Studio ${app.version}` : `OMP Runtime ${rt.version}`}\n\n${app ? `## 安装\n\n[下载 Windows ${manifest.platform.slice(6)} 安装包](${app.file.url})\n\n首次安装或旧版迁移请使用此安装包。已迁移的用户在应用内等待下载完成后点击「重启更新」。\n\n` : "这是 Runtime 独立更新，不是桌面安装包。在 OMP Studio 中检查更新即可。\n\n"}## Runtime\n\n版本：${rt.version} · 通道：${rt.channel} · 最低桌面版本：${rt.minAppVersion}\n\n<details>\n<summary>自动更新附件说明（普通用户无需下载）</summary>\n\n- Runtime ZIP：签名运行时工件，供自动更新或离线导入。\n- blockmap：增量下载索引，不是可执行安装包。\n- updates-*.json：签名版本清单，供更新器使用。\n- update-index*.json：旧客户端迁移入口，请勿删除。\n\n</details>\n`;
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) buildUpdateAssetsV2().then(r => console.log(`Built signed update catalog: ${r.out}`)).catch(e => { console.error(e.message); process.exitCode = 1; });
