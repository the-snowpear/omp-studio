import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
if (!beforePath || !afterPath || !outputPath) throw new Error("Usage: node scripts/compare-streaming-perf.mjs before.json after.json comparison.json");
const before = JSON.parse(await readFile(beforePath, "utf8"));
const after = JSON.parse(await readFile(afterPath, "utf8"));
for (const field of ["buildMode", "node", "chromium", "trace", "cpuCount", "runs"]) {
  if (before.identity[field] !== after.identity[field]) throw new Error(`incomparable identity field: ${field}`);
}
const comparisons = after.scenarios.flatMap((scenario) => {
  const original = before.scenarios.find((value) => value.name === scenario.name);
  if (!original) throw new Error(`missing baseline: ${scenario.name}`);
  return ["scriptMsPerFrame", "layoutMsPerFrame", "scriptTaskP95Ms", "layoutTaskP95Ms"].map((metric) => {
    const baseline = original[metric], measured = scenario[metric];
    if (typeof baseline !== "number" || typeof measured !== "number") throw new Error(`missing measurement: ${scenario.name}.${metric}`);
    const limit = baseline < 1 ? baseline + 1 : baseline * 1.1;
    return { scenario: scenario.name, metric, before: baseline, after: measured, limit, passed: measured <= limit };
  });
});
const report = { beforePath, afterPath, beforeIdentity: before.identity, afterIdentity: after.identity, comparisons,
  passed: before.status === "passed" && after.status === "passed" && comparisons.every((entry) => entry.passed) };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
