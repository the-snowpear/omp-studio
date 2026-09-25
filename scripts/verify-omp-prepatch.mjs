import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { overlayFiles } from "./omp-overlay.mjs";
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
// Canonical overlay/patch sources stay in the Studio repository during an
// upgrade. The baseline being verified is the vendor working tree, not the
// storage location of the fork that will subsequently be migrated.
const appliedOverlay = (await overlayFiles()).filter(file =>
  existsSync(join(ompSourceDirectory, file)),
);
if (appliedOverlay.length !== 0) {
  throw new Error(`Pre-patch verification requires an unapplied overlay:\n${appliedOverlay.join("\n")}`);
}

const sourceStatus = run("git", ["-C", ompSourceDirectory, "status", "--porcelain"], { capture: true });
if (sourceStatus !== "") throw new Error(`OMP source is not clean:\n${sourceStatus}`);

const bun = findBun();
const bunVersion = run(bun, ["--version"], { capture: true });
const [bunMajor, bunMinor, bunPatch] = bunVersion.split(".").map(Number);
if (!(bunMajor > 1 || (bunMajor === 1 && (bunMinor > 4 || (bunMinor === 4 && bunPatch >= 2))))) {
  throw new Error(`The Windows bytecode baseline requires Bun >=1.4.2; found ${bunVersion}. Set BUN_EXE to a compatible executable.`);
}

const nativeDirectory = join(ompSourceDirectory, "packages", "natives", "native");
const nativeCandidates = process.platform === "win32"
  ? ["pi_natives.win32-x64-modern.node", "pi_natives.win32-x64-baseline.node"]
  : [];
if (nativeCandidates.length > 0 && !nativeCandidates.some(name => existsSync(join(nativeDirectory, name)))) {
  throw new Error("The Windows pi_natives addon is missing; build the unpatched vendor packages/natives first");
}

const executable = join(
  ompSourceDirectory,
  "packages",
  "coding-agent",
  "dist",
  process.platform === "win32" ? "omp.exe" : "omp",
);
if (!existsSync(executable)) throw new Error("The OMP executable is missing; build the unpatched vendor packages/coding-agent first");

const env = toolingEnvironment();
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run pre-patch verification through npm run omp:verify:prepatch");
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
  ],
  { cwd: ompSourceDirectory, env },
);
run(bun, ["run", "ci:test:smoke"], { cwd: ompSourceDirectory, env });
const expectedVersion = JSON.parse(readFileSync(join(ompSourceDirectory, "packages/coding-agent/package.json"), "utf8")).version;
const binaryVersion = run(executable, ["--version"], { cwd: ompSourceDirectory, env, capture: true });
if (!binaryVersion.includes(expectedVersion)) throw new Error(`Stale baseline binary: expected ${expectedVersion}, found ${binaryVersion}`);
run(executable, ["--smoke-test"], { cwd: ompSourceDirectory, env });

console.log(`Pre-patch baseline verified at ${upstream.commit}`);
