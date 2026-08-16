#!/usr/bin/env node
/**
 * Plan 07 real Runtime Desktop E2E skeleton.
 *
 * Isolated temp workspace only. Never writes the user's current project
 * and never enables preview mode. This script does not claim success
 * unless a real Electron + managed/compatible OMP Runtime actually
 * produces transcript items.
 *
 * Exit codes:
 *   0  real E2E passed (reserved; not claimed by the skeleton)
 *   2  environment cannot start Electron / OMP (documented skip)
 *   1  unexpected failure while preparing the isolated workspace
 *
 * Manual steps when the environment cannot automate Electron:
 *   1. Create a throwaway folder (this script prints one).
 *   2. Launch Desktop with preview OFF (top-right 预览 switch).
 *   3. Open the temp folder as the workspace. Do not use a real user repo.
 *   4. Send: "Read package.json and reply with the exact phrase STUDIO_E2E_OK".
 *   5. Confirm one user bubble, streaming assistant text, and a Read tool.
 *   6. Abort a second long prompt; keep partial text marked aborted.
 *   7. Reload the window; completed messages return from transcript.
 *   8. History click resumes the same session. Do not use 新对话 — the
 *      button is disabled pending a session.create contract.
 *
 * Failure diagnosis:
 *   - Desktop main logs: Electron console / Studio profile logs
 *   - Host: session.transcript.read errors (CURSOR_STALE / UNAVAILABLE)
 *   - Runtime: omp daily log under the user log directory (do not paste secrets)
 *   - Renderer: conversation hydrateStatus / resyncRequired
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronBin = join(root, "node_modules", "electron", "cli.js");
const desktopEntry = join(root, "apps", "desktop", "dist", "src", "main.js");
const ompHint = process.env.OMP_RUNTIME_EXECUTABLE ?? "";

function printManual(workspace) {
  console.log(`Isolated workspace: ${workspace}`);
  console.log("Preview mode: must stay OFF. This E2E must not use fixture/mock data.");
  console.log("New conversation button: honestly disabled until session.create exists.");
  console.log("Abort + reload + history resume are in-scope; do not write the user project.");
}

let workspace;
try {
  workspace = await mkdtemp(join(tmpdir(), "omp-studio-conversation-e2e-"));
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify({ name: "omp-studio-e2e-fixture", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  await writeFile(
    join(workspace, "README.md"),
    "# OMP Studio conversation E2E fixture\n\nTemporary workspace. Safe to delete.\n",
  );

  const electronReady = existsSync(electronBin) && existsSync(desktopEntry);
  const ompReady = ompHint.length > 0 && existsSync(ompHint);
  printManual(workspace);
  if (!electronReady || !ompReady) {
    console.error(
      [
        "Real Runtime Desktop E2E was not run.",
        `electron/desktop entry ready: ${electronReady}`,
        `OMP_RUNTIME_EXECUTABLE present: ${ompReady}`,
        "Set OMP_RUNTIME_EXECUTABLE to a managed/compatible omp.exe and build apps/desktop first.",
        "Then re-run: npm run conversation:e2e:manual",
      ].join("\n"),
    );
    process.exitCode = 2;
  } else {
    console.error(
      "Automated Electron driving is not wired in this skeleton. Run the manual steps above against the isolated workspace. Marking E2E as not run.",
    );
    process.exitCode = 2;
  }
} catch (error) {
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
  console.error(error);
  process.exitCode = 1;
}
