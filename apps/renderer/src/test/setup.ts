if (typeof globalThis.navigator !== "undefined") {
  Object.defineProperty(globalThis.navigator, "language", {
    value: "zh-CN",
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis.navigator, "languages", {
    value: ["zh-CN", "zh"],
    configurable: true,
    writable: true,
  });
}

// JSDOM has no intersection observer. Keep mounted browser surfaces observable
// without adding test-only fallbacks to the production components.
if (typeof globalThis.IntersectionObserver === "undefined") {
  class TestIntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    private targets = new Set<Element>();
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.targets.add(target);
      queueMicrotask(() => {
        if (!this.targets.has(target)) return;
        const bounds = target.getBoundingClientRect();
        this.callback([{ target, isIntersecting: target.isConnected, intersectionRatio: target.isConnected ? 1 : 0, boundingClientRect: bounds, intersectionRect: bounds, rootBounds: null, time: performance.now() }], this as unknown as IntersectionObserver);
      });
    }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
    takeRecords(): IntersectionObserverEntry[] { return []; }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: TestIntersectionObserver });
}
