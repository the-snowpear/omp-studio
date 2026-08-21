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
