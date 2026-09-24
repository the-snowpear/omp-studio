import { describe, expect, it, vi } from "vitest";
import { MERMAID_CONFIG, MermaidQueue, mermaidBudget } from "./mermaidQueue";
import { RenderCache } from "./renderCache";
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("Mermaid budgets and lifecycle", () => {
  it("checks character, line and heuristic complexity limits before invoking render", async () => {
    const render = vi.fn(async () => "<svg/>");
    const queue = new MermaidQueue({ hidden: () => false, render });
    for (const code of ["x".repeat(20001), "a\n".repeat(601), "[a]-->".repeat(751)]) {
      expect(mermaidBudget(code).allowed).toBe(false);
      expect(queue.request(code, { active: () => true, result: vi.fn() }).status).toBe("rejected");
    }
    await settle();
    expect(render).not.toHaveBeenCalled();
    queue.dispose();
  });
  it("deduplicates subscribers, cancels waiting jobs and defers hidden work", async () => {
    let hidden = true;
    let finish!: (svg: string) => void;
    const render = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const queue = new MermaidQueue({ hidden: () => hidden, render });
    const one = vi.fn(), two = vi.fn();
    queue.request("graph TD; A-->B", { active: () => true, result: one });
    queue.request("graph TD; A-->B", { active: () => true, result: two });
    const cancelled = queue.request("graph TD; C-->D", { active: () => true, result: vi.fn() });
    cancelled.cancel(); cancelled.cancel();
    await settle();
    expect(render).not.toHaveBeenCalled();
    hidden = false; queue.pump(); await settle();
    expect(render).toHaveBeenCalledTimes(1);
    finish("<svg/>"); await settle();
    expect(one).toHaveBeenCalledWith("<svg/>"); expect(two).toHaveBeenCalledWith("<svg/>");
    queue.request("graph TD; A-->B", { active: () => true, result: vi.fn() }); await settle();
    expect(render).toHaveBeenCalledTimes(1);
    expect(queue.getDiagnostics().queued).toBe(0);
    queue.dispose();
  });
  it("rechecks visibility and liveness immediately before execution", async () => {
    let hidden = false, live = true;
    const render = vi.fn(async () => "<svg/>");
    const queue = new MermaidQueue({ hidden: () => hidden, render });
    queue.request("graph TD; A-->B", { active: () => live, result: vi.fn() });
    hidden = true; await settle();
    expect(render).not.toHaveBeenCalled();
    expect(queue.getDiagnostics().queued).toBe(1);
    live = false; hidden = false; queue.pump(); await settle();
    expect(render).not.toHaveBeenCalled();
    queue.dispose();
  });
  it("resumes a live job when the page becomes visible again during lazy module loading", async () => {
    let hidden = false;
    let finish!: () => void;
    const result = vi.fn();
    const render = vi.fn(async () => {
      if (render.mock.calls.length === 1) {
        await new Promise<void>((resolve) => { finish = resolve; });
        return undefined;
      }
      return "<svg/>";
    });
    const queue = new MermaidQueue({ hidden: () => hidden, render });
    queue.request("graph TD; A-->B", { active: () => true, result }); await settle();
    hidden = true; finish(); hidden = false;
    await settle(); await settle();
    expect(result).toHaveBeenCalledWith("<svg/>");
    expect(render).toHaveBeenCalledTimes(2);
    queue.dispose();
  });
  it("holds the serial slot for a cancelled in-flight promise, bounds waiting and retries slots", async () => {
    let finish!: (svg: string) => void;
    const render = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const queue = new MermaidQueue({ hidden: () => false, render });
    const result = vi.fn();
    const first = queue.request("graph TD; A-->B", { active: () => true, result });
    await settle(); first.cancel();
    for (let i = 0; i < 20; i++) queue.request(`graph TD; A-->B${i}`, { active: () => true, result: vi.fn() });
    expect(queue.getDiagnostics().queued).toBeLessThanOrEqual(8);
    const slot = vi.fn(); const off = queue.onSlot(slot);
    expect(render).toHaveBeenCalledTimes(1);
    finish("<svg/>"); await settle();
    expect(result).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(2);
    expect(slot).toHaveBeenCalled();
    off(); queue.dispose(); finish("<svg/>"); await settle();
    expect(queue.getDiagnostics()).toEqual({ cacheEntries: 0, cacheBytes: 0, queued: 0, running: 0, slotListeners: 0 });
  });
  it("skips oversized SVG caching, isolates configuration keys and recovers after failure", async () => {
    const render = vi.fn(async (_code: string, config: typeof MERMAID_CONFIG) => {
      if (_code === "bad") throw new Error("parse");
      return _code === "large" ? "s".repeat(4 * 1024 * 1024) : config.theme;
    });
    const queue = new MermaidQueue({ hidden: () => false, render });
    const result = vi.fn();
    queue.request("bad", { active: () => true, result }); await settle();
    expect(result).toHaveBeenLastCalledWith(null);
    queue.request("large", { active: () => true, result }); await settle();
    expect(result).toHaveBeenLastCalledWith("s".repeat(4 * 1024 * 1024));
    expect(queue.getDiagnostics().cacheEntries).toBe(0);
    queue.request("ok", { active: () => true, result }); await settle();
    queue.request("ok", { active: () => true, result }, { ...MERMAID_CONFIG, theme: "dark" } as unknown as typeof MERMAID_CONFIG); await settle();
    expect(render).toHaveBeenCalledTimes(4);
    expect(queue.getDiagnostics().cacheEntries).toBe(2);
    queue.dispose();
  });
  it("uses dual-budget LRU with refresh-on-hit", () => {
    const cache = new RenderCache<string>(2, 10);
    cache.put("a", "one", 3); cache.put("b", "two", 3); expect(cache.get("a")).toBe("one");
    cache.put("c", "tri", 3); expect(cache.get("b")).toBeUndefined();
    expect(cache.bytes).toBe(8); cache.put("oversized", "none", 100);
    expect(cache.size).toBe(2); cache.clear(); expect(cache.bytes).toBe(0);
  });
});
