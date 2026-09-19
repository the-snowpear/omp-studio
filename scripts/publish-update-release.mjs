// Publication is invoked only by the release workflow, after all architecture gates.
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const repo = process.env.GITHUB_REPOSITORY;
if (!repo) throw new Error("GITHUB_REPOSITORY is required");
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}` : JSON.stringify(v);
const table = JSON.parse(await readFile("packaging/keys/trusted-keys.json", "utf8"));
const artifacts = [], notes = [], identities = [];
for (const dir of await readdir("outputs/publish")) {
  if (!/^release-candidate-(x64|arm64)$/.test(dir)) throw new Error("Unexpected release candidate");
  const root = join("outputs/publish", dir), arch = dir.replace("release-candidate-", "");
  const name = `updates-win32-${arch}.json`;
  const envelope = JSON.parse(await readFile(join(root, name), "utf8"));
  const { manifest: m, signature: s } = envelope;
  const keyName = table.keys[s.keyId];
  if (!keyName || s.algorithm !== "ed25519" || !verify(null, Buffer.from(`omp-studio-update-v2\n${canonical(m)}`), createPublicKey(await readFile(join("packaging/keys", keyName))), Buffer.from(s.value, "base64url"))) throw new Error("Invalid candidate signature");
  if (m.repo !== repo || m.platform !== `win32-${arch}` || m.schema !== 2) throw new Error("Candidate identity mismatch");
  const runtimeOnly = process.env.OMP_RELEASE_KIND === "runtime";
  if (runtimeOnly === Boolean(m.app)) throw new Error("Release kind mismatch");
  const tag = runtimeOnly ? `runtime-v${m.runtime.version}` : `v${m.app.version}`;
  identities.push({ tag, title: runtimeOnly ? `OMP Runtime ${m.runtime.version}` : `OMP Studio ${m.app.version}`, prerelease: m.runtime.channel === "canary", latest: !runtimeOnly });
  const allowed = new Set([name, "release-notes.md"]);
  for (const component of [m.app, m.runtime].filter(Boolean)) for (const file of [component.file, component.blockmap]) {
    const path = join(root, file.asset), bytes = await readFile(path);
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256 || file.url !== `https://github.com/${repo}/releases/download/${tag}/${file.asset}`) throw new Error("Candidate asset verification failed");
    allowed.add(file.asset);
  }
  const legacy = arch === "x64" ? "update-index" : `update-index-win32-${arch}`;
  allowed.add(`${legacy}.json`); allowed.add(`${legacy}.sig.json`);
  for (const file of await readdir(root)) {
    if (!allowed.has(file)) throw new Error(`Unexpected publish file: ${file}`);
    if (file !== "release-notes.md") artifacts.push(join(root, file));
  }
  notes.push(await readFile(join(root, "release-notes.md"), "utf8"));
}
const identity = identities[0];
if (!identity || identities.some(i => JSON.stringify(i) !== JSON.stringify(identity))) throw new Error("Architecture releases disagree");
const releases = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`)).flat();
if (releases.some(r => r.tag_name === identity.tag && !r.draft)) throw new Error("Refusing to overwrite a published release");
// Latest is a desktop release. A one-architecture release must keep the other
// architecture's old-client migration link without presenting an old v2 build
// as a new artifact. These signed feeds refer to their original release URLs.
if (identity.latest) for (const legacyName of ["update-index", "update-index-win32-arm64"]) {
  if (artifacts.some(path => path.endsWith(`/${legacyName}.json`))) continue;
  const previous = releases.filter(r => !r.draft && !r.prerelease && !r.tag_name.startsWith("runtime-v")).sort((a, b) => b.id - a.id).find(r => r.assets.some(a => a.name === `${legacyName}.json`) && r.assets.some(a => a.name === `${legacyName}.sig.json`));
  if (!previous) continue;
  const asset = previous.assets.find(a => a.name === `${legacyName}.json`), signatureAsset = previous.assets.find(a => a.name === `${legacyName}.sig.json`);
  const bytes = Buffer.from(gh("api", "-H", "Accept: application/octet-stream", `repos/${repo}/releases/assets/${asset.id}`));
  const sigText = gh("api", "-H", "Accept: application/octet-stream", `repos/${repo}/releases/assets/${signatureAsset.id}`);
  const sig = JSON.parse(sigText), keyName = table.keys[sig.keyId];
  if (!keyName || sig.algorithm !== "ed25519" || sig.payloadSha256 !== createHash("sha256").update(bytes).digest("hex") || !verify(null, bytes, createPublicKey(await readFile(join("packaging/keys", keyName))), Buffer.from(sig.signature, "base64url"))) throw new Error("Invalid retained migration signature");
  for (const [name, content] of [[`${legacyName}.json`, bytes], [`${legacyName}.sig.json`, sigText]]) {
    const path = join("outputs/publish", name); await writeFile(path, content); artifacts.push(path);
  }
}
const notesPath = "outputs/publish/release-notes.md";
await writeFile(notesPath, notes.join("\n\n---\n\n"));
if (!releases.some(r => r.tag_name === identity.tag)) gh("release", "create", identity.tag, "--draft", "--target", process.env.GITHUB_SHA, "--title", identity.title, "--notes-file", notesPath);
else gh("release", "edit", identity.tag, "--title", identity.title, "--notes-file", notesPath);
const existingAssets = JSON.parse(gh("release", "view", identity.tag, "--json", "assets")).assets;
const expected = new Set(artifacts.map(p => p.split(/[\\/]/).at(-1)));
if (existingAssets.some(a => !expected.has(a.name))) throw new Error("Draft contains unexpected assets; review before retrying");
gh("release", "upload", identity.tag, ...artifacts, "--clobber");
const uploaded = JSON.parse(gh("release", "view", identity.tag, "--json", "assets")).assets;
if (uploaded.length !== artifacts.length) throw new Error("Incomplete release upload");
for (const path of artifacts) {
  const name = path.split(/[\\/]/).at(-1), bytes = await readFile(path), asset = uploaded.find(a => a.name === name);
  if (!asset || asset.size !== bytes.length || asset.digest !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`) throw new Error(`Uploaded digest mismatch: ${name}`);
}
gh("release", "edit", identity.tag, "--draft=false", `--prerelease=${identity.prerelease}`, `--latest=${identity.latest}`);
