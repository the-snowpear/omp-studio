import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DarwinPlatformPort } from "../src/darwin-platform-port.js";
import type { DarwinPlatformServices } from "../src/darwin-services.js";

describe("DarwinPlatformPort", () => {
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
