import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS,
  initPerformanceTimelineCleanup,
  __resetPerformanceTimelineCleanupForTests,
  type PerformanceTimelineApi,
} from "./performanceTimelineCleanup.js";

function fakePerformanceApi(): Required<PerformanceTimelineApi> {
  return { clearMarks: vi.fn(), clearMeasures: vi.fn() };
}

const DEV_ENV = { dev: true, preserveTimeline: false } as const;
const NO_HARNESS = () => false;

describe("performanceTimelineCleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetPerformanceTimelineCleanupForTests();
  });

  afterEach(() => {
    __resetPerformanceTimelineCleanupForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("dev 环境每 10 秒清理一次 marks/measures", () => {
    const api = fakePerformanceApi();
    initPerformanceTimelineCleanup({
      env: DEV_ENV,
      isPerfHarnessActive: NO_HARNESS,
      performanceApi: api,
    });

    vi.advanceTimersByTime(PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS - 1);
    expect(api.clearMarks).not.toHaveBeenCalled();
    expect(api.clearMeasures).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(api.clearMarks).toHaveBeenCalledTimes(1);
    expect(api.clearMeasures).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS);
    expect(api.clearMarks).toHaveBeenCalledTimes(2);
    expect(api.clearMeasures).toHaveBeenCalledTimes(2);
  });

  it("生产分支（dev=false）不启动清理器", () => {
    const api = fakePerformanceApi();
    const dispose = initPerformanceTimelineCleanup({
      env: { dev: false, preserveTimeline: false },
      isPerfHarnessActive: NO_HARNESS,
      performanceApi: api,
    });

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(api.clearMarks).not.toHaveBeenCalled();
    expect(api.clearMeasures).not.toHaveBeenCalled();
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("VITE_OMP_PRESERVE_PERFORMANCE_TIMELINE=1（preserveTimeline）禁用清理", () => {
    const api = fakePerformanceApi();
    initPerformanceTimelineCleanup({
      env: { dev: true, preserveTimeline: true },
      isPerfHarnessActive: NO_HARNESS,
      performanceApi: api,
    });

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(api.clearMarks).not.toHaveBeenCalled();
    expect(api.clearMeasures).not.toHaveBeenCalled();
  });

  it("重复初始化幂等：只启动一个计时器，返回同一个停止函数", () => {
    const api = fakePerformanceApi();
    const options = {
      env: DEV_ENV,
      isPerfHarnessActive: NO_HARNESS,
      performanceApi: api,
    };
    const first = initPerformanceTimelineCleanup(options);
    const second = initPerformanceTimelineCleanup(options);

    expect(second).toBe(first);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS);
    expect(api.clearMarks).toHaveBeenCalledTimes(1);
    expect(api.clearMeasures).toHaveBeenCalledTimes(1);
  });

  it("dispose（HMR dispose 接线调用的同一函数）清除计时器并停止清理，重复调用安全", () => {
    const api = fakePerformanceApi();
    const dispose = initPerformanceTimelineCleanup({
      env: DEV_ENV,
      isPerfHarnessActive: NO_HARNESS,
      performanceApi: api,
    });
    expect(vi.getTimerCount()).toBe(1);

    dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(api.clearMarks).not.toHaveBeenCalled();
    expect(api.clearMeasures).not.toHaveBeenCalled();

    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose 之后可以重新初始化", () => {
    const api = fakePerformanceApi();
    const options = {
      env: DEV_ENV,
      isPerfHarnessActive: NO_HARNESS,
      performanceApi: api,
    };
    initPerformanceTimelineCleanup(options)();

    const restarted = initPerformanceTimelineCleanup(options);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS);
    expect(api.clearMarks).toHaveBeenCalledTimes(1);
    restarted();
  });

  it("性能 harness 标记（window.ompPerf）在场时不启动清理器", () => {
    vi.stubGlobal("ompPerf", { reset: () => undefined });
    const api = fakePerformanceApi();
    initPerformanceTimelineCleanup({
      env: DEV_ENV,
      performanceApi: api,
    });

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(api.clearMarks).not.toHaveBeenCalled();
    expect(api.clearMeasures).not.toHaveBeenCalled();
  });

  it("harness 标记在启动后才挂上时，tick 复查跳过清理", () => {
    const api = fakePerformanceApi();
    initPerformanceTimelineCleanup({
      env: DEV_ENV,
      performanceApi: api,
    });
    expect(vi.getTimerCount()).toBe(1);

    vi.stubGlobal("ompPerf", {});
    vi.advanceTimersByTime(PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS * 3);
    expect(api.clearMarks).not.toHaveBeenCalled();
    expect(api.clearMeasures).not.toHaveBeenCalled();
  });

  it("默认环境绑定：Vitest 下 import.meta.env.DEV 为 true，清理器照常启动", () => {
    const api = fakePerformanceApi();
    initPerformanceTimelineCleanup({ performanceApi: api });

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS);
    expect(api.clearMarks).toHaveBeenCalledTimes(1);
    expect(api.clearMeasures).toHaveBeenCalledTimes(1);
  });

  it("环境没有 User Timing API（如 jsdom）时不启动、不报错", () => {
    const dispose = initPerformanceTimelineCleanup({
      env: DEV_ENV,
      isPerfHarnessActive: NO_HARNESS,
      performanceApi: {},
    });

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    dispose();
  });
});
