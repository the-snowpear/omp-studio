import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UPDATE_CHECK_TIMEOUT_MS,
  isUpdateCheckTimeout,
  queryWithTimeout,
  UpdateCheckTimeoutError,
} from "./updateCheck";

afterEach(() => {
  vi.useRealTimers();
});

describe("queryWithTimeout", () => {
  it("returns the settled value before the deadline", async () => {
    await expect(queryWithTimeout(async () => "ok", 50)).resolves.toBe("ok");
  });

  it("rejects with UpdateCheckTimeoutError when the probe hangs", async () => {
    vi.useFakeTimers();
    const pending = queryWithTimeout(() => new Promise<string>(() => undefined), UPDATE_CHECK_TIMEOUT_MS);
    const expectTimeout = expect(pending).rejects.toSatisfy((error: unknown) => isUpdateCheckTimeout(error));
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);
    await expectTimeout;
    expect(new UpdateCheckTimeoutError().message).toBe("检查更新超时");
  });
});
