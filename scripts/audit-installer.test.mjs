import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { auditInstallerOutput, findPrivateKeyFiles } from "./audit-installer.mjs";

test("findPrivateKeyFiles reports a PEM private key and ignores a public key", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-audit-keys-"));
  await mkdir(join(root, "runtime-keys"), { recursive: true });
  await writeFile(join(root, "runtime-keys", "trusted-public.pem"), "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n");
  await writeFile(join(root, "runtime-keys", "signing-private.pem"), "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n");
  const hits = findPrivateKeyFiles(root).map((path) => path.replaceAll("\\", "/"));
  assert.ok(hits.some((path) => path.endsWith("signing-private.pem")));
  assert.equal(
    hits.some((path) => path.endsWith("trusted-public.pem")),
    false,
  );
});

test("auditInstallerOutput fails closed when the renderer extraResources tree is missing", async () => {
  const output = await mkdtemp(join(tmpdir(), "omp-audit-out-"));
  await mkdir(join(output, "win-unpacked"), { recursive: true });
  await writeFile(join(output, "win-unpacked", "OMP Studio.exe"), "fake-exe\n");
  await writeFile(join(output, "OMP-Studio-Setup-0.1.0-win-x64.exe"), "fake-setup\n");
  await assert.throws(
    () => auditInstallerOutput(output),
    /Renderer extraResources missing/u,
  );
});
