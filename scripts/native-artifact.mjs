// Cache the patched Rust addon independently of the TypeScript Runtime bundle.
// The upstream Bazel targets own toolchains, ISA variants and release codegen.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBun, ompSourceDirectory, repositoryRoot, run, toolingEnvironment } from "./omp-tooling.mjs";

const targets = {
  "win32-x64": ["win32-x64-baseline"],
  "win32-arm64": ["win32-arm64"],
  "linux-x64": ["linux-x64-baseline", "linux-x64-modern"],
  "linux-arm64": ["linux-arm64"],
  "darwin-x64": ["darwin-x64-baseline"],
  "darwin-arm64": ["darwin-arm64"],
};
const nativeInputs = [
  "crates", "bazel", ".cargo", "Cargo.toml", "Cargo.lock", "BUILD.bazel",
  "MODULE.bazel", "MODULE.bazel.lock", ".bazelrc", ".bazelignore", ".bazelversion",
  "rust-toolchain.toml", "rustfmt.toml", "scripts/bazel-natives.ts",
  "scripts/host-detect.ts", "scripts/stamp-native-version.ts",
  "packages/natives/native/version-sentinel.js",
];

export function nativeTargets(platform) {
  if (!targets[platform]) throw new Error(`Unsupported native artifact platform: ${platform}`);
  return targets[platform];
}

// Hash the applied tree, including new seam files, rather than the entire OMP
// commit or patch containers. A TS-only edit must not invalidate Rust output.
// git hash-object applies the checkout's clean filters, including CRLF -> LF.
export function nativeSourceFingerprint(source = ompSourceDirectory) {
  const git = (args, input) => execFileSync("git", args, {
    cwd: source, input, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  const files = [...new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...nativeInputs])
    .split("\0").filter(Boolean))].sort();
  const present = files.filter(file => existsSync(join(source, file)));
  const blobs = present.length ? git(["hash-object", "--stdin-paths"], present.map(file => JSON.stringify(file)).join("\n") + "\n").trim().split("\n") : [];
  return createHash("sha256").update(JSON.stringify({ files, blobs: present.map((file, index) => [file, blobs[index]]) })).digest("hex");
}

export function nativeArtifactKey(platform, source = ompSourceDirectory) {
  nativeTargets(platform);
  const policy = createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url), "utf8").replaceAll("\r\n", "\n"))
    .update(readFileSync(join(repositoryRoot, ".github/actions/setup-native-build/action.yml"), "utf8").replaceAll("\r\n", "\n"))
    .digest("hex").slice(0, 16);
  return `studio-native-v1-${platform}-${policy}-${nativeSourceFingerprint(source)}`;
}

export function buildNativeArtifact(platform, directory) {
  // Capture inputs before Bazel updates derived lockfile metadata or outputs.
  const key = nativeArtifactKey(platform);
  const env = process.env;
  // One addon per invocation bounds peak linker memory; Bazel shares actions
  // between the baseline/modern pair on the persistent server.
  for (const target of nativeTargets(platform)) {
    run("bazelisk", [...(env.OMP_BAZEL_RC ? [`--bazelrc=${env.OMP_BAZEL_RC}`] : []), "build", `//:natives-${target}`], { cwd: ompSourceDirectory, env });
    const folder = `natives-${target}`;
    const file = `pi_natives.${target}.node`;
    mkdirSync(join(directory, folder), { recursive: true });
    const output = join(directory, folder, file);
    // Bazel outputs are read-only; the artifact staging copy must be writable
    // for a repeated build (including a staging directory on a Windows mount).
    if (existsSync(output)) chmodSync(output, 0o644);
    copyFileSync(join(ompSourceDirectory, "bazel-bin", folder, file), output);
    chmodSync(output, 0o644);
  }
  writeFileSync(join(directory, "native-artifact.json"), JSON.stringify({ key, platform }) + "\n");
}

export function installNativeArtifact(platform, directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "native-artifact.json"), "utf8"));
  if (manifest.platform !== platform || manifest.key !== nativeArtifactKey(platform)) {
    throw new Error("Native artifact does not match this platform and patched Rust source tree");
  }
  run(findBun(), ["scripts/bazel-natives.ts", ...nativeTargets(platform), "--source", resolve(directory), "--dest", "packages/natives/native"], {
    cwd: ompSourceDirectory, env: toolingEnvironment(),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [mode, platform, directory] = process.argv.slice(2);
  if (mode === "key") {
    const key = nativeArtifactKey(platform);
    console.log(key);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
  } else if (mode === "build") buildNativeArtifact(platform, resolve(directory));
  else throw new Error("Usage: node scripts/native-artifact.mjs key <platform> | build <platform> <directory>");
}
