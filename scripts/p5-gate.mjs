/**
 * P5 release gate. This is intentionally a verifier, not a packager:
 * signing keys stay outside the repository and missing production inputs fail
 * closed. It scans candidate
 * outputs for private material, and writes a platform-neutral readiness report.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { containsPrivateMaterial } from "./p5-secret-scan.mjs";
import { MAC_TARGET_PLATFORM, releaseOutputDirectory, releaseTargetsDarwin } from "./release-assets.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const reportPath = process.env.OMP_P5_REPORT ?? join(root, "outputs", "p5-readiness.json");

async function walk(directory, output = []) {
  if (!existsSync(directory)) return output;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else output.push(path);
  }
  return output;
}

// Source tests run once in check + omp:test:metadata before packaging.
const checks = [];

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
const darwin = releaseTargetsDarwin();
const releasePlatform = darwin ? MAC_TARGET_PLATFORM : `win32-${process.env.OMP_TARGET_ARCH ?? "x64"}`;
const v2Directory = releaseOutputDirectory(root, releasePlatform);
if (existsSync(join(v2Directory, `updates-${releasePlatform}.json`))) {
  try {
    const { verifyUpdateAssets } = await import("./verify-update-assets-v2.mjs");
    const { releaseKeys } = await import("./build-update-assets-v2.mjs");
    await verifyUpdateAssets(v2Directory, await releaseKeys(root), process.env.GITHUB_REPOSITORY ?? "the-snowpear/omp-studio", releasePlatform);
    updateIndexSigned = true;
    checks.push({ name: "update-v2-signature-and-assets", status: "passed" });
  } catch (error) { checks.push({ name: "update-v2-signature-and-assets", status: "failed", message: String(error) }); }
} else if (!darwin && existsSync(updateIndexPath)) {
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

// On a Mac release runner the packed bundle is audited for real; a Runtime-only release packs none.
let macBundleAudit = "not-applicable";
if (darwin) {
  const { auditMacOutput, defaultMacOutputDirectory } = await import("./audit-mac.mjs");
  if (existsSync(join(defaultMacOutputDirectory(), "mac-arm64"))) {
    try {
      await auditMacOutput();
      macBundleAudit = "passed";
      checks.push({ name: "macos-bundle-audit", status: "passed" });
    } catch (error) {
      macBundleAudit = "failed";
      checks.push({ name: "macos-bundle-audit", status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  } else macBundleAudit = "not-packed";
}

const readiness = {
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  checks,
  gates: {
    noPrivateMaterialInScannedOutputs: leaks.length === 0,
    updateIndexSigned,
    productionWindowsCleanRun: "manual-required",
    ...(darwin ? { productionMacCleanRun: "manual-required" } : {}),
  },
  sourceTests: "Run check and omp:test:metadata separately; this report only verifies artifacts",
  macosReadiness: darwin
    ? {
        status: macBundleAudit === "passed" ? "manual-verification-required" : macBundleAudit === "not-packed" ? "runtime-only" : "failed",
        bundleAudit: macBundleAudit,
        note: "Ad hoc signed and not notarized: first launch through Gatekeeper, TCC prompts and the in-app update swap still need a clean-machine run.",
      }
    : {
        status: "review-required",
        note: "Renderer and contract are platform-neutral; notarization and darwin artifact E2E remain release-pipeline work.",
      },
};
await writeFile(reportPath, `${JSON.stringify(readiness, null, 2)}\n`, "utf8");
console.log(`P5 readiness report: ${reportPath}`);
if (checks.some((check) => check.status === "failed")) process.exitCode = 1;
