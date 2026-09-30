import { assertMacToolchain } from "./mac-toolchain.mjs";
import { findBun, ompSourceDirectory, run, toolingEnvironment } from "./omp-tooling.mjs";

const args = ["install", "--frozen-lockfile", "--concurrent-scripts", "1"];
if (process.platform === "win32") args.push("--backend", "copyfile");

const bun = findBun();
const env = toolingEnvironment({
  BUN_CONFIG_MAX_HTTP_REQUESTS: process.env.BUN_CONFIG_MAX_HTTP_REQUESTS ?? "4",
});
if (process.platform === "darwin") assertMacToolchain({ bunVersion: run(bun, ["--version"], { env, capture: true }), env });

run(bun, args, {
  cwd: ompSourceDirectory,
  env,
});
