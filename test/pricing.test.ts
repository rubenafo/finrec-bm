import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anthropicModels, deepseekModels, modelProviders, openaiModels } from "../src/common/model.js";
import { apiModelOf, costOf, PRICES } from "../src/common/pricing.js";

const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number, cacheWriteInputTokens?: number) => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
  ...(cacheWriteInputTokens !== undefined && { cacheWriteInputTokens }),
});
const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);

describe("pricing", () => {
  it("has a price for every listed model", () => {
    const listed = [
      ...modelProviders.anthropic!.listed,
      ...Object.keys(anthropicModels),
      ...Object.keys(openaiModels),
      ...Object.keys(deepseekModels),
    ];
    for (const modelId of listed) assert.ok(apiModelOf({ modelId }) in PRICES, modelId);
  });

  it("maps named models to their API model", () => {
    assert.equal(apiModelOf({ modelId: "at-sonnet-high" }), "claude-sonnet-5-5");
    assert.equal(apiModelOf({ modelId: "oa-luna-reasoning-low" }), "gpt-6-luna");
    assert.equal(apiModelOf({ modelId: "ds-v4p-reasoning-max" }), "deepseek-v4-pro");
    assert.equal(apiModelOf({ modelId: "claude-opus-5" }), "claude-opus-5");
  });

  it("prices uncached input, cache reads, cache writes and output apart", () => {
    // Sonnet 5.5: $2 in, $0.10 cache read, $2.50 cache write, $10 out per million.
    // 1M input = 100k uncached + 800k read + 100k written.
    close(costOf({ modelId: "at-sonnet-high" }, usage(1_000_000, 800_000, 100_000, 100_000)), 0.2 + 0.08 + 0.25 + 1);
    // Results without cache writes recorded count all non-cached input as uncached.
    close(costOf({ modelId: "oa-sol-reasoning-high" }, usage(1_000_000, 500_000, 0)), 1 + 0.05);
  });

  it("halves DeepSeek prices off-peak (outside 01-04 and 06-10 UTC on weekdays)", () => {
    const u = usage(1_000_000, 0, 1_000_000);
    close(costOf({ modelId: "ds-flash-reasoning-high" }, u, "2026-10-02T08:00:00+00:00"), 1.5);
    close(costOf({ modelId: "ds-flash-reasoning-high" }, u, "2026-10-02T12:00:00+02:00"), 0.75);
    close(costOf({ modelId: "ds-flash-reasoning-high" }, u, "2026-10-03T08:00:00+00:00"), 0.75); // Saturday
    close(costOf({ modelId: "ds-flash-reasoning-high" }, u), 1.5); // unknown time: peak
  });

  it("leaves Claude results recorded before cache writes were counted without a cost", () => {
    assert.equal(costOf({ modelId: "at-haiku-low" }, usage(16, 96_233, 5_885)), null);
    close(costOf({ modelId: "at-haiku-low" }, usage(1_000_000, 0, 0, 0)), 0.1);
  });

  it("has no price for models it doesn't know", () => {
    assert.equal(costOf({ modelId: "anthropic.claude-opus-5-v1:0" }, usage(1, 0, 1)), null);
  });
});
