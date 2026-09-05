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

test("auditInstallerOutput fails when trusted-keys.json is missing", async () => {
  const { readFileSync } = await import("node:fs");
  const { SERIES_JSON_PATH, VENDOR_CODING_AGENT_PACKAGE_JSON, deriveRuntimeVersion } = await import("./runtime-artifact.mjs");
  const output = await mkdtemp(join(tmpdir(), "omp-audit-no-tk-"));
  const unpacked = join(output, "win-unpacked");
  await mkdir(join(unpacked, "resources", "renderer", "dist"), { recursive: true });
  await mkdir(join(unpacked, "resources", "app.asar.unpacked", "dist"), { recursive: true });
  await writeFile(join(unpacked, "OMP Studio.exe"), "fake-exe\n");
  await writeFile(join(output, "OMP-Studio-Setup-0.1.0-win-x64.exe"), "fake-setup\n");
  await writeFile(
    join(unpacked, "resources", "renderer", "dist", "index.html"),
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head></html>',
  );
  await writeFile(join(unpacked, "resources", "app.asar.unpacked", "dist", "preload.cjs"), "preload");
  await mkdir(join(unpacked, "resources", "app"), { recursive: true });
  await writeFile(join(unpacked, "resources", "app", "package.json"), JSON.stringify({ main: "./dist/src/main.js" }));

  const series = JSON.parse(readFileSync(SERIES_JSON_PATH, "utf8"));
  const vendorPkg = JSON.parse(readFileSync(VENDOR_CODING_AGENT_PACKAGE_JSON, "utf8"));
  const expectedVersion = deriveRuntimeVersion(vendorPkg.version, series);

  const versionDir = join(unpacked, "runtime", "versions", expectedVersion);
  await mkdir(versionDir, { recursive: true });
  await writeFile(join(versionDir, "omp.exe"), "omp");
  await writeFile(
    join(versionDir, "runtime-manifest.json"),
    JSON.stringify({ runtimeVersion: expectedVersion }),
  );

  const keysDir = join(unpacked, "runtime-keys");
  await mkdir(keysDir, { recursive: true });
  await writeFile(join(keysDir, "key-id.txt"), "test-key\n");
  await writeFile(join(keysDir, "trusted-public.pem"), "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n");

  assert.throws(
    () => auditInstallerOutput(output),
    /trusted-keys\.json missing/u,
  );
});

test("auditInstallerOutput fails when a trusted key contains a private key marker", async () => {
  const { readFileSync } = await import("node:fs");
  const { SERIES_JSON_PATH, VENDOR_CODING_AGENT_PACKAGE_JSON, deriveRuntimeVersion } = await import("./runtime-artifact.mjs");
  const output = await mkdtemp(join(tmpdir(), "omp-audit-priv-tk-"));
  const unpacked = join(output, "win-unpacked");
  await mkdir(join(unpacked, "resources", "renderer", "dist"), { recursive: true });
  await mkdir(join(unpacked, "resources", "app.asar.unpacked", "dist"), { recursive: true });
  await writeFile(join(unpacked, "OMP Studio.exe"), "fake-exe\n");
  await writeFile(join(output, "OMP-Studio-Setup-0.1.0-win-x64.exe"), "fake-setup\n");
  await writeFile(
    join(unpacked, "resources", "renderer", "dist", "index.html"),
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head></html>',
  );
  await writeFile(join(unpacked, "resources", "app.asar.unpacked", "dist", "preload.cjs"), "preload");
  await mkdir(join(unpacked, "resources", "app"), { recursive: true });
  await writeFile(join(unpacked, "resources", "app", "package.json"), JSON.stringify({ main: "./dist/src/main.js" }));

  const series = JSON.parse(readFileSync(SERIES_JSON_PATH, "utf8"));
  const vendorPkg = JSON.parse(readFileSync(VENDOR_CODING_AGENT_PACKAGE_JSON, "utf8"));
  const expectedVersion = deriveRuntimeVersion(vendorPkg.version, series);

  const versionDir = join(unpacked, "runtime", "versions", expectedVersion);
  await mkdir(versionDir, { recursive: true });
  await writeFile(join(versionDir, "omp.exe"), "omp");
  await writeFile(
    join(versionDir, "runtime-manifest.json"),
    JSON.stringify({ runtimeVersion: expectedVersion }),
  );

  const keysDir = join(unpacked, "runtime-keys");
  await mkdir(keysDir, { recursive: true });
  await writeFile(join(keysDir, "key-id.txt"), "test-key\n");
  await writeFile(join(keysDir, "trusted-public.pem"), "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n");
  await writeFile(
    join(keysDir, "trusted-keys.json"),
    JSON.stringify({
      schema: 1,
      activeKeyId: "test-key",
      keys: { "test-key": "bad-key.pem" },
    }),
  );
  await writeFile(
    join(keysDir, "bad-key.pem"),
    "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n",
  );

  assert.throws(
    () => auditInstallerOutput(output),
    /contains a private key marker/u,
  );
});

test("auditInstallerOutput fails when packaged package.json main entrypoint is invalid", async () => {
  const output = await mkdtemp(join(tmpdir(), "omp-audit-main-"));
  const unpacked = join(output, "win-unpacked");
  await mkdir(join(unpacked, "resources", "renderer", "dist"), { recursive: true });
  await mkdir(join(unpacked, "resources", "app.asar.unpacked", "dist"), { recursive: true });
  await mkdir(join(unpacked, "resources", "app"), { recursive: true });
  await writeFile(join(unpacked, "OMP Studio.exe"), "fake-exe\n");
  await writeFile(join(output, "OMP-Studio-Setup-0.1.0-win-x64.exe"), "fake-setup\n");
  await writeFile(
    join(unpacked, "resources", "renderer", "dist", "index.html"),
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head></html>',
  );
  await writeFile(join(unpacked, "resources", "app.asar.unpacked", "dist", "preload.cjs"), "preload");
  await writeFile(join(unpacked, "resources", "app", "package.json"), JSON.stringify({ main: "./invalid.js" }));

  assert.throws(
    () => auditInstallerOutput(output),
    /package\.json main entrypoint must be '\.\/dist\/src\/main\.js'/u,
  );
});

test("auditInstallerOutput rejects a malformed asar containing plausible entrypoint text", async () => {
  const output = await mkdtemp(join(tmpdir(), "omp-audit-corrupt-asar-"));
  const resources = join(output, "win-unpacked", "resources");
  await mkdir(join(resources, "renderer", "dist"), { recursive: true });
  await writeFile(join(output, "win-unpacked", "OMP Studio.exe"), "fake-exe");
  await writeFile(join(resources, "renderer", "dist", "index.html"), '<meta http-equiv="Content-Security-Policy" content="default-src self">');
  await writeFile(join(resources, "app.asar"), 'not an asar: preload.cjs {"main":"./dist/src/main.js"}');
  assert.throws(() => auditInstallerOutput(output));
});
