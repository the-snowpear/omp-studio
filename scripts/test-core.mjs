// Daily regression suite. Run after `npm run build`; `npm test` runs all
// workspace tests. The list itself lives in core-suites.mjs so that
// `npm run check` and CI read the same source.
import { CORE_NODE_SUITES, CORE_RENDERER_SUITES } from "./core-suites.mjs";
import { npmInvocation, run } from "./omp-tooling.mjs";

run(process.execPath, ["--test", ...CORE_NODE_SUITES]);
const npm = npmInvocation();
run(npm.command, [...npm.prefix, "run", "test", "-w", "@omp-studio/renderer", "--", ...CORE_RENDERER_SUITES]);
