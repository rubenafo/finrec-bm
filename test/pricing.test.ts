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
    assert.equal(apiModelOf({ modelId: "oa-luna-low" }), "gpt-6-luna");
    assert.equal(apiModelOf({ modelId: "ds-v4p-max" }), "deepseek-v4-pro");
    assert.equal(apiModelOf({ modelId: "claude-opus-5" }), "claude-opus-5");
  });

  it("prices uncached input, cache reads, cache writes and output apart", () => {
    // Sonnet 5.5: $2 in, $0.10 cache read, $2.50 cache write, $10 out per million.
    // 1M input = 100k uncached + 800k read + 100k written.
    close(costOf({ modelId: "at-sonnet-high" }, usage(1_000_000, 800_000, 100_000, 100_000)), 0.2 + 0.08 + 0.25 + 1);
    // OpenAI results recorded before cache writes were: the input not read from the cache was written.
    // Sol: $2.50 cache write, $0.10 cache read per million.
    close(costOf({ modelId: "oa-sol-high" }, usage(1_000_000, 500_000, 0)), 1.25 + 0.05);
    close(costOf({ modelId: "oa-sol-high" }, usage(1_000_000, 500_000, 0, 400_000)), 0.2 + 1 + 0.05);
  });

  it("halves DeepSeek prices off-peak (outside 01-04 and 06-10 UTC on weekdays, and on Chinese public holidays)", () => {
    const u = usage(1_000_000, 0, 1_000_000);
    close(costOf({ modelId: "ds-flash-high" }, u, "2026-10-09T08:00:00+00:00"), 1.5);
    close(costOf({ modelId: "ds-flash-high" }, u, "2026-10-09T12:00:00+02:00"), 0.75);
    close(costOf({ modelId: "ds-flash-high" }, u, "2026-10-10T08:00:00+00:00"), 0.75); // Saturday
    close(costOf({ modelId: "ds-flash-high" }, u, "2026-10-02T08:00:00+00:00"), 0.75); // National Day holiday
    close(costOf({ modelId: "ds-flash-high" }, u), 1.5); // unknown time: peak
  });

  it("prices each recorded request on its own: DeepSeek by its time, long prompts at their higher price", () => {
    const at = (when: string, inputTokens: number, outputTokens: number) => ({ at: when, ...usage(inputTokens, 0, outputTokens, 0) });
    // One request at peak, one just after it: $0.30 + $1.20, then half of that.
    close(
      costOf({ modelId: "ds-flash-high" }, usage(0, 0, 0), null, [at("2026-10-09T09:59:00Z", 1_000_000, 1_000_000), at("2026-10-09T10:01:00Z", 1_000_000, 1_000_000)]),
      1.5 + 0.75,
    );
    // Haiku 5.5: a 100,000-token prompt is at the base price, a 100,001-token one at 5x.
    const haiku = (inputTokens: number) => costOf({ modelId: "at-haiku-low" }, usage(0, 0, 0, 0), null, [at("2026-10-09T09:00:00Z", inputTokens, 0)]);
    close(haiku(100_000), 0.01);
    close(haiku(100_001), (100_001 * 0.5) / 1e6);
    // The threshold counts cache reads and writes: 30k uncached + 50k read + 30k written is a 110k prompt.
    close(
      costOf({ modelId: "at-haiku-low" }, usage(0, 0, 0, 0), null, [{ at: "2026-10-09T09:00:00Z", ...usage(110_000, 50_000, 0, 30_000) }]),
      (30_000 * 0.5 + 50_000 * 0.05 + 30_000 * 0.625) / 1e6,
    );
    // OpenAI over 272k input tokens.
    close(costOf({ modelId: "oa-sol-high" }, usage(0, 0, 0), null, [at("2026-10-09T09:00:00Z", 300_000, 0)]), 300_000 * 4 / 1e6);
  });

  it("leaves Claude results recorded before cache writes were counted without a cost", () => {
    assert.equal(costOf({ modelId: "at-haiku-low" }, usage(16, 96_233, 5_885)), null);
    close(costOf({ modelId: "at-haiku-low" }, usage(1_000_000, 0, 0, 0)), 0.1);
  });

  it("has no price for models it doesn't know", () => {
    assert.equal(costOf({ modelId: "anthropic.claude-opus-5-v1:0" }, usage(1, 0, 1)), null);
  });
});
