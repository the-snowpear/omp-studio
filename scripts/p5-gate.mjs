/**
 * P5 release gate. This is intentionally a verifier, not a packager:
 * signing keys stay outside the repository and missing production inputs fail
 * closed. It runs the existing security/installer tests, scans candidate
 * outputs for private material, and writes a platform-neutral readiness report.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { containsPrivateMaterial } from "./p5-secret-scan.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const reportPath = process.env.OMP_P5_REPORT ?? join(root, "outputs", "p5-readiness.json");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false, windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function walk(directory, output = []) {
  if (!existsSync(directory)) return output;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else output.push(path);
  }
  return output;
}

const npmCli = join(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js");

const checks = [];
try {
  await run(process.execPath, ["--version"]);
  const npm = process.platform === "win32" ? process.execPath : "npm";
  const npmArgs = (args) => process.platform === "win32" ? [npmCli, ...args] : args;
  await run(npm, npmArgs(["run", "test", "-w", "@omp-studio/runtime-installer"]));
  await run(npm, npmArgs(["run", "omp:test:metadata"]));
  await run(npm, npmArgs(["run", "test", "-w", "@omp-studio/studio-host"]));
  checks.push({ name: "pty-and-runtime-security-tests", status: "passed" });
} catch (error) {
  checks.push({ name: "pty-and-runtime-security-tests", status: "failed", message: error instanceof Error ? error.message : String(error) });
}

const scanRoots = [join(root, "apps", "desktop", "dist"), join(root, "apps", "renderer", "dist"), join(root, "packages", "runtime-installer", "dist", "artifacts"), join(root, "outputs")];
const leaks = [];
for (const directory of scanRoots) {
  for (const path of await walk(directory)) {
    if (!/\.(?:js|mjs|ts|json|pem|key|log)$/u.test(path)) continue;
    let content;
    try { content = await readFile(path, "utf8"); } catch { continue; }
    if (containsPrivateMaterial(content)) leaks.push(relative(root, path));
  }
}
checks.push({ name: "repository-secret-scan", status: leaks.length === 0 ? "passed" : "failed", ...(leaks.length ? { files: leaks } : {}) });

let updateIndexSigned = false;
const updateIndexPath = join(root, "outputs", "release", "update-index.json");
const updateIndexSigPath = join(root, "outputs", "release", "update-index.sig.json");
if (existsSync(updateIndexPath)) {
  try {
    const { createTrustedKeyVerifier, parseRuntimeSignatureManifest } = await import("@omp-studio/runtime-installer");
    const { createHash } = await import("node:crypto");
    const payloadBytes = await readFile(updateIndexPath);
    const sigText = await readFile(updateIndexSigPath, "utf8");
    const signature = parseRuntimeSignatureManifest(JSON.parse(sigText));
    const trustedKeysPath = join(root, "packaging", "keys", "trusted-keys.json");
    const trustedData = JSON.parse(await readFile(trustedKeysPath, "utf8"));
    const keys = {};
    for (const [k, relPath] of Object.entries(trustedData.keys)) {
      keys[k] = await readFile(join(root, "packaging", "keys", relPath));
    }
    if (signature.payloadSha256 !== createHash("sha256").update(payloadBytes).digest("hex")) {
      throw new Error("update-index.sig.json sha256 mismatch");
    }
    const verifier = createTrustedKeyVerifier(keys);
    if (!verifier.verify(signature, payloadBytes)) {
      throw new Error("update-index signature verification failed");
    }
    updateIndexSigned = true;
    checks.push({ name: "update-index-signature", status: "passed" });
  } catch (error) {
    updateIndexSigned = false;
    checks.push({ name: "update-index-signature", status: "failed", message: error instanceof Error ? error.message : String(error) });
  }
} else {
  checks.push({ name: "update-index-signature", status: "failed", message: "Build update assets before running the release gate" });
}

const readiness = {
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  checks,
  gates: {
    ptyTickets: checks[0]?.status === "passed",
    signedRuntimeArtifact: checks[0]?.status === "passed",
    installUpgradeRollbackProtection: checks[0]?.status === "passed",
    noPrivateMaterialInScannedOutputs: leaks.length === 0,
    updateIndexSigned,
    productionWindowsCleanRun: "manual-required",
  },
  macosReadiness: {
    status: "review-required",
    note: "Renderer and contract are platform-neutral; notarization and darwin artifact E2E remain release-pipeline work.",
  },
};
await writeFile(reportPath, `${JSON.stringify(readiness, null, 2)}\n`, "utf8");
console.log(`P5 readiness report: ${reportPath}`);
if (checks.some((check) => check.status === "failed")) process.exitCode = 1;
