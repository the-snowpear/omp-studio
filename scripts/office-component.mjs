/** Build a separately downloadable Office engine from an official LibreOffice distribution. */
import { execFile } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const argument = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
export const OFFICE_PLATFORMS = {
  "win32-x64": { directory: "win/x86_64", filename: version => `LibreOffice_${version}_Win_x86-64.msi`, folder: "LibreOffice", entrypoint: "LibreOffice/program/soffice.com" },
  "win32-arm64": { directory: "win/aarch64", filename: version => `LibreOffice_${version}_Win_aarch64.msi`, folder: "LibreOffice", entrypoint: "LibreOffice/program/soffice.com" },
  "darwin-arm64": { directory: "mac/aarch64", filename: version => `LibreOffice_${version}_MacOS_aarch64.dmg`, folder: "LibreOffice.app", entrypoint: "LibreOffice.app/Contents/MacOS/soffice" },
};
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
export function signOfficeManifest(manifest, key, keyId) {
  const payload = Buffer.from(`omp-studio-office-preview-v1\n${canonical(manifest)}`);
  return { manifest, signature: { algorithm: "ed25519", keyId, payloadSha256: createHash("sha256").update(payload).digest("hex"), signature: sign(null, payload, key).toString("base64url") } };
}
async function digest(path) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function findEngine(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const found = await findEngine(path); if (found) return found; }
    else if (entry.name === "soffice.com") return dirname(dirname(path));
  }
}
async function prepareSource(platform, version, directory) {
  const definition = OFFICE_PLATFORMS[platform], filename = definition.filename(version);
  const url = `https://download.documentfoundation.org/libreoffice/stable/${version}/${definition.directory}/${filename}`;
  console.log(`Preparing official LibreOffice ${version} for ${platform}`);
  const metadata = await fetch(`${url}.sha256`, { signal: AbortSignal.timeout(30_000) });
  if (!metadata.ok) throw new Error(`Cannot retrieve upstream checksum (${metadata.status})`);
  const text = await metadata.text();
  const checksum = /([a-f0-9]{64})/i.exec(text)?.[1];
  if (!checksum) throw new Error("Official mirror listing has no SHA-256 checksum");
  const installer = join(directory, filename), response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Official download failed (${response.status})`);
  const hash = createHash("sha256");
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } }), createWriteStream(installer));
  if (hash.digest("hex") !== checksum.toLowerCase()) throw new Error("Official LibreOffice checksum mismatch");
  if (platform.startsWith("win32-")) {
    const extracted = join(directory, "msi"); await mkdir(extracted);
    await execute(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "msiexec.exe"), ["/a", installer, "/qn", `TARGETDIR=${extracted}`], { windowsHide: true, timeout: 240_000 });
    const source = await findEngine(extracted); if (!source) throw new Error("Administrative MSI extraction did not contain LibreOffice");
    return { source, url };
  }
  const mount = join(directory, "mount"), source = join(directory, "LibreOffice.app"); await mkdir(mount);
  await execute("/usr/bin/hdiutil", ["attach", installer, "-nobrowse", "-readonly", "-mountpoint", mount]);
  try { await cp(join(mount, "LibreOffice.app"), source, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true }); }
  finally { await execute("/usr/bin/hdiutil", ["detach", mount]); }
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", source]);
  return { source, url };
}
export async function buildOfficeComponent(options) {
  const { platform, version, engineVersion, output, key, keyId } = options;
  if (!key || !keyId) throw new Error("Provide a release signing key and trusted key id before building the component");
  const definition = OFFICE_PLATFORMS[platform];
  if (!definition || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version) || !/^[\d.]+$/.test(engineVersion)) throw new Error("Specify a supported platform and safe component / engine versions");
  if (platform !== `${process.platform}-${process.arch}`) throw new Error("Build on the matching native architecture so the engine can be smoke tested");
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, ".office-build-"));
  try {
    const prepared = options.source ? { source: resolve(options.source), url: options.sourceUrl ?? "https://www.libreoffice.org/download/download-libreoffice/" } : await prepareSource(platform, engineVersion, temporary);
    const stage = join(temporary, "payload"); await mkdir(stage);
    await cp(prepared.source, join(stage, definition.folder), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    const engine = join(stage, definition.entrypoint); await access(engine);
    const versionResult = await execute(engine, ["--version"], { windowsHide: true, timeout: 30_000 });
    if (!versionResult.stdout.includes("LibreOffice")) throw new Error("Unexpected Office engine identity");
    const file = `office-preview-${platform}-${version}.zip`, archive = join(output, file);
    if (platform.startsWith("win32-")) await execute(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-cf", archive, "-C", stage, definition.folder], { windowsHide: true, timeout: 300_000 });
    else await execute("/usr/bin/ditto", ["-c", "-k", "--keepParent", join(stage, definition.folder), archive], { timeout: 300_000 });
    const manifest = { schema: 1, component: "office-preview", version, engineVersion, platform, entrypoint: definition.entrypoint, archive: { url: `https://github.com/the-snowpear/omp-studio/releases/download/office-preview/${file}`, sha256: await digest(archive), bytes: (await stat(archive)).size }, sourceUrl: prepared.url, license: "MPL-2.0 and bundled third-party licenses; license files are retained in the unmodified distribution" };
    await writeFile(join(output, `office-preview-${platform}.json`), JSON.stringify(signOfficeManifest(manifest, key, keyId), null, 2) + "\n");
    console.log(`Built ${file} (${Math.round(manifest.archive.bytes / 1024 / 1024)} MiB)`);
    return manifest;
  } finally {
    const rel = relative(resolve(output), resolve(temporary));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe build cleanup directory");
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keyPath = argument("key-file") ?? process.env.OMP_RUNTIME_SIGNING_KEY;
  const keyId = argument("key-id") ?? process.env.OMP_RUNTIME_SIGNING_KEY_ID;
  if (!keyPath || !keyId) throw new Error("Provide the release signing key file and trusted key id");
  await buildOfficeComponent({ platform: argument("platform") ?? `${process.platform}-${process.arch}`, version: argument("version") ?? "26.8.2", engineVersion: argument("engine-version") ?? "26.8.2", output: resolve(argument("output") ?? "outputs/office-component"), source: argument("source"), sourceUrl: argument("source-url"), key: await readFile(keyPath), keyId });
}
