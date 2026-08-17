// Overlay layer for the OMP vendor fork.
//
// The overlay holds every source file Studio adds that upstream does not have
// (`packages/coding-agent/src/studio/**` plus the `studio-*` tests). Those
// files are ordinary tracked sources here, so editing them is an ordinary edit
// with an ordinary diff — no patch numbering, no apply/reverse dance, and no
// rebase conflicts when the upstream pin moves.
//
// Direction of travel:
//
//   applyOverlay()    repository -> vendor tree (build, verification, dev loop)
//   captureOverlay()  vendor tree -> repository (after editing inside vendor)
//
// overlayHash() feeds the packaged artifact provenance so the manifest still
// covers the overlay bytes, the same way patchHashes covers the seam patches.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { OVERLAY_DIRECTORY, PATCHES_SUBDIRECTORY, seamPatchNames } from "./omp-seam.mjs";
import { ompSourceDirectory, repositoryRoot, run } from "./omp-tooling.mjs";

export const overlayRoot = join(repositoryRoot, ...OVERLAY_DIRECTORY.split("/"));

function toPosix(value) {
  return value.split(sep).join("/");
}

async function listRelativeFiles(root, base = root) {
  const entries = await readdir(base, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(base, entry.name);
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(root, full)));
    else if (entry.isFile()) files.push(toPosix(relative(root, full)));
  }
  return files;
}

/** Overlay-relative paths in a stable order. Stable order is what makes the hash reproducible. */
export async function overlayFiles(root = overlayRoot) {
  const files = await listRelativeFiles(root);
  return files.sort();
}

function assertContained(root, target, label) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error(`${label} escaped ${resolvedRoot}: ${resolvedTarget}`);
  }
}

/** Copy the overlay into a vendor tree. Returns the overlay-relative paths written. */
export async function applyOverlay(targetDirectory = ompSourceDirectory, root = overlayRoot) {
  const files = await overlayFiles(root);
  for (const file of files) {
    const destination = join(targetDirectory, ...file.split("/"));
    assertContained(targetDirectory, destination, "overlay destination");
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, ...file.split("/")), destination);
  }
  return files;
}

/** Delete overlay-provided files from a vendor tree, leaving upstream-tracked files untouched. */
export async function removeOverlay(targetDirectory = ompSourceDirectory, root = overlayRoot) {
  const files = await overlayFiles(root);
  for (const file of files) {
    const target = join(targetDirectory, ...file.split("/"));
    assertContained(targetDirectory, target, "overlay removal target");
    await rm(target, { force: true });
  }
  // Directories the overlay introduced (studio/, test/session-manager/) are left
  // behind empty; git ignores empty directories, so cleanliness checks still pass.
  return files;
}

/** Copy vendor-tree overlay files back into the repository. Reports what actually changed. */
export async function captureOverlay(targetDirectory = ompSourceDirectory, root = overlayRoot) {
  const files = await overlayFiles(root);
  const changed = [];
  const missing = [];
  for (const file of files) {
    const source = join(targetDirectory, ...file.split("/"));
    const destination = join(root, ...file.split("/"));
    let current;
    try {
      current = await readFile(source);
    } catch {
      missing.push(file);
      continue;
    }
    const stored = await readFile(destination);
    if (!current.equals(stored)) {
      await copyFile(source, destination);
      changed.push(file);
    }
  }
  return { changed, missing, total: files.length };
}

/**
 * Deterministic digest over overlay path/content pairs. Renaming a file changes
 * the digest even when the bytes are unchanged, so provenance tracks layout too.
 */
export async function overlayHash(root = overlayRoot) {
  const files = await overlayFiles(root);
  const digest = createHash("sha256");
  for (const file of files) {
    const content = await readFile(join(root, ...file.split("/")));
    digest.update(file);
    digest.update("\0");
    digest.update(createHash("sha256").update(content).digest("hex"));
    digest.update("\n");
  }
  return `sha256:${digest.digest("hex")}`;
}

/** Fails when the overlay directory is absent or empty, which would silently ship an unpatched runtime. */
export async function assertOverlayPresent(root = overlayRoot) {
  try {
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Overlay directory is missing: ${root}`);
  }
  const files = await overlayFiles(root);
  if (files.length === 0) throw new Error(`Overlay directory is empty: ${root}`);
  return files;
}

/**
 * Cheap precondition for anything that consumes a forked vendor tree: every
 * overlay file exists, and every upstream file a seam patch targets shows as
 * modified. Deliberately tolerant of content drift — the dev loop edits inside
 * the vendor tree before capturing, and blocking that would defeat the loop.
 * It only catches the real failure: building against a tree with no fork.
 */
export async function assertForkApplied(targetDirectory = ompSourceDirectory, root = overlayRoot) {
  const files = await assertOverlayPresent(root);
  const missing = files.filter(file => !existsSync(join(targetDirectory, ...file.split("/"))));
  if (missing.length > 0) {
    throw new Error(
      `The overlay is not present in the vendor tree; run npm run omp:overlay:apply. Missing ${missing.length} file(s), first: ${missing[0]}`,
    );
  }

  const modified = new Set(
    run("git", ["-C", targetDirectory, "diff", "--name-only"], { capture: true }).split(/\r?\n/u).filter(Boolean),
  );
  const patchesDirectory = join(repositoryRoot, ...PATCHES_SUBDIRECTORY.split("/"));
  const unapplied = [];
  for (const name of seamPatchNames()) {
    const patchFile = join(patchesDirectory, name);
    if (!existsSync(patchFile)) continue;
    const targets = [...(await readFile(patchFile, "utf8")).matchAll(/^diff --git a\/(\S+) b\//gmu)].map(m => m[1]);
    if (targets.some(target => !modified.has(target))) unapplied.push(name);
  }
  if (unapplied.length > 0) {
    throw new Error(
      `Seam patch(es) are not applied to the vendor tree; run npm run omp:overlay:apply: ${unapplied.join(", ")}`,
    );
  }
  return files;
}
