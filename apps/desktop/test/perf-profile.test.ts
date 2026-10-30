/**
 * P0-6 GPU / low-spec grading tests.
 *
 * No GPU is started: the grader is a pure function over injected facts, so the
 * hardware/software/low-spec/battery matrix runs headless. `getGPUFeatureStatus`
 * parsing is exercised with stub payloads copied from the shapes Chromium
 * reports (`enabled`, `unavailable_software`, `disabled`), and the
 * `getGPUInfo("complete")` renderer string is the documented fallback.
 *
 * Everything here is Electron-free: `perf-profile*.ts` take their Electron
 * seams as injected deps.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  PERF_LOW_SPEC_CORES,
  PERF_LOW_SPEC_MEMORY_BYTES,
  PerfProfileService,
  createPerfProfileSnapshot,
  detectSoftwareCompositing,
  formatPerfProfileDetail,
  gradePerfProfile,
  needsGpuInfoFallback,
  type PerfProfileProbeDeps,
} from "../src/perf-profile.js";
import {
  PERF_PROFILE_CHANNELS,
  createPerfProfileApi,
  parsePerfProfileSnapshot,
  type PerfProfileSnapshot,
} from "../src/perf-profile-shared.js";
import { registerPerfProfileIpc, type PerfProfileIpcEvent } from "../src/perf-profile-ipc.js";

const GiB = 1024 ** 3;

/** Chromium's shape for a machine compositing on the GPU. */
const HARDWARE_STATUS = Object.freeze({
  gpu_compositing: "enabled",
  "2d_canvas": "enabled",
  rasterization: "enabled",
  webgl: "enabled",
  video_decode: "enabled",
}) as Readonly<Record<string, string>>;

/** Chromium's shape when it fell back to the software rasterizer. */
const SOFTWARE_STATUS = Object.freeze({
  gpu_compositing: "unavailable_software",
  "2d_canvas": "unavailable_software",
  rasterization: "unavailable_software",
  webgl: "unavailable_software",
}) as Readonly<Record<string, string>>;

function probeInput(overrides: Partial<Parameters<typeof gradePerfProfile>[0]> = {}) {
  return {
    gpuFeatureStatus: HARDWARE_STATUS,
    cores: 8,
    totalMemoryBytes: 16 * GiB,
    onBattery: false,
    ...overrides,
  };
}

describe("perf grading: L0–L3 matrix", () => {
  test("hardware compositing, healthy machine, on AC power is L0 with full motion", () => {
    const grading = gradePerfProfile(probeInput());
    assert.equal(grading.tier, "L0");
    assert.equal(grading.motion, "full");
    assert.equal(grading.softwareCompositing, false);
    assert.deepEqual(grading.reasons, ["gpu=hardware"]);
  });

  test("hardware compositing on battery is L1 (reduce continuous animation)", () => {
    const grading = gradePerfProfile(probeInput({ onBattery: true }));
    assert.equal(grading.tier, "L1");
    assert.equal(grading.motion, "reduced");
    assert.ok(grading.reasons.includes("power=battery"));
  });

  test("software compositing is L2, with the feature value as evidence", () => {
    const grading = gradePerfProfile(probeInput({ gpuFeatureStatus: SOFTWARE_STATUS }));
    assert.equal(grading.tier, "L2");
    assert.equal(grading.motion, "reduced");
    assert.equal(grading.softwareCompositing, true);
    assert.ok(grading.reasons.includes("gpu_compositing=unavailable_software"));
    assert.ok(grading.reasons.includes("2d_canvas=unavailable_software"));
  });

  test("a low-core machine is L3 and reduces motion outright", () => {
    const grading = gradePerfProfile(probeInput({ cores: PERF_LOW_SPEC_CORES }));
    assert.equal(grading.tier, "L3");
    assert.equal(grading.motion, "off");
    assert.ok(grading.reasons.includes(`cores=${PERF_LOW_SPEC_CORES}<=${PERF_LOW_SPEC_CORES}`));
    // 1 core is low spec too; 3 cores is not.
    assert.equal(gradePerfProfile(probeInput({ cores: 1 })).tier, "L3");
    assert.equal(gradePerfProfile(probeInput({ cores: 3 })).tier, "L0");
  });

  test("low memory is L3 even with plenty of cores", () => {
    const grading = gradePerfProfile(probeInput({ totalMemoryBytes: PERF_LOW_SPEC_MEMORY_BYTES }));
    assert.equal(grading.tier, "L3");
    assert.equal(grading.motion, "off");
    assert.ok(grading.reasons.some((reason) => reason.startsWith("memory=4.0GiB<=")));
    assert.equal(gradePerfProfile(probeInput({ totalMemoryBytes: PERF_LOW_SPEC_MEMORY_BYTES + GiB })).tier, "L0");
  });

  test("precedence is L3 > L2 > L1: low spec wins over software and battery", () => {
    const grading = gradePerfProfile(
      probeInput({ gpuFeatureStatus: SOFTWARE_STATUS, cores: 2, onBattery: true }),
    );
    assert.equal(grading.tier, "L3");
    assert.equal(grading.motion, "off");
    // Both the GPU evidence and the power state stay in the diagnostic line.
    assert.ok(grading.reasons.includes("power=battery"));
    assert.ok(grading.reasons.includes("gpu_compositing=unavailable_software"));
  });
});

describe("perf grading: GPU feature-status parsing", () => {
  test("a *_software suffix on any composite feature proves the software path", () => {
    for (const feature of ["gpu_compositing", "2d_canvas", "rasterization", "webgl"]) {
      const status = { ...HARDWARE_STATUS, [feature]: "unavailable_software" };
      const detected = detectSoftwareCompositing(status);
      assert.equal(detected.software, true, `${feature}=unavailable_software`);
      assert.ok(detected.reasons.some((reason) => reason.startsWith(`${feature}=`)));
    }
  });

  test("plain 'software' and mixed-case values are recognised", () => {
    assert.equal(detectSoftwareCompositing({ gpu_compositing: "software" }).software, true);
    assert.equal(detectSoftwareCompositing({ "2d_canvas": "Unavailable_Software" }).software, true);
    assert.equal(detectSoftwareCompositing({}).software, false);
    assert.equal(detectSoftwareCompositing(undefined).software, false);
  });

  test("the glRenderer fallback recognises SwiftShader, llvmpipe, WARP and Basic Render", () => {
    for (const renderer of [
      "Google SwiftShader",
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      "llvmpipe (LLVM 15.0.6, 256 bits)",
      "Microsoft Basic Render Driver",
      "NVIDIA WARP",
    ]) {
      assert.equal(detectSoftwareCompositing({}, renderer).software, true, renderer);
    }
    for (const renderer of [
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)",
    ]) {
      assert.equal(detectSoftwareCompositing(HARDWARE_STATUS, renderer).software, false, renderer);
    }
  });

  test("the expensive getGPUInfo(complete) call is skipped when the status already decides", () => {
    assert.equal(needsGpuInfoFallback(HARDWARE_STATUS), false, "hardware is conclusive");
    assert.equal(needsGpuInfoFallback(SOFTWARE_STATUS), false, "software is conclusive");
    assert.equal(needsGpuInfoFallback({}), true, "no signal: ask for the renderer string");
    assert.equal(needsGpuInfoFallback(undefined), true);
    assert.equal(needsGpuInfoFallback({ gpu_compositing: "disabled", "2d_canvas": "enabled" }), true);
    assert.equal(needsGpuInfoFallback({ gpu_compositing: "enabled" }), true, "2d_canvas missing");
  });
});

describe("perf snapshot: wire shape", () => {
  test("carries the raw facts and the grading evidence", () => {
    const snapshot = createPerfProfileSnapshot(
      probeInput({ gpuFeatureStatus: SOFTWARE_STATUS, glRenderer: "Google SwiftShader", onBattery: true }),
      { probedAt: new Date("2026-10-30T00:00:00.000Z"), source: "probe" },
    );
    assert.deepEqual(snapshot, {
      tier: "L2",
      motion: "reduced",
      softwareCompositing: true,
      gpuCompositing: "unavailable_software",
      canvas2d: "unavailable_software",
      glRenderer: "Google SwiftShader",
      cores: 8,
      totalMemoryBytes: 16 * GiB,
      onBattery: true,
      reasons: [
        "gpu_compositing=unavailable_software",
        "2d_canvas=unavailable_software",
        "rasterization=unavailable_software",
        "webgl=unavailable_software",
        "glRenderer=Google SwiftShader",
        "power=battery",
      ],
      probedAt: "2026-10-30T00:00:00.000Z",
      source: "probe",
    });
    assert.match(formatPerfProfileDetail(snapshot), /tier=L2 motion=reduced software=true/u);
  });

  test("the snapshot guard rejects malformed payloads whole", () => {
    const good = createPerfProfileSnapshot(probeInput(), {
      probedAt: new Date("2026-10-30T00:00:00.000Z"),
      source: "probe",
    });
    assert.deepEqual(parsePerfProfileSnapshot(good), good);
    assert.equal(parsePerfProfileSnapshot(null), undefined);
    assert.equal(parsePerfProfileSnapshot("L2"), undefined);
    assert.equal(parsePerfProfileSnapshot({ ...good, tier: "L9" }), undefined);
    assert.equal(parsePerfProfileSnapshot({ ...good, motion: "none" }), undefined);
    assert.equal(parsePerfProfileSnapshot({ ...good, cores: -1 }), undefined);
    assert.equal(parsePerfProfileSnapshot({ ...good, probedAt: "yesterday" }), undefined);
    assert.equal(parsePerfProfileSnapshot({ ...good, reasons: ["x".repeat(500)] }), undefined);
    assert.equal(parsePerfProfileSnapshot({ ...good, extra: true }), undefined);
    assert.equal(parsePerfProfileSnapshot({ ...good, glRenderer: 42 }), undefined);
  });
});

// ---- Service -------------------------------------------------------------

interface Fakes {
  readonly deps: PerfProfileProbeDeps;
  readonly written: PerfProfileSnapshot[];
  readonly logged: string[];
  readonly changed: PerfProfileSnapshot[];
  readonly calls: string[];
}

function makeDeps(options: { cache?: unknown; gpu?: Readonly<Record<string, string>>; renderer?: string; settled?: () => boolean } = {}): Fakes {
  const written: PerfProfileSnapshot[] = [];
  const logged: string[] = [];
  const changed: PerfProfileSnapshot[] = [];
  const calls: string[] = [];
  const deps: PerfProfileProbeDeps = {
    getGPUFeatureStatus() {
      calls.push("gpu-status");
      if (options.gpu === undefined) throw new Error("gpu service not ready");
      return options.gpu;
    },
    async getGLRenderer() {
      calls.push("gl-renderer");
      return options.renderer;
    },
    cores: () => 8,
    totalMemoryBytes: () => 16 * GiB,
    onBattery: () => false,
    now: () => new Date("2026-10-30T00:00:00.000Z"),
    readCache: async () => {
      calls.push("read-cache");
      if (options.cache instanceof Error) throw options.cache;
      return options.cache;
    },
    async writeCache(snapshot) {
      calls.push("write-cache");
      written.push(snapshot);
    },
    log(level, event, detail) {
      logged.push(`${level} ${event} ${detail}`);
    },
    onChanged(snapshot) {
      changed.push(snapshot);
    },
    ...(options.settled === undefined ? {} : { gpuStatusSettled: options.settled }),
  };
  return { deps, written, logged, changed, calls };
}

function cachedSnapshot(): PerfProfileSnapshot {
  return createPerfProfileSnapshot(probeInput({ gpuFeatureStatus: SOFTWARE_STATUS }), {
    probedAt: new Date("2026-10-29T00:00:00.000Z"),
    source: "cache",
  });
}

describe("PerfProfileService", () => {
  test("loads the cached snapshot before the first probe, so first paint has a tier", async () => {
    const fakes = makeDeps({ cache: cachedSnapshot() });
    const service = new PerfProfileService(fakes.deps);
    assert.equal(service.current(), undefined);
    const loaded = await service.load();
    assert.equal(loaded?.tier, "L2");
    assert.equal(loaded?.source, "cache");
    assert.equal(service.current()?.tier, "L2", "available synchronously to the cached channel");
    assert.ok(fakes.logged.some((line) => line.includes("cache")));
  });

  test("an unsettled GPU status is treated as unknown, never cached or broadcast", async () => {
    // Chromium reports `disabled_software` before the GPU process is up, even
    // on a hardware-compositing machine. Grading that transient verdict would
    // persist L2 for the next launch and make effects pop out on a machine
    // that does not need it.
    const fakes = makeDeps({ gpu: SOFTWARE_STATUS, settled: () => false });
    const service = new PerfProfileService(fakes.deps);
    const snapshot = await service.refresh();
    assert.equal(snapshot.tier, "L0", "an unknown GPU status grades optimistically");
    assert.equal(snapshot.softwareCompositing, false);
    assert.deepEqual(fakes.written, [], "a provisional probe is never the next first-paint tier");
    assert.deepEqual(fakes.changed, [], "a provisional probe is not pushed to windows");
    assert.ok(fakes.logged.some((line) => line.includes("gpu_status=pending")));
    assert.equal(service.current()?.tier, "L0", "probe() still answers with the provisional snapshot");
  });

  test("the settled probe replaces the provisional one and is cached", async () => {
    let settled = false;
    const fakes = makeDeps({ gpu: SOFTWARE_STATUS, settled: () => settled });
    const service = new PerfProfileService(fakes.deps);
    assert.equal((await service.refresh()).tier, "L0");
    settled = true;
    const graded = await service.refresh();
    assert.equal(graded.tier, "L2");
    assert.equal(graded.softwareCompositing, true);
    assert.deepEqual(fakes.written.map((item) => item.tier), ["L2"]);
    assert.deepEqual(fakes.changed.map((item) => item.tier), ["L2"]);
    assert.equal(service.current()?.tier, "L2");
  });

  test("a corrupt or unreadable cache is ignored instead of trusted", async () => {
    for (const cache of [{ tier: "L9" }, "nonsense", new Error("ENOENT")]) {
      const fakes = makeDeps({ cache });
      const service = new PerfProfileService(fakes.deps);
      assert.equal(await service.load(), undefined);
      assert.equal(service.current(), undefined);
    }
  });

  test("refresh probes, persists, logs and notifies once", async () => {
    const fakes = makeDeps({ gpu: SOFTWARE_STATUS });
    const service = new PerfProfileService(fakes.deps);
    const snapshot = await service.refresh();
    assert.equal(snapshot.tier, "L2");
    assert.equal(snapshot.source, "probe");
    assert.equal(fakes.written.length, 1);
    assert.equal(fakes.changed.length, 1);
    assert.match(fakes.logged.at(-1) ?? "", /^info desktop\.perf_profile tier=L2/u);
  });

  test("concurrent refreshes share one probe", async () => {
    const fakes = makeDeps({ gpu: HARDWARE_STATUS });
    const service = new PerfProfileService(fakes.deps);
    const [first, second] = await Promise.all([service.refresh(), service.refresh()]);
    assert.equal(first, second);
    assert.equal(fakes.calls.filter((call) => call === "gpu-status").length, 1);
  });

  test("probe() reuses a fresh snapshot and re-probes a stale one", async () => {
    const fakes = makeDeps({ gpu: HARDWARE_STATUS });
    const service = new PerfProfileService(fakes.deps, { freshMs: 30_000 });
    const first = await service.probe();
    assert.equal(first.tier, "L0");
    const second = await service.probe();
    assert.equal(second, first, "fresh snapshot is reused, no second GPU probe");
    assert.equal(fakes.calls.filter((call) => call === "gpu-status").length, 1);
  });

  test("an unavailable GPU service still grades from cores/memory/power", async () => {
    const fakes = makeDeps({ renderer: "Google SwiftShader" });
    const service = new PerfProfileService(fakes.deps);
    const snapshot = await service.refresh();
    assert.equal(snapshot.softwareCompositing, true, "glRenderer fallback used when status is missing");
    assert.equal(snapshot.tier, "L2");
    assert.ok(fakes.calls.includes("gl-renderer"));
    assert.ok(fakes.logged.some((line) => line.includes("gpu_status=unavailable")));
  });

  test("a failing cache write does not fail the probe", async () => {
    const fakes = makeDeps({ gpu: HARDWARE_STATUS });
    const deps: PerfProfileProbeDeps = {
      ...fakes.deps,
      writeCache: async () => {
        throw new Error("EACCES");
      },
    };
    const service = new PerfProfileService(deps);
    const snapshot = await service.refresh();
    assert.equal(snapshot.tier, "L0");
    assert.ok(fakes.logged.some((line) => line.includes("cache_write=failed")));
  });
});

// ---- IPC + preload -------------------------------------------------------

interface FakeIpc {
  handlers: Map<string, (event: PerfProfileIpcEvent) => unknown>;
  listeners: Map<string, Set<(event: PerfProfileIpcEvent) => void>>;
  removedHandlers: string[];
  on(channel: string, listener: (event: PerfProfileIpcEvent) => void): void;
  removeListener(channel: string, listener: (event: PerfProfileIpcEvent) => void): void;
  handle(channel: string, listener: (event: PerfProfileIpcEvent) => unknown): void;
  removeHandler(channel: string): void;
}

function makeIpc(): FakeIpc {
  const handlers = new Map<string, (event: PerfProfileIpcEvent) => unknown>();
  const listeners = new Map<string, Set<(event: PerfProfileIpcEvent) => void>>();
  const removedHandlers: string[] = [];
  return {
    handlers,
    listeners,
    removedHandlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      removedHandlers.push(channel);
      handlers.delete(channel);
    },
    on(channel, listener) {
      let set = listeners.get(channel);
      if (set === undefined) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
  };
}

const sender = (trusted: boolean) => ({ destroyed: false, trusted, isDestroyed: () => false, getURL: () => "file:///C:/app/index.html" });

function makeSource(snapshot: PerfProfileSnapshot) {
  let probes = 0;
  return {
    source: {
      async probe() {
        probes += 1;
        return snapshot;
      },
      current: () => snapshot,
    },
    probes: () => probes,
  };
}

describe("registerPerfProfileIpc", () => {
  test("probe answers a trusted sender with the snapshot and nothing is writable", async () => {
    const ipc = makeIpc();
    const snapshot = cachedSnapshot();
    const { source, probes } = makeSource(snapshot);
    const handle = registerPerfProfileIpc({ ipcMain: ipc, isTrustedSender: (candidate) => (candidate as unknown as { trusted: boolean }).trusted === true, service: source });
    assert.deepEqual([...ipc.handlers.keys()], [PERF_PROFILE_CHANNELS.probe]);
    const result = await ipc.handlers.get(PERF_PROFILE_CHANNELS.probe)?.({ sender: sender(true) });
    assert.equal(result, snapshot);
    assert.equal(probes(), 1);
    handle.dispose();
    assert.deepEqual(ipc.removedHandlers, [PERF_PROFILE_CHANNELS.probe]);
    assert.equal(ipc.listeners.get(PERF_PROFILE_CHANNELS.cached)?.size ?? 0, 0);
  });

  test("probe returns null for an untrusted or destroyed sender", async () => {
    const ipc = makeIpc();
    const { source } = makeSource(cachedSnapshot());
    const handle = registerPerfProfileIpc({
      ipcMain: ipc,
      isTrustedSender: (candidate) => (candidate as unknown as { trusted: boolean }).trusted === true,
      service: source,
    });
    const invoke = ipc.handlers.get(PERF_PROFILE_CHANNELS.probe);
    assert.equal(await invoke?.({ sender: sender(false) }), null);
    assert.equal(await invoke?.({ sender: { ...sender(true), isDestroyed: () => true } }), null);
    handle.dispose();
  });

  test("the cached channel answers synchronously with the current snapshot", () => {
    const ipc = makeIpc();
    const snapshot = cachedSnapshot();
    const { source } = makeSource(snapshot);
    const handle = registerPerfProfileIpc({
      ipcMain: ipc,
      isTrustedSender: (candidate) => (candidate as unknown as { trusted: boolean }).trusted === true,
      service: source,
    });
    const listener = [...(ipc.listeners.get(PERF_PROFILE_CHANNELS.cached) ?? [])][0];
    assert.ok(listener);
    const event: PerfProfileIpcEvent = { sender: sender(true) };
    listener(event);
    assert.equal(event.returnValue, snapshot);
    const untrusted: PerfProfileIpcEvent = { sender: sender(false) };
    listener(untrusted);
    assert.equal(untrusted.returnValue, null);
    handle.dispose();
  });
});

describe("createPerfProfileApi (preload surface)", () => {
  function makeIpcStub(options: { cached?: unknown; probeResult?: unknown; syncThrows?: boolean }) {
    const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
    const removed: unknown[] = [];
    return {
      removed,
      listeners,
      invoke: async (channel: string) => {
        assert.equal(channel, PERF_PROFILE_CHANNELS.probe);
        return options.probeResult;
      },
      sendSync: (channel: string) => {
        assert.equal(channel, PERF_PROFILE_CHANNELS.cached);
        if (options.syncThrows === true) throw new Error("no handler");
        return options.cached;
      },
      on(channel: string, listener: (event: unknown, payload: unknown) => void) {
        let set = listeners.get(channel);
        if (set === undefined) {
          set = new Set();
          listeners.set(channel, set);
        }
        set.add(listener);
      },
      removeListener(channel: string, listener: (event: unknown, payload: unknown) => void) {
        removed.push(listener);
        listeners.get(channel)?.delete(listener);
      },
    };
  }

  test("cached is read synchronously and survives a missing handler", () => {
    const snapshot = cachedSnapshot();
    assert.deepEqual(createPerfProfileApi(makeIpcStub({ cached: snapshot })).cached, snapshot);
    assert.equal(createPerfProfileApi(makeIpcStub({ cached: "garbage" })).cached, null);
    assert.equal(createPerfProfileApi(makeIpcStub({ syncThrows: true })).cached, null);
  });

  test("probe validates the response instead of trusting Main blindly", async () => {
    const snapshot = cachedSnapshot();
    const api = createPerfProfileApi(makeIpcStub({ probeResult: snapshot }));
    assert.deepEqual(await api.probe(), snapshot);
    const broken = createPerfProfileApi(makeIpcStub({ probeResult: { tier: "L2" } }));
    await assert.rejects(() => broken.probe(), /invalid response/u);
  });

  test("onChanged delivers only valid snapshots and unsubscribes the exact listener", () => {
    const ipc = makeIpcStub({});
    const api = createPerfProfileApi(ipc);
    assert.ok(Object.isFrozen(api));
    assert.deepEqual(Object.keys(api).sort(), ["cached", "onChanged", "probe"]);
    const received: PerfProfileSnapshot[] = [];
    const off = api.onChanged((snapshot) => received.push(snapshot));
    const listener = [...(ipc.listeners.get(PERF_PROFILE_CHANNELS.changed) ?? [])][0];
    assert.ok(listener);
    listener({}, cachedSnapshot());
    listener({}, { tier: "L2" });
    assert.equal(received.length, 1);
    off();
    assert.equal(ipc.removed[0], listener, "identity removal");
    assert.equal(ipc.listeners.get(PERF_PROFILE_CHANNELS.changed)?.size ?? 0, 0);
  });
});
