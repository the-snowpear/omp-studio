import assert from "node:assert/strict";
import { test } from "node:test";
import { runLinuxDebSwap, type LinuxDebSwapDeps, type LinuxDebSwapPlan } from "../src/linux-deb-swap.js";

const plan: LinuxDebSwapPlan = { pid: 10, target: "/opt/OMP Studio/omp-studio", launchArguments: ["--user-data-dir=/home/user/Studio data", "--omp-restarted"], version: "2.0.0", helper: "/helper", packagePath: "/new", catalogPath: "/new.json", previousPath: "/old", previousCatalogPath: "/old.json", ready: "/ready", outcome: "/outcome", started: "/started", healthy: "/healthy", cleanExit: "/clean", control: "/control", pollMs: 10, exitTimeoutMs: 40, startTimeoutMs: 60 };

function fixture(scenario: "healthy" | "crash" | "clean" | "install-failure" | "denied" | "cancelled" | "alive-parent") {
  const events: string[] = [];
  let time = 0, launched = false;
  const deps: LinuxDebSwapDeps = {
    authorize: async () => { events.push("authorize"); if (scenario === "denied") throw new Error("cancelled"); },
    install: async () => { events.push("install"); if (scenario === "install-failure") throw new Error("apt failed; restored"); },
    finish: async action => { events.push(action); },
    signalReady: status => { events.push(`ready:${status}`); },
    outcome: status => { events.push(`outcome:${status}`); },
    exists: path => path === plan.control ? scenario !== "cancelled" : launched && ((path === plan.healthy && scenario === "healthy") || (path === plan.cleanExit && scenario === "clean")),
    read: () => undefined,
    alive: pid => pid === plan.pid ? scenario === "alive-parent" : scenario !== "crash",
    launch: () => { launched = true; events.push("launch"); return 20; },
    sleep: async ms => { time += ms; },
    now: () => time,
  };
  return { deps, events };
}

for (const [scenario, expected] of [
  ["healthy", ["authorize", "ready:ready", "install", "launch", "commit", "outcome:installed"]],
  ["crash", ["authorize", "ready:ready", "install", "launch", "rollback", "outcome:rolled-back", "launch"]],
  ["clean", ["authorize", "ready:ready", "install", "launch", "commit", "outcome:unconfirmed"]],
  ["install-failure", ["authorize", "ready:ready", "install", "outcome:failed", "launch"]],
  ["denied", ["authorize", "ready:failed"]],
  ["cancelled", ["authorize", "cancel"]],
  ["alive-parent", ["authorize", "ready:ready", "cancel", "outcome:failed"]],
] as const) test(`deb update handles ${scenario}`, async () => {
  const { deps, events } = fixture(scenario);
  await runLinuxDebSwap(plan, deps);
  assert.deepEqual(events, expected);
});
