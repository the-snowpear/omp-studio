#!/usr/bin/env node
/**
 * Post-packaging update asset builder.
 *
 * Runs AFTER pack:win to build:
 * 1. App payload tar.gz (renderer + preload)
 * 2. update-index.json
 * 3. update-index.sig.json
 *
 * Outputs to outputs/release/
 */

import { execFileSync } from "node:child_process";
import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";
import { STUDIO_PROTOCOL_VERSION } from "@omp-studio/studio-protocol";
import { createHash, sign } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  canonicalJson,
  REPOSITORY_ROOT,
} from "./runtime-artifact.mjs";
import {
  readRuntimeSigningKeys,
} from "./runtime-signing-keys.mjs";
import { PRIVATE_KEY_MARKERS } from "./audit-installer.mjs";

export function buildTarHeader(opts) {
  const header = Buffer.alloc(512);
  const { name, size, typeflag = "0", mtime = 0 } = opts;
  const mode = typeflag === "5" ? "0000755\0" : "0000644\0";
  Buffer.from(name, "utf8").copy(header, 0, 0, 100);
  Buffer.from(mode, "ascii").copy(header, 100);
  Buffer.from("0000000\0", "ascii").copy(header, 108);
  Buffer.from("0000000\0", "ascii").copy(header, 116);
  Buffer.from(size.toString(8).padStart(11, "0") + " ", "ascii").copy(header, 124);
  Buffer.from(mtime.toString(8).padStart(11, "0") + " ", "ascii").copy(header, 136);
  header.fill(32, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
  return header;
}

export function createDeterministicTarGz(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const blocks = [];
  for (const entry of sorted) {
    const rawContent = entry.content ?? "";
    const contentBuf = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent, "utf8");
    const nameBuf = Buffer.from(entry.name, "utf8");
    if (nameBuf.length > 100) {
      const longLinkHeader = buildTarHeader({
        name: "././@LongLink",
        size: nameBuf.length + 1,
        typeflag: "L",
        mtime: 0,
      });
      blocks.push(longLinkHeader);
      const longLinkPayload = Buffer.concat([nameBuf, Buffer.from("\0")]);
      blocks.push(longLinkPayload);
      const pad = (512 - (longLinkPayload.length % 512)) % 512;
      if (pad > 0) blocks.push(Buffer.alloc(pad));
    }
    const header = buildTarHeader({
      name: nameBuf.subarray(0, 100).toString("utf8"),
      size: contentBuf.length,
      typeflag: entry.typeflag ?? (entry.name.endsWith("/") ? "5" : "0"),
      mtime: 0,
    });
    blocks.push(header);
    if (contentBuf.length > 0) {
      blocks.push(contentBuf);
      const padLen = (512 - (contentBuf.length % 512)) % 512;
      if (padLen > 0) blocks.push(Buffer.alloc(padLen));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { mtime: 0 });
}

export function resolveAppAbi(opts = {}, unpackedDir, probe = execFileSync) {
  const supplied = [opts.electron, opts.modules, opts.nodePty];
  if (supplied.every((value) => typeof value === "string" && value.trim().length > 0)) return { ...opts };
  if (supplied.some((value) => value !== undefined)) throw new Error("All three ABI values must be provided together");
  // Node running this script has a different modules ABI from packaged Electron.
  const output = probe(join(unpackedDir, "OMP Studio.exe"), ["--omp-print-abi"], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  const abi = JSON.parse(output.trim());
  for (const key of ["electron", "modules", "nodePty"]) {
    if (typeof abi[key] !== "string" || !abi[key].trim()) throw new Error(`Packaged ABI probe is missing ${key}`);
  }
  return { electron: abi.electron, modules: abi.modules, nodePty: abi.nodePty };
}

export async function buildUpdateAssets(options = {}) {
  const rootDir = options.rootDir ?? REPOSITORY_ROOT;
  const unpackedDir = options.unpackedDir ?? join(rootDir, "outputs", "installer", "win-unpacked");
  const rendererDir = options.rendererDir ?? join(unpackedDir, "resources", "renderer", "dist");
  const preloadPath = options.preloadPath ?? join(rootDir, "apps", "desktop", "dist", "preload.cjs");
  const outDir = options.outDir ?? join(rootDir, "outputs", "release");
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? "the-snowpear/omp-studio";
  const appVersion =
    options.appVersion ??
    JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).version;
  const abi = resolveAppAbi(options.abi, unpackedDir);
  const platform = options.platform ?? "win32-x64";

  await mkdir(outDir, { recursive: true });

  let signingKey = options.signingKey;
  let keyId = options.keyId;

  if (!signingKey) {
    const envKeyPath = process.env.OMP_RUNTIME_SIGNING_KEY;
    const envKeyId = process.env.OMP_RUNTIME_SIGNING_KEY_ID;
    if (envKeyPath && envKeyId) {
      signingKey = await readFile(resolve(envKeyPath));
      keyId = envKeyId;
    } else {
      try {
        const local = await readRuntimeSigningKeys();
        signingKey = local.privateKey;
        keyId = local.keyId;
      } catch (err) {
        if (options.requireSigning !== false) {
          throw new Error("No signing key available for update assets: " + String(err));
        }
      }
    }
  }

  // 1. Validate Renderer
  const indexPath = join(rendererDir, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`Renderer index.html is missing at ${indexPath}`);
  }
  const indexHtml = await readFile(indexPath, "utf8");
  if (!indexHtml.includes("Content-Security-Policy")) {
    throw new Error("Renderer index.html has no Content-Security-Policy meta tag.");
  }

  if (!existsSync(preloadPath)) {
    throw new Error(`Sandboxed preload is missing at ${preloadPath}`);
  }
  const preloadContent = await readFile(preloadPath);

  // 2. Scan renderer files
  const rendererFiles = [];
  const walkDir = async (dir, prefix = "") => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walkDir(full, rel);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".node")) {
          throw new Error(`App payload must not contain native modules: ${rel}`);
        }
        if (entry.name.endsWith(".map")) {
          throw new Error(`App payload must not contain source maps: ${rel}`);
        }
        if (entry.name === "signing-private.pem") {
          throw new Error(`App payload must not contain private key files: ${rel}`);
        }
        const data = await readFile(full);
        if (/\.(?:pem|key|txt|json)$/u.test(entry.name)) {
          const text = data.toString("utf8");
          if (PRIVATE_KEY_MARKERS.some((m) => text.includes(m))) {
            throw new Error(`App payload contains private key material in ${rel}`);
          }
        }
        rendererFiles.push({ name: `renderer/${rel}`, content: data });
      }
    }
  };
  await walkDir(rendererDir);

  // 3. Assemble App Payload Manifest and Checksums
  const manifestObj = {
    payloadVersion: appVersion,
    payloadFormat: 1,
    platform,
    abi,
    clientContractVersion: CLIENT_CONTRACT_VERSION,
    studioProtocol: { min: STUDIO_PROTOCOL_VERSION, max: STUDIO_PROTOCOL_VERSION },
    entries: ["preload.cjs", "renderer"],
  };
  const manifestText = canonicalJson(manifestObj);
  const manifestBuf = Buffer.from(manifestText, "utf8");

  const checksumFiles = {};
  checksumFiles["app-payload-manifest.json"] = createHash("sha256").update(manifestBuf).digest("hex");
  checksumFiles["preload.cjs"] = createHash("sha256").update(preloadContent).digest("hex");
  for (const rf of rendererFiles) {
    checksumFiles[rf.name] = createHash("sha256").update(rf.content).digest("hex");
  }

  const sortedChecksumFiles = {};
  for (const k of Object.keys(checksumFiles).sort()) {
    sortedChecksumFiles[k] = checksumFiles[k];
  }
  const checksumsObj = {
    algorithm: "sha256",
    files: sortedChecksumFiles,
  };
  const checksumsText = canonicalJson(checksumsObj);
  const checksumsBuf = Buffer.from(checksumsText, "utf8");

  const payloadBytes = Buffer.concat([manifestBuf, Buffer.from("\0"), checksumsBuf]);
  const payloadSha256 = createHash("sha256").update(payloadBytes).digest("hex");

  let signatureText = "";
  if (signingKey) {
    const sig = sign(null, payloadBytes, signingKey).toString("base64url");
    const sigObj = {
      algorithm: "ed25519",
      keyId,
      payloadSha256,
      signature: sig,
    };
    signatureText = canonicalJson(sigObj);
  }

  // Staging tree
  const stagingAppPayloadDir = join(outDir, "app-payload", appVersion);
  await mkdir(stagingAppPayloadDir, { recursive: true });
  await writeFile(join(stagingAppPayloadDir, "app-payload-manifest.json"), manifestBuf);
  await writeFile(join(stagingAppPayloadDir, "checksums.json"), checksumsBuf);
  if (signatureText) {
    await writeFile(join(stagingAppPayloadDir, "payload-signature.json"), signatureText, "utf8");
  }
  await writeFile(join(stagingAppPayloadDir, "preload.cjs"), preloadContent);
  for (const rf of rendererFiles) {
    const dest = join(stagingAppPayloadDir, rf.name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, rf.content);
  }

  // Build tar.gz
  const tarEntries = [
    { name: "app-payload-manifest.json", content: manifestBuf },
    { name: "checksums.json", content: checksumsBuf },
    ...(signatureText ? [{ name: "payload-signature.json", content: Buffer.from(signatureText, "utf8") }] : []),
    { name: "preload.cjs", content: preloadContent },
    ...rendererFiles,
  ];
  const tarGz = createDeterministicTarGz(tarEntries);
  const tarGzName = `omp-studio-app-${appVersion}-${platform}.tar.gz`;
  const tarGzPath = join(outDir, tarGzName);
  await writeFile(tarGzPath, tarGz);
  const tarGzSha256 = createHash("sha256").update(tarGz).digest("hex");
  const tarGzSize = tarGz.length;

  // 4. Runtime Section
  let runtimeSection = options.runtimeSection;
  if (!runtimeSection) {
    const possibleDirs = [
      options.runtimeDir,
      join(unpackedDir, "runtime", "versions"),
      join(rootDir, "packaging", "runtime-payload"),
      join(rootDir, "packages", "runtime-installer", "dist", "artifacts", "win32-x64"),
    ].filter(Boolean);

    let foundRuntimeDir;
    for (const dir of possibleDirs) {
      if (!existsSync(dir)) continue;
      if (existsSync(join(dir, "runtime-manifest.json"))) {
        foundRuntimeDir = dir;
        break;
      }
      const subdirs = readdirSync(dir, { withFileTypes: true }).filter(
        (d) => d.isDirectory() && !d.name.startsWith("."),
      );
      if (subdirs.length > 1) throw new Error(`Ambiguous Runtime versions in ${dir}`);
      if (subdirs.length === 1) {
        foundRuntimeDir = join(dir, subdirs[0].name);
        break;
      }
    }

    if (foundRuntimeDir && existsSync(join(foundRuntimeDir, "runtime-manifest.json"))) {
      const rtManifest = JSON.parse(await readFile(join(foundRuntimeDir, "runtime-manifest.json"), "utf8"));
      const rtFiles = [];
      const requiredNames = ["omp.exe", "runtime-manifest.json", "checksums.json", "runtime-signature.json"];
      for (const name of requiredNames) {
        const filePath = join(foundRuntimeDir, name);
        if (!existsSync(filePath)) throw new Error(`Missing runtime file ${name} in ${foundRuntimeDir}`);
        const data = await readFile(filePath);
        rtFiles.push({
          name,
          url: `https://github.com/${repo}/releases/download/v${appVersion}/${name}`,
          size: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      }
      runtimeSection = {
        runtimeVersion: rtManifest.runtimeVersion,
        channel: rtManifest.channel ?? "stable",
        platform,
        entrypoint: rtManifest.entrypoint ?? "omp.exe",
        minAppVersion: rtManifest.minAppVersion ?? "0.1.0",
        studioProtocol: rtManifest.studioProtocol ?? { min: 1, max: 1 },
        files: rtFiles,
      };
    } else {
      throw new Error("A real signed Runtime artifact is required; refusing placeholder metadata");
    }
  }

  // 5. Setup Asset
  let setupAsset = options.setupAsset;
  if (!setupAsset) {
    const installerDir = options.installerDir ?? join(rootDir, "outputs", "installer");
    let foundSetup;
    if (existsSync(installerDir)) {
      const files = readdirSync(installerDir).filter(
        (f) => f.startsWith("OMP-Studio-Setup") && f.endsWith(".exe"),
      );
      if (files.length > 1) throw new Error(`Ambiguous Setup artifacts in ${installerDir}`);
      if (files.length === 1) {
        const full = join(installerDir, files[0]);
        const data = readFileSync(full);
        foundSetup = {
          asset: files[0],
          url: `https://github.com/${repo}/releases/download/v${appVersion}/${files[0]}`,
          size: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        };
      }
    }
    if (!foundSetup) throw new Error("A real Setup installer is required; refusing placeholder metadata");
    setupAsset = foundSetup;
  }

  // 6. Sequence
  const previousIndexPath = options.previousIndexPath ?? process.env.OMP_PREVIOUS_UPDATE_INDEX;
  const previousIndex = options.previousIndex ?? (previousIndexPath
    ? JSON.parse(await readFile(previousIndexPath, "utf8")) : undefined);
  if (previousIndex !== undefined && (!Number.isSafeInteger(previousIndex.sequence) || previousIndex.sequence < 1)) {
    throw new Error("Previous update index sequence must be a positive safe integer");
  }
  const sequence = options.sequence ?? (previousIndex ? previousIndex.sequence + 1 : 1);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || (previousIndex && sequence <= previousIndex.sequence)) {
    throw new Error("Update sequence must increase and be a positive safe integer");
  }
  const minAppVersion = options.minAppVersion ?? process.env.OMP_PAYLOAD_MIN_APP_VERSION ?? appVersion;

  // 7. Assemble Update Index
  const updateIndex = {
    schema: 1,
    sequence,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    repo,
    app: {
      version: appVersion,
      ...(options.releaseNotesUrl ? { releaseNotesUrl: options.releaseNotesUrl } : {}),
      setup: setupAsset,
      payload: {
        asset: tarGzName,
        url: `https://github.com/${repo}/releases/download/v${appVersion}/${tarGzName}`,
        size: tarGzSize,
        sha256: tarGzSha256,
        payloadFormat: 1,
        minAppVersion,
        platform,
        abi,
        clientContractVersion: CLIENT_CONTRACT_VERSION,
        studioProtocol: { min: STUDIO_PROTOCOL_VERSION, max: STUDIO_PROTOCOL_VERSION },
      },
    },
    runtime: runtimeSection,
  };

  const indexJsonText = canonicalJson(updateIndex);
  const indexJsonPath = join(outDir, "update-index.json");
  await writeFile(indexJsonPath, indexJsonText, "utf8");

  let indexSigJsonPath;
  if (signingKey) {
    const indexBytes = Buffer.from(indexJsonText, "utf8");
    const indexSha256 = createHash("sha256").update(indexBytes).digest("hex");
    const sig = sign(null, indexBytes, signingKey).toString("base64url");
    const sigObj = {
      algorithm: "ed25519",
      keyId,
      payloadSha256: indexSha256,
      signature: sig,
    };
    const indexSigText = canonicalJson(sigObj);
    indexSigJsonPath = join(outDir, "update-index.sig.json");
    await writeFile(indexSigJsonPath, indexSigText, "utf8");
  }

  return {
    updateIndex,
    tarGzPath,
    tarGzSha256,
    tarGzSize,
    indexJsonPath,
    indexSigJsonPath,
  };
}

// CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  buildUpdateAssets().then((res) => {
    console.log(`Update assets generated:`);
    console.log(`- App payload: ${res.tarGzPath} (${res.tarGzSize} bytes, sha256: ${res.tarGzSha256})`);
    console.log(`- Update index: ${res.indexJsonPath}`);
    if (res.indexSigJsonPath) console.log(`- Update index signature: ${res.indexSigJsonPath}`);
  }).catch((err) => {
    console.error(`Failed to build update assets:`, err);
    process.exitCode = 1;
  });
}
