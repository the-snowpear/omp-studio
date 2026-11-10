/** Compare two already built workbench harnesses in alternating A/B, B/A order. */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [beforeArg, afterArg, outputArg] = process.argv.slice(2);
if (!beforeArg || !afterArg || !outputArg) throw new Error("Expected before build, after build, output directory");
const builds = { before: resolve(beforeArg), after: resolve(afterArg) };
const output = resolve(outputArg);
await mkdir(output, { recursive: true });
const samples = { before: [], after: [] };
const sequence = [];
for (let pair = 0; pair < 5; pair++) {
  for (const side of pair % 2 ? ["after", "before"] : ["before", "after"]) {
    const name = `${pair + 1}-${side}`, report = join(output, name + ".json");
    const log = createWriteStream(join(output, name + ".log"));
    await new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, ["scripts/startup-perf.mjs"], {
        env: { ...process.env, PERF_SKIP_BUILD: "1", PERF_RUNS: "1", PERF_OUTPUT: builds[side], PERF_REPORT: report },
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      child.once("error", error => { log.end(); reject(error); });
      child.once("exit", code => { log.end(); code === 0 ? resolveRun() : reject(new Error(`${name} failed (${code}); inspect its log`)); });
    });
    const result = JSON.parse(await readFile(report, "utf8"));
    if (!result.passed) throw new Error(`${name}: failed workbench behavior`);
    samples[side].push(result.samples[0]);
    sequence.push({ pair: pair + 1, side, report, identity: result.identity });
    console.log(JSON.stringify({ pair: pair + 1, side, ...result.median }));
  }
}
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const metrics = Object.fromEntries(["launchToShellMs", "readyMs", "scriptMs", "layoutMs", "heapBytes", "p95Ms"].map(key => {
  const before = median(samples.before.map(row => row[key])), after = median(samples.after.map(row => row[key]));
  return [key, { before, after, percentChange: before ? (after / before - 1) * 100 : null }];
}));
const result = { builds, sequence, samples, metrics, limitations: ["Synthetic complete workbench; not actual Host/Runtime startup.", "Five samples per build, warmed OS cache; retain all measurements and do not infer a population p95."] };
await writeFile(join(output, "comparison.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(metrics, null, 2));
