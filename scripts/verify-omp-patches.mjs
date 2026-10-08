// Verify the two-layer fork model against the pinned upstream tree.
//
//   overlay  omp-patch/overlay/**  copied in (Studio-owned files, absent upstream)
//   seam     omp-patch/patches/*   applied in series order (edits to upstream files)
//
// The vendor tree must be clean going in and clean coming out. Two invariants
// are enforced beyond "it builds": the overlay may not modify any
// upstream-tracked file (that would smuggle a seam change past review), and
// every seam patch must apply with `--check` before it is applied for real.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyOverlay, assertOverlayPresent, removeOverlay } from "./omp-overlay.mjs";
import {
  findBun,
  ompSourceDirectory as vendorSourceDirectory,
  repositoryRoot,
  run,
  toolingEnvironment,
} from "./omp-tooling.mjs";

// A scratch clone lets local verification preserve the active patched checkout.
const sourceIndex = process.argv.indexOf("--source");
if (sourceIndex >= 0 && !process.argv[sourceIndex + 1]) throw new Error("--source requires a checkout directory");
const ompSourceDirectory = sourceIndex >= 0 ? resolve(process.argv[sourceIndex + 1]) : vendorSourceDirectory;

const upstream = JSON.parse(
  readFileSync(join(repositoryRoot, "omp-patch", "upstream.json"), "utf8"),
);
const series = JSON.parse(
  readFileSync(join(repositoryRoot, "omp-patch", "patches", "series.json"), "utf8"),
);

const head = run("git", ["-C", ompSourceDirectory, "rev-parse", "HEAD"], { capture: true });
if (head !== upstream.commit || series.upstreamCommit !== upstream.commit) {
  throw new Error(`OMP pin mismatch: source=${head}, upstream=${upstream.commit}, series=${series.upstreamCommit}`);
}
if (!Array.isArray(series.patches)) {
  throw new Error("Patch verification requires a patches array in series.json");
}
const managedOverlayFiles = await assertOverlayPresent();

const initialStatus = run("git", ["-C", ompSourceDirectory, "status", "--porcelain"], { capture: true });
if (initialStatus !== "") throw new Error(`OMP source must be clean before patch verification:\n${initialStatus}`);

const patchFiles = series.patches.map(name => join(repositoryRoot, "omp-patch", "patches", name));
const applied = [];
let overlayApplied = false;
let verificationError;

try {
  const overlayFiles = await applyOverlay(ompSourceDirectory);
  overlayApplied = true;
  const overlayTouchedTracked = run("git", ["-C", ompSourceDirectory, "diff", "--name-only"], { capture: true });
  if (overlayTouchedTracked !== "") {
    throw new Error(
      `Overlay overwrote upstream-tracked files; those edits belong in a seam patch:\n${overlayTouchedTracked}`,
    );
  }
  console.log(`Applied ${overlayFiles.length} overlay file(s)`);

  for (const patchFile of patchFiles) {
    run("git", ["-C", ompSourceDirectory, "apply", "--check", patchFile]);
    run("git", ["-C", ompSourceDirectory, "apply", patchFile]);
    applied.push(patchFile);
  }

  const bun = findBun();
  const env = toolingEnvironment();
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run patch verification through npm run omp:verify:patches");

  run("git", ["-C", ompSourceDirectory, "diff", "--check"]);
  // Workspace checks belong to `npm run check`; opt in only for standalone use.
  if (process.argv.includes("--with-workspace-check")) {
    run(process.execPath, [npmCli, "run", "check"], { cwd: repositoryRoot, env });
  }
  run(bun, ["run", "check:ts"], { cwd: ompSourceDirectory, env });
  run(bun, ["test", "packages/coding-agent/test/studio-bridge-server.test.ts"], {
    cwd: ompSourceDirectory,
    env,
    timeoutMs: 120_000,
  });
  run(bun, ["test", "packages/coding-agent/test/main-host-classification.test.ts"], {
    cwd: ompSourceDirectory,
    env,
    timeoutMs: 120_000,
  });
  run(bun, ["test", "packages/coding-agent/test/modes/components/pause-screen.test.ts"], {
    cwd: ompSourceDirectory,
    env,
    timeoutMs: 120_000,
  });
  // Native module teardown is unstable in Bun's Windows test workers.
  // Keep suite isolation with OS processes instead of the worker pool.
  const suites = [
      "packages/agent/test/pause-gate.test.ts",
      "packages/coding-agent/test/cli-argv-routing.test.ts",
      "packages/coding-agent/test/cli-unknown-flag.test.ts",
      "packages/coding-agent/test/session-manager/studio-origin.test.ts",
      "packages/coding-agent/test/extensions-runner.test.ts",
      "packages/coding-agent/test/interactive-mode-loop.test.ts",
  ];
  const allSuites = new Set([
    ...suites,
    ...managedOverlayFiles.filter(file => file.includes("/test/") && file.endsWith(".test.ts") && !file.endsWith("/studio-bridge-server.test.ts")),
    "packages/coding-agent/test/context-notes.test.ts",
    "packages/coding-agent/test/session/model-mentions.test.ts",
    "packages/coding-agent/test/foreign-session-stores.test.ts",
    "packages/coding-agent/test/tools/read-image-question.test.ts",
    "packages/coding-agent/test/utils/image-question.test.ts",
    "packages/coding-agent/test/eval/judgment-bridge.test.ts",
    "packages/coding-agent/test/plan-autosave.test.ts",
    "packages/coding-agent/test/loop-condition.test.ts",
    "packages/coding-agent/test/agent-session-prewalk.test.ts",
    "packages/coding-agent/test/agent-session-queue-update-events.test.ts",
    "packages/coding-agent/test/rpc-queued-message.test.ts",
    "packages/coding-agent/test/config/settings-registry.test.ts",
    "packages/coding-agent/test/bench-profiles.test.ts",
    "packages/coding-agent/test/bench-cache.test.ts",
    "packages/agent/test/anthropic-native-compaction.test.ts",
  ]);
  // Bun's 5s default per-test timeout is not enough on loaded CI runners
  // (SVG rasterization in read-image-question exceeded it on windows-latest).
  for (const suite of allSuites) {
    run(bun, ["test", "--timeout=30000", suite], {
      cwd: ompSourceDirectory, env, timeoutMs: 120_000,
    });
  }
  run(bun, ["run", "ci:test:smoke"], { cwd: ompSourceDirectory, env, timeoutMs: 120_000 });
} catch (error) {
  verificationError = error;
} finally {
  for (const patchFile of applied.toReversed()) {
    try {
      run("git", ["-C", ompSourceDirectory, "apply", "-R", patchFile]);
    } catch (error) {
      verificationError = new AggregateError(
        [verificationError, error].filter(Boolean),
        "Patch verification failed and the vendor tree could not be fully restored",
      );
      break;
    }
  }
  if (overlayApplied) {
    try {
      await removeOverlay(ompSourceDirectory);
    } catch (error) {
      verificationError = new AggregateError(
        [verificationError, error].filter(Boolean),
        "Patch verification failed and the overlay could not be fully removed",
      );
    }
  }
}

const finalStatus = run("git", ["-C", ompSourceDirectory, "status", "--porcelain"], { capture: true });
if (finalStatus !== "") {
  throw new Error(`OMP source is not clean after patch verification:\n${finalStatus}`, {
    cause: verificationError,
  });
}
if (verificationError) throw verificationError;

console.log(
  `Verified overlay + ${series.patches.length} seam patch(es) at ${upstream.commit}; vendor restored clean`,
);
