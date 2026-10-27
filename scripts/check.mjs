// Single entry point for "is this change sound?". Groups are addressable so the
// inner loop can run one slice instead of the whole workspace.
//
// Usage: node scripts/check.mjs [options]
//
//   (no options)      arch + selects + compile + core package suites + core renderer suites
//   --fast            arch + selects + compile only (no test run)
//   --all             run every package test file, not only scripts/core-suites.mjs
//   --production      also run the renderer / remote-host production build
//   --only <target>   run one group or one unit; a unit rebuilds its dependency
//                     closure first and then runs that unit's suites
//   --list            print groups and units
//
// Groups: arch, selects, types, packages, renderer, production
// Units:  studio-protocol, client, client-contract, studio-host, host-client-api,
//         transport-desktop, transport-web, runtime-installer, platform,
//         platform-win32, platform-darwin, testkit, desktop, renderer
//
// A failing step prints only the tail of its output. The full log stays in the
// terminal scrollback, which keeps a 20-line type error readable.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_NODE_SUITES, CORE_RENDERER_SUITES } from "./core-suites.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scope = "@omp-studio/";
const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");
const vitestBin = join(root, "node_modules", "vitest", "vitest.mjs");
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const tailLines = 40;
const concurrency = Math.max(1, Math.min(4, availableParallelism() - 1));

const units = readUnits();
const byKey = new Map(units.map(unit => [unit.key, unit]));

function readUnits() {
  const found = [];
  for (const parent of ["packages", "apps"]) {
    if (!existsSync(join(root, parent))) continue;
    for (const name of readdirSync(join(root, parent))) {
      const dir = `${parent}/${name}`;
      const manifest = join(root, dir, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (!pkg.name?.startsWith(scope)) continue;
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
        .filter(dep => dep.startsWith(scope))
        .map(dep => dep.slice(scope.length));
      found.push({ key: pkg.name.slice(scope.length), dir, deps });
    }
  }
  return found.sort((left, right) => left.key.localeCompare(right.key));
}

// Transitive internal dependencies, so `--only studio-host` does not need a full build.
function closure(keys) {
  const needed = new Set();
  const visit = key => {
    if (needed.has(key) || !byKey.has(key)) return;
    needed.add(key);
    for (const dep of byKey.get(key).deps) visit(dep);
  };
  for (const key of keys) visit(key);
  return needed;
}

// Dependency levels inside a subset. Packages on the same level have no edges
// between them, so they can compile in parallel; each level waits for the one above.
function levels(keys) {
  const pending = new Map([...keys].map(key => [key, new Set(byKey.get(key).deps.filter(dep => keys.has(dep)))]));
  const ordered = [];
  while (pending.size) {
    const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([key]) => key).sort();
    if (!ready.length) throw new Error(`dependency cycle between: ${[...pending.keys()].sort().join(", ")}`);
    ordered.push(ready);
    for (const key of ready) pending.delete(key);
    for (const deps of pending.values()) for (const key of ready) deps.delete(key);
  }
  return ordered;
}

function buildStep(key) {
  const unit = byKey.get(key);
  // The renderer config is a solution file (files: [], references), so it needs -b.
  const args = key === "renderer" ? ["-b", unit.dir] : ["-p", `${unit.dir}/tsconfig.json`];
  return { name: `build:${key}`, command: process.execPath, args: [tscBin, ...args] };
}

function suiteFiles(key, all) {
  const unit = byKey.get(key);
  if (key === "renderer") return CORE_RENDERER_SUITES;
  if (all) {
    const dir = join(root, unit.dir, "dist", "test");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(name => name.endsWith(".test.js"))
      .sort()
      .map(name => `${unit.dir}/dist/test/${name}`);
  }
  return CORE_NODE_SUITES.filter(suite => suite.startsWith(`${unit.dir}/`));
}

function testStep(key, all) {
  const unit = byKey.get(key);
  // Without file arguments Vitest runs the whole renderer suite, which is what
  // `--all` asks for; the default stays on the core list.
  if (key === "renderer") {
    return {
      name: "test:renderer",
      command: process.execPath,
      args: [vitestBin, "run", `--maxWorkers=${concurrency}`, ...(all ? [] : CORE_RENDERER_SUITES)],
      cwd: join(root, unit.dir),
    };
  }
  const files = suiteFiles(key, all);
  if (!files.length) return null;
  return { name: `test:${key}`, command: process.execPath, args: ["--test", `--test-concurrency=${concurrency}`, ...files] };
}

function runStep(step) {
  return new Promise(done => {
    const started = Date.now();
    const child = spawn(step.command, step.args, {
      cwd: step.cwd ?? root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let output = "";
    child.stdout.on("data", chunk => (output += chunk));
    child.stderr.on("data", chunk => (output += chunk));
    child.on("error", error => done({ ...step, ok: false, ms: Date.now() - started, output: `${output}${error}` }));
    child.on("close", code => done({ ...step, ok: code === 0, ms: Date.now() - started, output }));
  });
}

function report(result) {
  const seconds = `${(result.ms / 1000).toFixed(1)}s`;
  if (result.ok) {
    console.log(`✓ ${result.name.padEnd(28)} ${seconds}`);
    return;
  }
  console.log(`✗ ${result.name.padEnd(28)} ${seconds}`);
  const lines = result.output.trimEnd().split("\n").slice(-tailLines);
  for (const line of lines) console.log(`    ${line}`);
  if (process.env.GITHUB_ACTIONS) {
    const text = lines
      .join("\n")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.log(`::error title=check failed: ${result.name}::${text}`);
  }
}

async function pool(steps, failures) {
  const queue = [...steps];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const result = await runStep(queue.shift());
      report(result);
      if (!result.ok) failures.push(result.name);
    }
  });
  await Promise.all(workers);
}

function usage() {
  console.log(`Usage: node scripts/check.mjs [--fast] [--all] [--production] [--only <target>] [--list]

  (no options)   arch + selects + compile + core suites
  --fast         arch + selects + compile only
  --all          every package test file, not only the core list
  --production   also build the renderer bundle and the remote host bundle
  --only <x>     one group (arch, selects, types, packages, renderer, production)
                 or one unit (studio-host, client, renderer, ...)
  --list         print groups and units`);
}

function list() {
  console.log("groups:");
  for (const group of ["arch", "selects", "types", "packages", "renderer", "production"]) console.log(`  ${group}`);
  console.log("units:");
  for (const unit of units) {
    const suite = unit.key === "renderer" ? CORE_RENDERER_SUITES.length : suiteFiles(unit.key, false).length;
    console.log(`  ${unit.key.padEnd(20)} ${unit.dir.padEnd(28)} suites=${suite}`);
  }
}

const argv = process.argv.slice(2);
let only = null;
const flags = new Set();
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--only") only = argv[(index += 1)];
  else if (arg.startsWith("--only=")) only = arg.slice("--only=".length);
  else flags.add(arg);
}

if (flags.has("--help") || flags.has("-h")) {
  usage();
  process.exit(0);
}
if (flags.has("--list")) {
  list();
  process.exit(0);
}
if (argv.some(arg => arg === "--only" || arg.startsWith("--only=")) && !only) {
  console.error("--only needs a group or unit name");
  usage();
  process.exit(2);
}

const plan = { arch: false, selects: false, build: new Set(), test: new Set(), production: false };
const allUnits = () => units.map(unit => unit.key);

function useEverything() {
  plan.arch = true;
  plan.selects = true;
  for (const key of allUnits()) plan.build.add(key);
  for (const key of allUnits()) plan.test.add(key);
}

if (only) {
  if (byKey.has(only)) {
    for (const key of closure([only])) plan.build.add(key);
    plan.test.add(only);
  } else if (only === "arch") plan.arch = true;
  else if (only === "selects") plan.selects = true;
  else if (only === "types") for (const key of allUnits()) plan.build.add(key);
  else if (only === "packages") {
    for (const key of allUnits()) plan.build.add(key);
    for (const key of allUnits()) plan.test.add(key);
  } else if (only === "production") {
    for (const key of allUnits()) plan.build.add(key);
    plan.production = true;
  } else {
    console.error(`unknown target: ${only}`);
    usage();
    process.exit(2);
  }
} else if (flags.has("--fast")) {
  plan.arch = true;
  plan.selects = true;
  for (const key of allUnits()) plan.build.add(key);
} else {
  useEverything();
}
if (flags.has("--production")) plan.production = true;
// `--all` widens the suite list; with `--only <unit>` it widens only that unit.
if (flags.has("--all") && !only) plan.test = new Set(allUnits());

const failures = [];
const started = Date.now();

if (plan.arch) {
  const result = await runStep({
    name: "arch",
    command: process.execPath,
    args: ["--test", join(root, "scripts", "architecture.test.mjs")],
  });
  report(result);
  if (!result.ok) failures.push(result.name);
}

if (plan.selects) {
  const result = await runStep({
    name: "selects",
    command: process.execPath,
    args: [join(root, "scripts", "check-renderer-selects.mjs")],
  });
  report(result);
  if (!result.ok) failures.push(result.name);
}

let buildFailed = false;
if (plan.build.size) {
  // Compiling a level needs the previous level's declarations on disk. A failed
  // level stops the chain: every later level would only repeat the same error.
  for (const level of levels(closure(plan.build))) {
    const before = failures.length;
    await pool(
      level.map(key => buildStep(key)),
      failures,
    );
    if (failures.length > before) {
      buildFailed = true;
      break;
    }
  }
}

const suites = [];
for (const key of plan.test) {
  const step = testStep(key, flags.has("--all"));
  if (step) suites.push(step);
}
if (plan.renderer && !suites.some(step => step.name === "test:renderer")) {
  const step = testStep("renderer", false);
  if (step) suites.push(step);
}
if (suites.length && !buildFailed) await pool(suites, failures);

if (plan.production) {
  const steps = [
    { name: "bundle:renderer", command: process.execPath, args: [viteBin, "build"], cwd: join(root, "apps", "renderer") },
    {
      name: "bundle:remote-host",
      command: process.execPath,
      args: [join(root, "scripts", "bundle-remote-host.mjs")],
    },
  ];
  await pool(steps, failures);
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} step(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`all checks passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
