import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DarwinPlatformPort } from "../src/darwin-platform-port.js";
import type { DarwinPlatformServices } from "../src/darwin-services.js";

describe("DarwinPlatformPort", () => {
  it("Linux uses the POSIX endpoint and delegates external links through its injected services", async () => {
    const opened: string[] = [];
    const profile = "/home/test/.config/omp-studio";
    const port = new DarwinPlatformPort({
      appDataDirectory: () => profile,
      createCurrentUserOnlyEndpoint: directory => { assert.equal(directory, profile); return "linux-authority"; },
      revealInFinder() {}, openExternal: url => { opened.push(url); },
      attachProcess() {}, requestProcessStop() {}, forceProcessStop() {}, releaseProcess() {},
    }, "linux");
    assert.equal(port.platform, "linux");
    assert.equal(port.runtimeExecutableName(), "omp");
    assert.deepEqual(await port.createPrivateEndpoint(await port.appDataDirectory()), { kind: "unix-socket", authority: "linux-authority" });
    await port.openExternal("https://github.com/the-snowpear/omp-studio");
    assert.deepEqual(opened, ["https://github.com/the-snowpear/omp-studio"]);
  });

  it("should create a darwin platform port", () => {
    const services: DarwinPlatformServices = {
      appDataDirectory: () => "/Users/test/Library/Application Support/omp-studio",
      createCurrentUserOnlyEndpoint: () => "test-authority",
      revealInFinder: () => {},
      openExternal: () => {},
      attachProcess: () => {},
      requestProcessStop: () => {},
      forceProcessStop: () => {},
      releaseProcess: () => {},
    };
    const port = new DarwinPlatformPort(services);
    assert.equal(port.platform, "darwin");
  });

  it("should return correct runtime executable name", () => {
    const services: DarwinPlatformServices = {
      appDataDirectory: () => "/Users/test/Library/Application Support/omp-studio",
      createCurrentUserOnlyEndpoint: () => "test-authority",
      revealInFinder: () => {},
      openExternal: () => {},
      attachProcess: () => {},
      requestProcessStop: () => {},
      forceProcessStop: () => {},
      releaseProcess: () => {},
    };
    const port = new DarwinPlatformPort(services);
    assert.equal(port.runtimeExecutableName(), "omp");
  });
});
