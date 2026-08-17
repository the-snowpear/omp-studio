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
if (series.patches.length !== 0) {
  throw new Error("Pre-patch verification requires an empty patch series");
}
// The overlay carries most of the fork, so an unpatched baseline means both
// layers are absent — a populated overlay would silently invalidate the run.
if ((await overlayFiles().catch(() => [])).length !== 0) {
  throw new Error("Pre-patch verification requires an empty overlay");
}

const sourceStatus = run("git", ["-C", ompSourceDirectory, "status", "--porcelain"], { capture: true });
if (sourceStatus !== "") throw new Error(`OMP source is not clean:\n${sourceStatus}`);

const bun = findBun();
const bunVersion = run(bun, ["--version"], { capture: true });
if (bunVersion !== "1.3.14") throw new Error(`Expected Bun 1.3.14, found ${bunVersion}`);

const nativeDirectory = join(ompSourceDirectory, "packages", "natives", "native");
const nativeCandidates = process.platform === "win32"
  ? ["pi_natives.win32-x64-modern.node", "pi_natives.win32-x64-baseline.node"]
  : [];
if (nativeCandidates.length > 0 && !nativeCandidates.some(name => existsSync(join(nativeDirectory, name)))) {
  throw new Error("The Windows pi_natives addon is missing; run npm run omp:build:host");
}

const executable = join(
  ompSourceDirectory,
  "packages",
  "coding-agent",
  "dist",
  process.platform === "win32" ? "omp.exe" : "omp",
);
if (!existsSync(executable)) throw new Error("The OMP host executable is missing; run npm run omp:build:host");

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
run(executable, ["--version"], { cwd: ompSourceDirectory, env });
run(executable, ["--smoke-test"], { cwd: ompSourceDirectory, env });

console.log(`Pre-patch baseline verified at ${upstream.commit}`);
