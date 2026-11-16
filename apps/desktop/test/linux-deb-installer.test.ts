import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ComponentRelease, SignedUpdateManifest } from "@omp-studio/runtime-installer";
import { LinuxDebInstaller } from "../src/linux-deb-installer.js";
import { macSwapMarkers } from "../src/mac-app-swap.js";

function envelope(version: string, bytes: Buffer): SignedUpdateManifest {
  const asset = `OMP-Studio-${version}-linux-x64.deb`;
  const file = { asset, url: `https://github.com/owner/repo/releases/download/v${version}/${asset}`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("base64") };
  const app: ComponentRelease = { version, sequence: 1, channel: "stable", file, blockmap: { ...file, asset: `${asset}.blockmap` }, minAppVersion: "0.0.0", studioProtocol: { min: 1, max: 1 } };
  return { manifest: { schema: 2, repo: "owner/repo", platform: "linux-x64", generatedAt: "2026-11-17T00:00:00Z", releaseNotesUrl: "https://github.com/owner/repo/releases/tag/v1", app }, signature: { algorithm: "ed25519", keyId: "test", value: "fixture" } };
}

test("deb installer prepares signed catalogs and preserves restart arguments before authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-deb-staging-"));
  const target = join(root, "app"), nextPath = join(root, "next.deb"), previousPath = join(root, "old.deb"), swapDirectory = join(root, "swap");
  const next = Buffer.from("next"), old = Buffer.from("old"), nextEnvelope = envelope("2.0.0", next), oldEnvelope = envelope("1.0.0", old);
  await writeFile(nextPath, next); await writeFile(previousPath, old);
  let plan: Record<string, unknown> = {};
  const installer = new LinuxDebInstaller({ target, resourcesPath: root, swapDirectory, pid: 123, launchArguments: ["--user-data-dir=a b", "--omp-restarted"],
    spawnHelper: async (_script, planPath) => { plan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>; },
    waitForReady: async () => ({ status: "ready" }) });
  installer.preflight = async () => undefined;
  await installer.install(nextPath, nextEnvelope.manifest.app!, false, nextEnvelope, { path: previousPath, envelope: oldEnvelope });
  assert.deepEqual(plan.launchArguments, ["--user-data-dir=a b", "--omp-restarted"]);
  assert.deepEqual(JSON.parse(await readFile(String(plan.catalogPath), "utf8")), nextEnvelope);
  assert.deepEqual(JSON.parse(await readFile(String(plan.previousCatalogPath), "utf8")), oldEnvelope);
  assert.equal(macSwapMarkers(swapDirectory, { version: "2.0.0", bundlePath: target }).healthy(), true);
});

test("deb installer refuses altered packages and cancels the supervisor when authorization fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-deb-denied-"));
  const nextPath = join(root, "next.deb"), oldPath = join(root, "old.deb"), swapDirectory = join(root, "swap");
  const next = envelope("2.0.0", Buffer.from("next")), old = envelope("1.0.0", Buffer.from("old"));
  await writeFile(nextPath, "altered"); await writeFile(oldPath, "old");
  let plan: Record<string, unknown> | undefined;
  const installer = new LinuxDebInstaller({ target: join(root, "app"), resourcesPath: root, swapDirectory, pid: 123,
    spawnHelper: async (_script, planPath) => { plan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>; },
    waitForReady: async () => ({ status: "failed", message: "cancelled" }) });
  installer.preflight = async () => undefined;
  await assert.rejects(installer.install(nextPath, next.manifest.app!, false, next, { path: oldPath, envelope: old }), /verification/u);
  assert.equal(plan, undefined);
  await writeFile(nextPath, "next");
  await assert.rejects(installer.install(nextPath, next.manifest.app!, false, next, { path: oldPath, envelope: old }), /authorization.*cancelled/iu);
  const captured = plan as Record<string, unknown> | undefined;
  assert.ok(captured);
  await assert.rejects(readFile(String(captured.control)), { code: "ENOENT" });
  await assert.rejects(readFile(join(swapDirectory, "plan.json")), { code: "ENOENT" });
});
