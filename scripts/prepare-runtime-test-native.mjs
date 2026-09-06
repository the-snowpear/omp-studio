// Use the native addon embedded in the verified release Runtime for source tests.
import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_ARTIFACT_LAYOUT, parseRuntimeInstallationManifest, verifySignedArtifact } from "@omp-studio/runtime-installer";
import { repositoryRoot, ompSourceDirectory } from "./omp-tooling.mjs";
import { assertPeArchitecture, resolveTargetArch } from "./windows-architecture.mjs";

const arch = resolveTargetArch();
const platform = `win32-${arch}`;
if (process.platform !== "win32" || process.arch !== arch) throw new Error("Runtime source tests require the matching native Windows architecture");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const pin = await readJson(join(repositoryRoot, "omp-patch", "upstream.json"));
const series = await readJson(join(repositoryRoot, "omp-patch", "patches", "series.json"));
const agent = await readJson(join(ompSourceDirectory, "packages", "coding-agent", "package.json"));
const natives = await readJson(join(ompSourceDirectory, "packages", "natives", "package.json"));
const version = `${agent.version}-${series.patchsetVersion}`;
const artifactRoot = join(repositoryRoot, "packages", "runtime-installer", "dist", "artifacts", platform);
let artifact = join(artifactRoot, version);
try { await access(join(artifact, "runtime-manifest.json")); } catch { artifact = artifactRoot; }
const keysRoot = join(repositoryRoot, "packaging", "keys");
const table = await readJson(join(keysRoot, "trusted-keys.json"));
const trustedKeys = {};
for (const [id, filename] of Object.entries(table.keys)) trustedKeys[id] = await readFile(join(keysRoot, filename));
const { manifest } = await verifySignedArtifact({
  directory: artifact, layout: RUNTIME_ARTIFACT_LAYOUT, parseManifest: parseRuntimeInstallationManifest,
  requireCovered: (value) => ["runtime-manifest.json", value.entrypoint], trustedKeys,
});
if (manifest.runtimeVersion !== version || manifest.platform !== platform || manifest.upstreamCommit !== pin.commit) {
  throw new Error("Test Runtime does not match the pinned source and target architecture");
}
const temp = await mkdtemp(join(tmpdir(), "omp-native-from-release-"));
try {
  // The compiled loader extracts into XDG_DATA_HOME only when omp/ exists.
  await mkdir(join(temp, "omp"));
  execFileSync(join(artifact, manifest.entrypoint), ["--smoke-test"], {
    env: { ...process.env, XDG_DATA_HOME: temp }, windowsHide: true, timeout: 120_000, stdio: "pipe",
  });
  const extracted = join(temp, "omp", "natives", natives.version);
  const files = (await readdir(extracted)).filter((name) => /^pi_natives\.win32-(?:x64|arm64)(?:-(?:modern|baseline))?\.node$/.test(name));
  if (files.length === 0) throw new Error("Verified Runtime did not extract its native test dependency");
  const destination = join(ompSourceDirectory, "packages", "natives", "native");
  for (const filename of files) {
    const source = join(extracted, filename);
    assertPeArchitecture(source, arch);
    await copyFile(source, join(destination, filename));
  }
  console.log(`Prepared ${files.length} native test addon(s) from verified Runtime ${version}`);
} finally { await rm(temp, { recursive: true, force: true }); }
