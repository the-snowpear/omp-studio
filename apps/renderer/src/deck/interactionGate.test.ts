import { describe, expect, it } from "vitest";
import type { CapabilityManifest } from "@omp-studio/studio-protocol";
import { interactionDeckDisabled, planReviewDeckDisabled, usableCapabilityManifest } from "./interactionGate";

const emptyLimited: CapabilityManifest = {
  profile: "limited",
  generatedAt: "1970-01-01T00:00:00.000Z",
  hash: "empty",
  capabilities: [],
};

const live: CapabilityManifest = {
  profile: "full-parity-v1",
  generatedAt: "1970-01-01T00:00:00.000Z",
  hash: "live",
  capabilities: [{ id: "interaction.respond", grade: "stable", version: 1, evidence: "test" }],
};

describe("interactionDeckDisabled", () => {
  it("does not lock a visible ask while composer gated flags are still catching up", () => {
    expect(interactionDeckDisabled({ resyncRequired: false, runtimeConnected: true })).toBe(false);
  });

  it("locks only when the Host cannot accept interaction.respond", () => {
    expect(interactionDeckDisabled({ resyncRequired: true, runtimeConnected: true })).toBe(true);
    expect(interactionDeckDisabled({ resyncRequired: false, runtimeConnected: false })).toBe(true);
  });
});

describe("planReviewDeckDisabled", () => {
  it("does not lock Plan Review while composer gated flags are still catching up", () => {
    expect(planReviewDeckDisabled({
      resyncRequired: false,
      runtimeConnected: true,
      canRespond: true,
    })).toBe(false);
  });

  it("locks when the Host cannot accept mode.plan.review.respond", () => {
    expect(planReviewDeckDisabled({
      resyncRequired: true,
      runtimeConnected: true,
      canRespond: true,
    })).toBe(true);
    expect(planReviewDeckDisabled({
      resyncRequired: false,
      runtimeConnected: false,
      canRespond: true,
    })).toBe(true);
    expect(planReviewDeckDisabled({
      resyncRequired: false,
      runtimeConnected: true,
      canRespond: false,
    })).toBe(true);
  });
});

describe("usableCapabilityManifest", () => {
  it("skips an empty limited overwrite so a later hello/bootstrap list still counts", () => {
    expect(usableCapabilityManifest(emptyLimited, live)?.hash).toBe("live");
    expect(usableCapabilityManifest(emptyLimited, undefined, live)?.capabilities[0]?.id).toBe("interaction.respond");
    expect(usableCapabilityManifest(emptyLimited)?.capabilities).toEqual([]);
  });
});
