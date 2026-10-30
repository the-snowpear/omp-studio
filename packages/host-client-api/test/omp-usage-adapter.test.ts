import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { createOmpUsageService } from "../src/omp-usage-adapter.js";

const NOW = new Date(2026, 7, 14, 15, 0, 0).getTime();

async function withDb(
  seed: (insert: (timestamp: number, model: string, tokens: number) => void) => void,
  run: (dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omp-usage-"));
  const dbPath = join(dir, "stats.db");
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    await rm(dir, { recursive: true, force: true });
    throw new Error("node:sqlite is required for omp-usage-adapter tests");
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE messages (
        timestamp INTEGER NOT NULL,
        model TEXT NOT NULL,
        total_tokens INTEGER NOT NULL
      );
    `);
    const stmt = db.prepare("INSERT INTO messages (timestamp, model, total_tokens) VALUES (?, ?, ?)");
    seed((timestamp, model, tokens) => {
      stmt.run(timestamp, model, tokens);
    });
  } finally {
    db.close();
  }
  try {
    await run(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("createOmpUsageService", () => {
  test("returns a path-free empty model when omp and stats.db are missing", async () => {
    const service = createOmpUsageService({
      locateOmp: async () => undefined,
      statsDbPath: join(tmpdir(), "omp-usage-missing-stats.db"),
      now: () => NOW,
    });
    const model = await service.get();
    assert.equal(model.days.length, 0);
    assert.match(model.unavailableReason ?? "", /omp/i);
    assert.equal(JSON.stringify(model).includes("\\\\"), false);
  });

  test("aggregates daily totals, keeps the top 5 models, and buckets the rest as 其他", async () => {
    await withDb(
      (insert) => {
        insert(NOW, "alpha", 5000);
        insert(NOW, "beta", 4000);
        insert(NOW, "gamma", 3000);
        insert(NOW, "delta", 2000);
        insert(NOW, "epsilon", 1000);
        insert(NOW, "zeta", 100);
        insert(NOW - 3_600_000, "alpha", 250);
      },
      async (dbPath) => {
        let execCalls = 0;
        const service = createOmpUsageService({
          statsDbPath: dbPath,
          locateOmp: async () => "C:\\tools\\omp.exe",
          exec: async () => {
            execCalls += 1;
            return { stdout: "", stderr: "", code: 0 };
          },
          now: () => NOW,
        });
        const model = await service.get();
        assert.equal(execCalls, 1);
        assert.equal(model.unavailableReason, undefined);
        const today = "2026-08-14";
        const day = model.days.find((entry) => entry.date === today);
        assert.equal(day?.totalTokens, 5000 + 4000 + 3000 + 2000 + 1000 + 100 + 250);
        assert.deepEqual(
          model.models.map((entry) => entry.id),
          ["alpha", "beta", "gamma", "delta", "epsilon", "其他"],
        );
        const other = model.byModel.find((entry) => entry.date === today && entry.model === "其他");
        assert.equal(other?.tokens, 100);
        const hour15 = model.hours.find((entry) => entry.hour === 15 && entry.model === "alpha");
        const hour14 = model.hours.find((entry) => entry.hour === 14 && entry.model === "alpha");
        assert.equal(hour15?.tokens, 5000);
        assert.equal(hour14?.tokens, 250);
        const serialized = JSON.stringify(model);
        assert.equal(serialized.includes("session_file"), false);
        assert.equal(serialized.includes("folder"), false);
        assert.equal(serialized.includes(dbPath.replaceAll("\\", "\\\\")) || serialized.includes(dbPath), false);

        await service.get();
        assert.equal(execCalls, 1, "second get within the throttle window must not respawn omp");
      },
    );
  });

  test("openDashboard spawns hidden omp stats when the dashboard is not live", async () => {
    const spawned: Array<{ exe: string; options?: { readonly open?: boolean } }> = [];
    const opened: string[] = [];
    const service = createOmpUsageService({
      locateOmp: async () => "C:\\tools\\omp.exe",
      spawnDashboard: (exe, options) => {
        spawned.push({ exe, ...(options === undefined ? {} : { options }) });
      },
      openUrl: async (url) => {
        opened.push(url);
      },
      probeDashboard: async () => false,
      now: () => NOW,
    });
    const result = await service.openDashboard();
    assert.equal(result.applied, true);
    // The explicit browser request keeps `omp stats` opening one; only the
    // embedded dashboard start suppresses it.
    assert.deepEqual(spawned, [{ exe: "C:\\tools\\omp.exe", options: { open: true } }]);
    assert.deepEqual(opened, []);
    assert.equal(JSON.stringify(result).includes("C:\\\\tools"), false);
  });

  test("openDashboard reuses a live dashboard via openUrl and does not spawn", async () => {
    const spawned: string[] = [];
    const opened: string[] = [];
    const service = createOmpUsageService({
      locateOmp: async () => "C:\\tools\\omp.exe",
      spawnDashboard: (exe) => {
        spawned.push(exe);
      },
      openUrl: async (url) => {
        opened.push(url);
      },
      probeDashboard: async () => true,
      now: () => NOW,
    });
    const result = await service.openDashboard();
    assert.equal(result.applied, true);
    assert.match(result.message ?? "", /已在浏览器打开/);
    assert.deepEqual(spawned, []);
    assert.deepEqual(opened, ["http://127.0.0.1:3847/"]);
    assert.equal(JSON.stringify(result).includes("C:\\\\tools"), false);
  });

  test("dashboard reuses a live panel without spawning, and deep-links the all range", async () => {
    const spawned: Array<{ exe: string; options?: { readonly open?: boolean } }> = [];
    let probes = 0;
    const service = createOmpUsageService({
      locateOmp: async () => "C:\tools\omp.exe",
      spawnDashboard: (exe, options) => {
        spawned.push({ exe, ...(options === undefined ? {} : { options }) });
      },
      probeDashboard: async () => {
        probes += 1;
        return true;
      },
      now: () => NOW,
    });
    const result = await service.dashboard?.();
    assert.equal(result?.available, true);
    assert.equal(result?.url, "http://127.0.0.1:3847/#/overview?range=all");
    assert.equal(probes, 1);
    assert.deepEqual(spawned, [], "a live panel is reused, never respawned");
    assert.equal(JSON.stringify(result).includes("C:\\tools"), false, "no filesystem path leaks into the read model");
  });

  test("dashboard starts one panel for concurrent callers and caches the endpoint", async () => {
    const spawned: Array<{ exe: string; options?: { readonly open?: boolean } }> = [];
    let live = false;
    const service = createOmpUsageService({
      locateOmp: async () => "C:\tools\omp.exe",
      spawnDashboard: (exe, options) => {
        spawned.push({ exe, ...(options === undefined ? {} : { options }) });
        live = true;
      },
      probeDashboard: async () => live,
      delay: async () => undefined,
      now: (() => {
        let t = NOW;
        return () => (t += 10);
      })(),
      dashboardStartTimeoutMs: 5_000,
    });
    const [a, b] = await Promise.all([service.dashboard?.(), service.dashboard?.()]);
    assert.equal(a?.available, true);
    assert.equal(b?.available, true);
    // The embedded start must not also open the panel in the system browser.
    assert.deepEqual(spawned, [{ exe: "C:\tools\omp.exe" }], "two mounts must not race two servers onto one port");
    const cached = await service.dashboard?.();
    assert.equal(cached?.url, "http://127.0.0.1:3847/#/overview?range=all");
    assert.equal(spawned.length, 1, "a resolved endpoint is reused");
  });

  test("dashboard reports an honest reason when no Runtime can be located", async () => {
    const service = createOmpUsageService({
      locateOmp: async () => undefined,
      probeDashboard: async () => false,
      now: () => NOW,
    });
    const result = await service.dashboard?.();
    assert.equal(result?.available, false);
    assert.equal(result?.url, undefined);
    assert.match(result?.reason ?? "", /未找到 OMP Runtime/);
  });

  test("dashboard gives up after the startup deadline instead of hanging the page", async () => {
    let clock = NOW;
    const service = createOmpUsageService({
      locateOmp: async () => "C:\tools\omp.exe",
      spawnDashboard: () => undefined,
      probeDashboard: async () => false,
      delay: async () => {
        clock += 1_000;
      },
      now: () => clock,
      dashboardStartTimeoutMs: 3_000,
    });
    const result = await service.dashboard?.();
    assert.equal(result?.available, false);
    assert.match(result?.reason ?? "", /未在预期时间内就绪/);
  });

  test("dashboard stops claiming a running panel once the process is gone", async () => {
    let live = true;
    const spawned: Array<{ exe: string; options?: { readonly open?: boolean } }> = [];
    const service = createOmpUsageService({
      locateOmp: async () => "C:\tools\omp.exe",
      spawnDashboard: (exe, options) => {
        spawned.push({ exe, ...(options === undefined ? {} : { options }) });
      },
      probeDashboard: async () => live,
      delay: async () => undefined,
      now: (() => {
        let t = NOW;
        return () => (t += 10);
      })(),
      dashboardStartTimeoutMs: 1_000,
    });
    const first = await service.dashboard?.();
    assert.equal(first?.available, true);
    live = false;
    const second = await service.dashboard?.();
    assert.equal(second?.available, false, "a cached URL must not report a dead panel as running");
    assert.match(second?.reason ?? "", /未在预期时间内就绪/);
    assert.equal(spawned.length, 1, "the first call reused a live panel; only the retry spawns");
  });

  test("the sync throttle answers without probing for the omp entrypoint", async () => {
    let locates = 0;
    let execs = 0;
    let clock = NOW;
    const service = createOmpUsageService({
      locateOmp: async () => {
        locates += 1;
        return "C:\tools\omp.exe";
      },
      exec: async () => {
        execs += 1;
        return { stdout: "", stderr: "", code: 0 };
      },
      statsDbPath: join(tmpdir(), "omp-usage-throttle-stats.db"),
      now: () => clock,
      syncThrottleMs: 30_000,
    });
    await service.get();
    assert.deepEqual({ locates, execs }, { locates: 1, execs: 1 });
    await service.get();
    assert.deepEqual({ locates, execs }, { locates: 1, execs: 1 }, "inside the window nothing is probed or spawned");
    clock += 30_001;
    await service.get();
    assert.deepEqual({ locates, execs }, { locates: 2, execs: 2 });
  });

  test("a missing omp still reports the exe-classified sync error after the reorder", async () => {
    const service = createOmpUsageService({
      locateOmp: async () => undefined,
      statsDbPath: join(tmpdir(), "omp-usage-missing-stats.db"),
      now: () => NOW,
    });
    const model = await service.get();
    assert.match(model.unavailableReason ?? "", /安装 OMP 或将其加入 PATH/);
  });

  test("concurrent get() calls stay single-flight and share one locator", async () => {
    let locates = 0;
    let execs = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = createOmpUsageService({
      locateOmp: async () => {
        locates += 1;
        return "C:\tools\omp.exe";
      },
      exec: async () => {
        execs += 1;
        await gate;
        return { stdout: "", stderr: "", code: 0 };
      },
      statsDbPath: join(tmpdir(), "omp-usage-missing-stats.db"),
      now: () => NOW,
    });
    const first = service.get();
    await Promise.resolve();
    const second = service.get();
    release();
    await Promise.all([first, second]);
    assert.equal(execs, 1, "one omp stats spawn for overlapping polls");
    assert.equal(locates, 1, "the in-flight poll answers without another Runtime lookup");
  });
});
