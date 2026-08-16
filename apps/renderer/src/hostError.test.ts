import { describe, expect, it } from "vitest";
import type { CommandRequestId } from "@omp-studio/client-contract";
import { MemoryClientTransport, StudioClientImpl } from "@omp-studio/client";
import { waitReceipt } from "./hostError";

describe("waitReceipt", () => {
  it("reads StudioClientImpl state without throwing on unbound getState", async () => {
    const client = new StudioClientImpl(new MemoryClientTransport());
    await expect(waitReceipt(client, "req-missing" as CommandRequestId, 20)).rejects.toEqual({
      code: "UNAVAILABLE",
      message: "等待 Host 回执超时",
    });
  });
});
