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
import { join } from "node:path";
import { applyOverlay, assertOverlayPresent, removeOverlay } from "./omp-overlay.mjs";
import {
  findBun,
  ompSourceDirectory,
  repositoryRoot,
  run,
  toolingEnvironment,
} from "./omp-tooling.mjs";

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
await assertOverlayPresent();

const initialStatus = run("git", ["-C", ompSourceDirectory, "status", "--porcelain"], { capture: true });
if (initialStatus !== "") throw new Error(`OMP source must be clean before patch verification:\n${initialStatus}`);

const patchFiles = series.patches.map(name => join(repositoryRoot, "omp-patch", "patches", name));
const applied = [];
let overlayApplied = false;
let verificationError;

try {
  const overlayFiles = await applyOverlay();
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
  run(process.execPath, [npmCli, "run", "check"], { cwd: repositoryRoot, env });
  run(bun, ["run", "check:ts"], { cwd: ompSourceDirectory, env });
  run(
    bun,
    [
      "test",
      "packages/agent/test/pause-gate.test.ts",
      "packages/coding-agent/test/modes/components/pause-screen.test.ts",
      "packages/coding-agent/test/cli-argv-routing.test.ts",
      "packages/coding-agent/test/cli-unknown-flag.test.ts",
      "packages/coding-agent/test/main-host-classification.test.ts",
      "packages/coding-agent/test/session-manager/studio-origin.test.ts",
      "packages/coding-agent/test/studio-host-args.test.ts",
      "packages/coding-agent/test/studio-bridge-server.test.ts",
      "packages/coding-agent/test/studio-command-arbiter.test.ts",
      "packages/coding-agent/test/studio-host-mode.test.ts",
      "packages/coding-agent/test/studio-loop-service.test.ts",
      "packages/coding-agent/test/studio-live-service.test.ts",
      "packages/coding-agent/test/extensions-runner.test.ts",
      "packages/coding-agent/test/interactive-mode-loop.test.ts",
      "packages/coding-agent/test/studio-mode-control-service.test.ts",
      "packages/coding-agent/test/studio-tree-service.test.ts",
      "packages/coding-agent/test/studio-fork-service.test.ts",
      "packages/coding-agent/test/studio-handoff-service.test.ts",
      "packages/coding-agent/test/studio-fast-prewalk-service.test.ts",
      "packages/coding-agent/test/studio-model-control-service.test.ts",
      "packages/coding-agent/test/studio-session-control-dispatcher.test.ts",
      "packages/coding-agent/test/studio-session-control-service.test.ts",
      "packages/coding-agent/test/studio-agent-session-compatibility.test.ts",
      "packages/coding-agent/test/studio-skill-prompt-expansion.test.ts",
      "packages/coding-agent/test/studio-command-manifest-service.test.ts",
      "packages/coding-agent/test/studio-interaction-port.test.ts",
      "packages/coding-agent/test/studio-remote-extension-ui.test.ts",
      "packages/coding-agent/test/studio-approval-ask-e2e.test.ts",
      "packages/coding-agent/test/studio-btw-service.test.ts",
      "packages/coding-agent/test/studio-tan-service.test.ts",
      "packages/coding-agent/test/studio-omfg-service.test.ts",
      "packages/coding-agent/test/studio-agent-hub-service.test.ts",
      "packages/coding-agent/test/studio-job-service.test.ts",
      "packages/coding-agent/test/studio-m4-protocol.test.ts",
      "packages/coding-agent/test/studio-conversation-protocol.test.ts",
      "packages/coding-agent/test/studio-session-transcript-service.test.ts",
      "packages/coding-agent/test/studio-session-transcript-dispatcher.test.ts",
      "packages/coding-agent/test/studio-conversation-live-projector.test.ts",
      "packages/coding-agent/test/studio-conversation-live-bridge.test.ts",
      "packages/coding-agent/test/studio-agent-conversation-service.test.ts",
      "packages/coding-agent/test/studio-conversation-projector-hub.test.ts",
      "packages/coding-agent/test/studio-session-telemetry.test.ts",
      "packages/coding-agent/test/studio-archived-session-telemetry.test.ts",
    ],
    { cwd: ompSourceDirectory, env },
  );
  run(bun, ["run", "ci:test:smoke"], { cwd: ompSourceDirectory, env });
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
      await removeOverlay();
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
