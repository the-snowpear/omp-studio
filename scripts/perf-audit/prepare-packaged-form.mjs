#!/usr/bin/env node
/**
 * Builds a "packaged form" Electron tree for perf measurement, without
 * packaging an installer and without touching the user's installed app.
 *
 * Why: `scripts/preview.mjs` shows that renaming `electron.exe` makes Electron
 * report `app.isPackaged === true`, which switches on the managed-Runtime code
 * paths (Runtime discovery/verification, update coordinator). Those paths are
 * what a real user pays for at startup, and they never run in the plain
 * `electron apps/desktop` dev form.
 *
 * The tree is assembled with hard links (same NTFS volume) instead of copies,
 * so ~570 MB of Electron + Runtime payload costs almost no extra disk. If a
 * hard link fails the file is copied instead.
 *
 * Layout mirrored from scripts/preview.mjs + electron-builder extraFiles:
 *   <out>/OMP Studio.exe           (renamed hard link of electron.exe)
 *   <out>/**                       (rest of the Electron distribution)
 *   <out>/runtime/versions/<v>/**  (signed Runtime payload)
 *   <out>/runtime-keys/**          (trusted public keys)
 *
 * Usage:
 *   node scripts/perf-audit/prepare-packaged-form.mjs [--out DIR] [--force]
 */
import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { BENCH_ROOT, REPO_ROOT, writeJson } from "./lib/collect.mjs";

function parseArgs(argv) {
  const args = { out: join(BENCH_ROOT, "packaged-form"), force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i];
    else if (arg === "--force") args.force = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** Mirror `from` into `to` using hard links, copying when linking is impossible. */
function mirror(from, to) {
  mkdirSync(to, { recursive: true });
  let linked = 0;
  let copied = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      const nested = mirror(source, target);
      linked += nested.linked;
      copied += nested.copied;
    } else if (entry.isFile()) {
      try {
        linkSync(source, target);
        linked += 1;
      } catch {
        copyFileSync(source, target);
        copied += 1;
      }
    }
  }
  return { linked, copied };
}

function linkFile(from, to) {
  try {
    linkSync(from, to);
    return "hardlink";
  } catch {
    copyFileSync(from, to);
    return "copy";
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const electronDist = join(REPO_ROOT, "node_modules", "electron", "dist");
  const payloadRoot = join(REPO_ROOT, "packaging", "runtime-payload");
  const keysRoot = join(REPO_ROOT, "packaging", "runtime-keys");
  for (const required of [electronDist, payloadRoot, keysRoot]) {
    if (!existsSync(required)) throw new Error(`missing input: ${required}`);
  }
  const out = args.out;
  if (args.force) rmSync(out, { recursive: true, force: true });
  if (existsSync(join(out, "OMP Studio.exe"))) {
    console.log(JSON.stringify({ out, exe: join(out, "OMP Studio.exe"), reused: true }, null, 2));
    return;
  }

  const mirrored = mirror(electronDist, out);
  // Remove the default-app entry point and give the binary its packaged name.
  rmSync(join(out, "electron.exe"), { force: true });
  const exe = join(out, "OMP Studio.exe");
  const exeLink = linkFile(join(electronDist, "electron.exe"), exe);

  const versions = readdirSync(payloadRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  for (const version of versions) {
    mirror(join(payloadRoot, version.name), join(out, "runtime", "versions", version.name));
  }
  mirror(keysRoot, join(out, "runtime-keys"));

  const sizeBytes = (dir) => {
    let total = 0;
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else total += statSync(full).size;
      }
    };
    walk(dir);
    return total;
  };
  const summary = {
    out,
    exe,
    reused: false,
    exeLink,
    versions: versions.map((entry) => entry.name),
    electronMirror: mirrored,
    logicalBytes: sizeBytes(out),
    note: "hard links share storage with the originals; rm -rf this directory to clean up",
  };
  writeJson(join(BENCH_ROOT, "raw", "packaged-form.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main();
