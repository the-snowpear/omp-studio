import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelPricing, resolveModelPrice } from "@omp-studio/client-contract";
import { availableFromCacheModel, catalogEntryFromAvailable } from "../src/omp-models-adapter.js";

const base = { input: 2, output: 4, cacheRead: 0, cacheWrite: 1 };
const monday = Date.parse("2026-09-14T10:00:00Z");
const schedule = {
  offPeakMultiplier: 0.5,
  peakWindows: [{ weekdays: [1], startMinute: 600, endMinute: 660 }],
};

test("catalog projection keeps zero prices and honors stripped wire image input", () => {
  const model = availableFromCacheModel({
    id: "vision-advertised",
    input: ["text", "image"],
    compat: { stripImageInput: true },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    api: "anthropic-messages",
  }, "native");
  assert.equal(model?.image, false);
  assert.deepEqual(model?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(model?.api, "anthropic-messages");
});

test("cache schedule survives the read model without replacing the base rate card", () => {
  const model = availableFromCacheModel({ id: "scheduled", cost: { ...base, timeBased: schedule }, maxContextWindow: 500000 }, "native");
  assert.ok(model);
  const catalog = catalogEntryFromAvailable(model);
  assert.deepEqual(catalog.cost, base);
  assert.deepEqual(catalog.pricing?.timeBased, schedule);
  assert.equal(catalog.maxContextWindow, 500000);
});

test("price estimates use UTC peak start inclusively and end exclusively", () => {
  const pricing = parseModelPricing({ ...base, timeBased: schedule });
  assert.equal(resolveModelPrice(base, pricing, monday - 1).cost?.input, 1);
  assert.equal(resolveModelPrice(base, pricing, monday).cost?.input, 2);
  assert.equal(resolveModelPrice(base, pricing, monday + 3600000).cost?.input, 1);
});

test("dated rate cards replace rather than inherit an older long-context tier", () => {
  const pricing = parseModelPricing({
    ...base,
    longContext: { ...base, input: 10, inputThreshold: 100 },
    timeBased: { ...schedule, effectiveRates: [{ ...base, input: 3, effectiveFrom: monday }] },
  });
  assert.equal(resolveModelPrice(base, pricing, monday - 1, 101).longContext, true);
  assert.equal(resolveModelPrice(base, pricing, monday, 101).longContext, false);
  assert.equal(resolveModelPrice(base, pricing, monday, 101).cost?.input, 3);
});

test("long-context inclusive and exclusive thresholds remain distinct", () => {
  const pricing = parseModelPricing({ longContext: { ...base, input: 5, inputThreshold: 100 } });
  assert.equal(resolveModelPrice(base, pricing, monday, 100).cost?.input, 2);
  assert.equal(resolveModelPrice(base, pricing, monday, 101).cost?.input, 5);
  const inclusive = parseModelPricing({ longContext: { ...base, input: 5, inputThreshold: 100, inputThresholdInclusive: true } });
  assert.equal(resolveModelPrice(base, inclusive, monday, 100).cost?.input, 5);
});

test("invalid schedules are omitted instead of producing fabricated prices", () => {
  assert.equal(parseModelPricing({ timeBased: { ...schedule, offPeakMultiplier: -1 } }), undefined);
  assert.equal(parseModelPricing({ timeBased: { ...schedule, peakWindows: [{ weekdays: [1, 1], startMinute: 0, endMinute: 1440 }] } }), undefined);
  assert.equal(parseModelPricing({ timeBased: { ...schedule, effectiveRates: [{ ...base, effectiveFrom: monday }, { ...base, effectiveFrom: monday }] } }), undefined);
});
