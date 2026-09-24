/** Five alternating A/B pairs reduce thermal/order drift between configurations. */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "outputs/perf/paired-streaming");
await mkdir(out, { recursive: true });
const samples = { before: [], after: [] };
const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  child.once("error", reject); child.once("exit", (code) => resolve({ code, output }));
});
for (let pair = 0; pair < 5; pair++) {
  for (const variant of pair % 2 === 0 ? ["before", "after"] : ["after", "before"]) {
    const path = join(out, `${pair}-${variant}.json`);
    const env = { ...process.env, PERF_RUNS: "1", PERF_TRACE: "1", PERF_REPORT: path,
      VITE_OMP_BOUNDED_MERMAID: variant === "before" ? "0" : "1",
      VITE_OMP_HIGHLIGHT_WORKER: "0", VITE_OMP_BACKGROUND_PUBLISHING: variant === "before" ? "0" : "1" };
    const result = await run(["scripts/streaming-perf-gate.mjs"], env);
    await writeFile(join(out, `${pair}-${variant}.log`), result.output);
    const report = JSON.parse(await readFile(path, "utf8"));
    if (result.code !== 0) report.status = "failed";
    samples[variant].push(report);
    console.log(`pair ${pair + 1} ${variant}: ${report.status}`);
  }
}
for (const variant of ["before", "after"]) {
  const runs = samples[variant];
  const scenarios = runs[0].scenarios.map((original) => {
    const matched = runs.map((run) => run.scenarios.find((scene) => scene.name === original.name));
    const result = { ...original };
    for (const key of Object.keys(original)) if (typeof original[key] === "number") {
      const values = matched.map((scene) => scene[key]).sort((a, b) => a - b);
      result[key] = values[2];
    }
    return { ...result, pairedSamples: matched };
  });
  const report = { ...runs[0], identity: { ...runs[0].identity, runs: 5, comparisonDesign: "five-alternating-pairs" },
    scenarios, runReports: runs.map((run) => ({ identity: run.identity, checks: run.checks, memory: run.memory })),
    status: runs.every((run) => run.status === "passed") ? "passed" : "failed" };
  await writeFile(join(out, `${variant}.json`), JSON.stringify(report, null, 2) + "\n");
}
const result = await run(["scripts/compare-streaming-perf.mjs", join(out, "before.json"), join(out, "after.json"), join(out, "comparison.json")], process.env);
await writeFile(join(out, "comparison.log"), result.output);
console.log(`paired streaming comparison: ${result.code === 0 ? "passed" : "failed"}`);
process.exitCode = result.code ?? 1;
