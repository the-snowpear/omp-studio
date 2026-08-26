// Seam layer definition for the OMP vendor fork.
//
// Studio's changes to the pinned upstream tree split into two layers:
//
//   overlay   omp-patch/overlay/**  — files that do not exist upstream at all
//             (`packages/coding-agent/src/studio/**` and the `studio-*` tests).
//             These are plain tracked sources in this repository; they are
//             copied into the vendor tree, never expressed as a patch.
//
//   seam      omp-patch/patches/*.patch — the only edits that touch files
//             upstream owns. Grouped by upstream subsystem so an upstream bump
//             maps to a small, predictable set of patches to refresh.
//
// SEAM_GROUPS is the authoritative mapping. `npm run omp:patches:regen`
// regenerates each patch from the vendor working tree using these path lists,
// and the group order defines the apply order recorded in series.json.
//
// Adding a seam file means adding it to the right group here, then rerunning
// the regen script — never hand-editing a .patch.

export const OVERLAY_DIRECTORY = "omp-patch/overlay";
export const PATCHES_SUBDIRECTORY = "omp-patch/patches";

/**
 * Overlay file whose `PATCHSET_VERSION` the Runtime reports in its Studio
 * Hello. It must equal `series.json` `patchsetVersion`: packaging probes the
 * built binary and refuses to sign an artifact whose reported identity
 * disagrees with the series, so a stale constant otherwise fails only after a
 * full native build.
 */
export const PATCHSET_VERSION_FILE = "packages/coding-agent/src/studio/bridge-server.ts";

/** Upstream paths intentionally left unpatched even when the vendor tree changes them. */
export const SEAM_EXCLUDED = Object.freeze([
  // Fork-local changelog prose conflicts on every upstream release and carries
  // no runtime behaviour. Studio's history lives in this repository instead.
  "packages/coding-agent/CHANGELOG.md",
]);

export const SEAM_GROUPS = Object.freeze([
  {
    file: "0001-studio-cli-entry.patch",
    title: "Studio host CLI entry, flags, and process classification",
    paths: [
      "packages/coding-agent/package.json",
      "packages/coding-agent/src/cli.ts",
      "packages/coding-agent/src/cli/args.ts",
      "packages/coding-agent/src/cli/flag-tables.ts",
      "packages/coding-agent/src/commands/launch-help.ts",
      "packages/coding-agent/src/main.ts",
      "packages/coding-agent/test/main-host-classification.test.ts",
    ],
  },
  {
    file: "0002-studio-session-runtime.patch",
    title: "Session runtime hooks: origin, prewalk, model control, retry abort",
    paths: [
      "packages/coding-agent/src/plan-mode/approved-plan.ts",
      "packages/coding-agent/src/registry/agent-registry.ts",
      "packages/coding-agent/src/session/agent-session-events.ts",
      "packages/coding-agent/src/session/agent-session-types.ts",
      "packages/coding-agent/src/session/agent-session.ts",
      "packages/coding-agent/src/session/prewalk.ts",
      "packages/coding-agent/src/session/session-entries.ts",
      "packages/coding-agent/src/session/session-manager.ts",
      "packages/coding-agent/src/session/turn-recovery.ts",
    ],
  },
  {
    file: "0003-studio-modes-and-pause.patch",
    title: "Interactive mode, pause screen, mode slash commands, job manager",
    paths: [
      "packages/coding-agent/src/async/job-manager.ts",
      "packages/coding-agent/src/modes/components/pause-screen.ts",
      "packages/coding-agent/src/modes/controllers/event-controller.ts",
      "packages/coding-agent/src/modes/interactive-mode.ts",
      "packages/coding-agent/src/modes/rpc/rpc-mode.ts",
      "packages/coding-agent/src/modes/types.ts",
      "packages/coding-agent/src/slash-commands/builtin-modes.ts",
      "packages/coding-agent/test/interactive-mode-loop.test.ts",
      "packages/coding-agent/test/modes/components/pause-screen.test.ts",
    ],
  },
  {
    file: "0004-studio-extensibility.patch",
    title: "Extension UI transport, SDK surface, and tool context plumbing",
    paths: [
      "packages/coding-agent/src/extensibility/extensions/types.ts",
      "packages/coding-agent/src/extensibility/extensions/wrapper.ts",
      "packages/coding-agent/src/sdk.ts",
      "packages/coding-agent/src/tools/context.ts",
      "packages/coding-agent/test/extensions-runner.test.ts",
    ],
  },
]);

export function seamPatchNames() {
  return SEAM_GROUPS.map(group => group.file);
}

export function seamPathOwner(filePath) {
  return SEAM_GROUPS.find(group => group.paths.includes(filePath));
}

const PATCHSET_VERSION_PATTERN = /^const PATCHSET_VERSION = "([^"]+)";$/mu;

/**
 * Placeholder substituted for the version literal when hashing the overlay.
 *
 * The literal is derived *from* the overlay digest, so hashing it verbatim
 * would be circular: writing the newly derived version back into the file
 * would change the digest and demand another bump, forever. Provenance does
 * not lose the version — the artifact manifest records `runtimeVersion`, and
 * packaging probes the built binary to confirm it reports exactly that.
 */
const PATCHSET_VERSION_PLACEHOLDER = 'const PATCHSET_VERSION = "<derived-from-series>";';

/** The `PATCHSET_VERSION` literal declared in an overlay `bridge-server.ts`. */
export function readPatchsetVersionConstant(source) {
  const match = PATCHSET_VERSION_PATTERN.exec(source);
  if (match === null) {
    throw new Error(`${PATCHSET_VERSION_FILE} does not declare a PATCHSET_VERSION constant`);
  }
  return match[1];
}

/** Same source with the version literal replaced; unchanged when already equal. */
export function withPatchsetVersionConstant(source, patchsetVersion) {
  readPatchsetVersionConstant(source);
  return source.replace(PATCHSET_VERSION_PATTERN, `const PATCHSET_VERSION = "${patchsetVersion}";`);
}

/** Version-independent view of an overlay file, for digesting. */
export function digestibleOverlaySource(overlayRelativePath, source) {
  if (overlayRelativePath !== PATCHSET_VERSION_FILE) return source;
  return source.replace(PATCHSET_VERSION_PATTERN, PATCHSET_VERSION_PLACEHOLDER);
}
