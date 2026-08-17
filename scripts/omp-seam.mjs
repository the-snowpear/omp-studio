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
