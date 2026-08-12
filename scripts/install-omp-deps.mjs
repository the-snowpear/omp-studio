import { findBun, ompSourceDirectory, run, toolingEnvironment } from "./omp-tooling.mjs";

const args = ["install", "--frozen-lockfile", "--concurrent-scripts", "1"];
if (process.platform === "win32") args.push("--backend", "copyfile");

run(findBun(), args, {
  cwd: ompSourceDirectory,
  env: toolingEnvironment({
    BUN_CONFIG_MAX_HTTP_REQUESTS: process.env.BUN_CONFIG_MAX_HTTP_REQUESTS ?? "4",
  }),
});
