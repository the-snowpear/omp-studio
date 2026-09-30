import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";

import { macSwapHelperSource, macSwapMarkers, macSwapPaths, nodeMacSwapDeps, runMacAppSwap, type MacSwapDeps, type MacSwapOutcome, type MacSwapPlan } from "../src/mac-app-swap.js";

// Every scenario runs the helper from its own source text, as the detached helper does:
// a reference to anything outside the function fails here, not on a user's Mac.
const swapFromSource = new Function(`return (${runMacAppSwap.toString()});`)() as typeof runMacAppSwap;

const PLAN: MacSwapPlan = {
  schema: 1,
  pid: 100,
  target: "/Applications/OMP Studio.app",
  staged: "/Applications/.OMP Studio.update-abc/OMP Studio.app",
  stagingRoot: "/Applications/.OMP Studio.update-abc",
  backup: "/Applications/.OMP Studio.previous-abc",
  version: "2.0.0",
  markers: { started: "/swap/started", healthy: "/swap/healthy", cleanExit: "/swap/clean-exit" },
  outcome: "/swap/outcome.json",
  waitForExitMs: 5_000,
  startTimeoutMs: 10_000,
  monitorMs: 60_000,
  pollMs: 500,
};

interface World {
  now: number;
  alive: Set<number>;
  nodes: Map<string, string>;
  opened: string[];
  renames: string[];
  log: string[];
}

/** An in-memory folder tree, process table and clock driven by `onTick`. */
function world(options: { onTick?: (w: World) => void; renameError?: (from: string, to: string) => NodeJS.ErrnoException | undefined } = {}) {
  const w: World = {
    now: 0,
    alive: new Set<number>([PLAN.pid]),
    nodes: new Map<string, string>([
      [PLAN.target, "old"],
      [`${PLAN.target}/Contents/MacOS/OMP Studio`, "old-exe"],
      [PLAN.stagingRoot, "dir"],
      [PLAN.staged, "new"],
      [`${PLAN.staged}/Contents/MacOS/OMP Studio`, "new-exe"],
    ]),
    opened: [] as string[],
    renames: [] as string[],
    log: [] as string[],
  };
  const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const deps: MacSwapDeps = {
    exists: (path) => w.nodes.has(path),
    rename: (from, to) => {
      const injected = options.renameError?.(from, to);
      if (injected) throw injected;
      if (!w.nodes.has(from)) throw Object.assign(new Error(`ENOENT ${from}`), { code: "ENOENT" });
      if (w.nodes.has(to)) throw Object.assign(new Error(`EEXIST ${to}`), { code: "EEXIST" });
      for (const [path, value] of [...w.nodes]) {
        if (!within(path, from)) continue;
        w.nodes.delete(path);
        w.nodes.set(to + path.slice(from.length), value);
      }
      w.renames.push(`${from} -> ${to}`);
    },
    remove: (path) => { for (const key of [...w.nodes.keys()]) if (within(key, path)) w.nodes.delete(key); },
    readText: (path) => w.nodes.get(path),
    writeText: (path, text) => { w.nodes.set(path, text); },
    isAlive: (pid) => w.alive.has(pid),
    sleep: async (ms) => { w.now += ms; options.onTick?.(w); },
    now: () => w.now,
    open: (app) => { w.opened.push(`${app}:${w.nodes.get(app)}`); options.onTick?.(w); },
    log: (line) => { w.log.push(line); },
  };
  return { w, deps };
}

function outcomeOf(w: World): MacSwapOutcome {
  return JSON.parse(w.nodes.get(PLAN.outcome)!) as MacSwapOutcome;
}

/** The old app quits at t=1000; the new one writes `started` 300 ms after launch. */
function launches(then: (w: World, sinceStart: number) => void) {
  let launchedAt: number | undefined;
  return (w: World) => {
    if (w.now >= 1_000) w.alive.delete(PLAN.pid);
    if (launchedAt === undefined && w.opened.length === 1) launchedAt = w.now;
    if (launchedAt !== undefined) then(w, w.now - launchedAt);
  };
}

test("the new version is installed once it reports healthy, and the backup goes away", async () => {
  const { w, deps } = world({
    onTick: launches((world, since) => {
      if (since >= 300 && !world.nodes.has(PLAN.markers.started)) { world.nodes.set(PLAN.markers.started, "200"); world.alive.add(200); }
      if (since >= 3_000) world.nodes.set(PLAN.markers.healthy, "t");
    }),
  });
  const outcome = await swapFromSource(PLAN, deps);
  assert.deepEqual(outcome, { status: "installed", version: "2.0.0" });
  assert.equal(w.nodes.get(PLAN.target), "new");
  assert.equal(w.nodes.has(PLAN.backup), false);
  assert.equal(w.nodes.has(PLAN.stagingRoot), false);
  assert.deepEqual(w.renames, [`${PLAN.target} -> ${PLAN.backup}`, `${PLAN.staged} -> ${PLAN.target}`]);
  assert.deepEqual(w.opened, [`${PLAN.target}:new`]);
  assert.deepEqual(outcomeOf(w), outcome);
});

test("a version that never starts is swapped back and the previous one reopened", async () => {
  const { w, deps } = world({ onTick: launches(() => undefined) });
  const outcome = await swapFromSource(PLAN, deps);
  assert.equal(outcome.status, "rolled-back");
  assert.match(outcome.message ?? "", /没有启动/u);
  assert.equal(w.nodes.get(PLAN.target), "old");
  assert.equal(w.nodes.has(PLAN.backup), false);
  assert.equal(w.nodes.has(`${PLAN.backup}.failed`), false);
  assert.deepEqual(w.opened, [`${PLAN.target}:new`, `${PLAN.target}:old`]);
});

test("a started version whose process ends without healthy or clean-exit is swapped back", async () => {
  const { w, deps } = world({
    onTick: launches((world, since) => {
      if (since >= 300 && since < 2_000 && !world.nodes.has(PLAN.markers.started)) { world.nodes.set(PLAN.markers.started, "200"); world.alive.add(200); }
      if (since >= 2_000) world.alive.delete(200);
    }),
  });
  const outcome = await swapFromSource(PLAN, deps);
  assert.equal(outcome.status, "rolled-back");
  assert.match(outcome.message ?? "", /异常退出/u);
  assert.equal(w.nodes.get(PLAN.target), "old");
});

test("quitting a started version before it turns healthy is not a failure", async () => {
  const { w, deps } = world({
    onTick: launches((world, since) => {
      if (since >= 300 && since < 2_000 && !world.nodes.has(PLAN.markers.started)) { world.nodes.set(PLAN.markers.started, "200"); world.alive.add(200); }
      if (since >= 2_000) { world.nodes.set(PLAN.markers.cleanExit, "t"); world.alive.delete(200); }
    }),
  });
  const outcome = await swapFromSource(PLAN, deps);
  assert.equal(outcome.status, "unconfirmed");
  assert.equal(w.nodes.get(PLAN.target), "new");
  assert.equal(w.nodes.get(PLAN.backup), "old", "kept until the next confirmed start cleans it up");
  assert.deepEqual(w.opened, [`${PLAN.target}:new`]);
});

test("an unreadable started marker never triggers a rollback on its own", async () => {
  const { w, deps } = world({
    onTick: launches((world, since) => {
      if (since >= 300) world.nodes.set(PLAN.markers.started, "not-a-pid");
    }),
  });
  const outcome = await swapFromSource({ ...PLAN, monitorMs: 20_000 }, deps);
  assert.equal(outcome.status, "unconfirmed");
  assert.equal(w.nodes.get(PLAN.target), "new");
});

test("an app that never quits cancels the swap without touching the bundle", async () => {
  const { w, deps } = world();
  const outcome = await swapFromSource(PLAN, deps);
  assert.equal(outcome.status, "failed");
  assert.match(outcome.message ?? "", /没有退出/u);
  assert.equal(w.nodes.get(PLAN.target), "old");
  assert.equal(w.nodes.has(PLAN.stagingRoot), false);
  assert.deepEqual(w.renames, []);
  assert.deepEqual(w.opened, []);
});

test("App Management refusing the first rename leaves the old app in place and reopens it", async () => {
  const { w, deps } = world({
    onTick: (world) => { if (world.now >= 1_000) world.alive.delete(PLAN.pid); },
    renameError: (from) => (from === PLAN.target ? Object.assign(new Error("Operation not permitted"), { code: "EPERM" }) : undefined),
  });
  const outcome = await swapFromSource(PLAN, deps);
  assert.equal(outcome.status, "failed");
  assert.match(outcome.message ?? "", /App 管理/u);
  assert.match(outcome.message ?? "", /dmg/u);
  assert.equal(w.nodes.get(PLAN.target), "old");
  assert.equal(w.nodes.has(PLAN.stagingRoot), false);
  assert.deepEqual(w.opened, [`${PLAN.target}:old`]);
});

test("a failed second rename restores the old bundle before reopening it", async () => {
  const { w, deps } = world({
    onTick: (world) => { if (world.now >= 1_000) world.alive.delete(PLAN.pid); },
    renameError: (from) => (from === PLAN.staged ? Object.assign(new Error("I/O error"), { code: "EIO" }) : undefined),
  });
  const outcome = await swapFromSource(PLAN, deps);
  assert.equal(outcome.status, "failed");
  assert.equal(w.nodes.get(PLAN.target), "old");
  assert.equal(w.nodes.has(PLAN.backup), false);
  assert.deepEqual(w.opened, [`${PLAN.target}:old`]);
});

test("a plan whose paths are not siblings of the bundle is refused", async () => {
  const { w, deps } = world({ onTick: (world) => { world.alive.delete(PLAN.pid); } });
  const outcome = await swapFromSource({ ...PLAN, backup: "/tmp/elsewhere" }, deps);
  assert.equal(outcome.status, "failed");
  assert.deepEqual(w.renames, []);
});

test("the outcome is written before the previous version is reopened", async () => {
  let outcomeAtOpen: string | undefined;
  const { deps } = world({ onTick: launches(() => undefined) });
  const open = deps.open;
  deps.open = (app) => { if (outcomeAtOpen === undefined && app === PLAN.target && deps.readText(PLAN.outcome) !== undefined) outcomeAtOpen = deps.readText(PLAN.outcome); open(app); };
  await swapFromSource(PLAN, deps);
  assert.match(outcomeAtOpen ?? "", /rolled-back/u);
});

test("the helper script compiles and its real dependencies work on disk", async () => {
  assert.doesNotThrow(() => new Script(macSwapHelperSource(), { filename: "helper.cjs" }));
  const depsFromSource = new Function(`return (${nodeMacSwapDeps.toString()});`)() as typeof nodeMacSwapDeps;
  const root = await mkdtemp(join(tmpdir(), "omp-mac-swap-deps-"));
  const deps = depsFromSource(createRequire(import.meta.url), join(root, "helper.log"));
  await mkdir(join(root, "a", "b"), { recursive: true });
  deps.writeText(join(root, "a", "b", "file"), "x");
  assert.equal(deps.readText(join(root, "a", "b", "file")), "x");
  deps.rename(join(root, "a"), join(root, "c"));
  assert.equal(deps.exists(join(root, "c", "b", "file")), true);
  deps.remove(join(root, "c"));
  assert.equal(deps.exists(join(root, "c")), false);
  assert.equal(deps.readText(join(root, "missing")), undefined);
  assert.equal(deps.isAlive(process.pid), true);
  deps.log("hello");
  assert.match(await readFile(join(root, "helper.log"), "utf8"), /hello/u);
});

test("markers are written only for a pending swap of this version and this bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-mac-swap-markers-"));
  const paths = macSwapPaths(directory);
  const plan = { ...PLAN, markers: { started: paths.started, healthy: paths.healthy, cleanExit: paths.cleanExit }, outcome: paths.outcome };
  const markers = macSwapMarkers(directory, { version: "2.0.0", bundlePath: PLAN.target });
  assert.equal(markers.started(1), false, "no plan");
  await writeFile(paths.plan, JSON.stringify(plan));
  assert.equal(macSwapMarkers(directory, { version: "1.0.0", bundlePath: PLAN.target }).started(1), false, "other version");
  assert.equal(macSwapMarkers(directory, { version: "2.0.0", bundlePath: "/Users/me/OMP Studio.app" }).started(1), false, "other bundle");
  assert.equal(markers.started(4242), true);
  assert.equal(await readFile(paths.started, "utf8"), "4242");
  assert.equal(markers.healthy(), true);
  assert.equal(markers.cleanExit(), true);
});
