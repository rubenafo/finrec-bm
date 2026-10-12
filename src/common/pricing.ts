import { anthropicModels, deepseekModels, openaiModels } from "./model.js";
import type { ModelInfo, RequestUsage, Usage } from "../summary.js";

/** USD per million tokens. */
export interface Price {
  input: number;
  /** Input read from the prompt cache. */
  cacheRead: number;
  /** Input written to the prompt cache; the input price when the provider doesn't charge extra. */
  cacheWrite: number;
  output: number;
}

/** A model's prices, and the higher ones a request pays when its prompt is over `longPrompt.over` tokens. */
export interface ModelPrice extends Price {
  longPrompt?: Price & { over: number };
}

/**
 * List prices by API model ID, standard tier, checked 2026-10-12 against
 * platform.claude.com/docs/en/about-claude/pricing,
 * developers.openai.com/api/docs/pricing (and its prompt-caching guide) and
 * api-docs.deepseek.com/quick_start/pricing.
 *
 * - Anthropic cache writes use the 5-minute rate, the one the agent uses.
 * - Claude Haiku 5.5 charges more for a request whose prompt (all its input,
 *   cache reads and writes included) is over 100,000 tokens; the OpenAI
 *   models, for one over 272,000 input tokens. Each request is priced on its own.
 * - OpenAI bills cache writes (gpt-6 models) at 1.25x input.
 * - DeepSeek doesn't charge for cache writes, and halves its prices off-peak
 *   (see isDeepSeekPeak).
 */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 },
  "claude-fable-5": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-8": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-7": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-6": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-sonnet-5-5": { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "claude-sonnet-4-6": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  "claude-haiku-5-5": {
    input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5,
    longPrompt: { over: 100_000, input: 0.5, cacheRead: 0.05, cacheWrite: 0.625, output: 2.5 },
  },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  "gpt-6-luna": {
    input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5,
    longPrompt: { over: 272_000, input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 0.75 },
  },
  "gpt-6.1-sol": {
    input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10,
    longPrompt: { over: 272_000, input: 4, cacheRead: 0.2, cacheWrite: 5, output: 15 },
  },
  // Peak prices; off-peak is half (see isDeepSeekPeak).
  "deepseek-flash": { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2 },
  "deepseek-v4-pro": { input: 1.32, cacheRead: 0.044, cacheWrite: 1.32, output: 3.96 },
};

/** DeepSeek's peak hours, UTC, Monday to Friday: [start, end) hour ranges. Off-peak costs half. */
const DEEPSEEK_PEAK: readonly [number, number][] = [
  [1, 4],
  [6, 10],
];

/**
 * Chinese public holidays (State Council schedule, published 2025-11-04), on
 * which DeepSeek is off-peak all day. Peak hours fall on the same date in UTC
 * and in China, so a UTC date is compared.
 */
const CHINESE_HOLIDAYS_2026: readonly [string, string][] = [
  ["2026-01-01", "2026-01-03"],
  ["2026-02-15", "2026-02-23"],
  ["2026-04-04", "2026-04-06"],
  ["2026-05-01", "2026-05-05"],
  ["2026-06-19", "2026-06-21"],
  ["2026-09-25", "2026-09-27"],
  ["2026-10-01", "2026-10-07"],
];

/** Whether DeepSeek charges its peak price at `at`: 01:00-04:00 and 06:00-10:00 UTC on weekdays, except Chinese public holidays. */
export function isDeepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  const date = at.toISOString().slice(0, 10);
  if (CHINESE_HOLIDAYS_2026.some(([from, to]) => date >= from && date <= to)) return false;
  return day >= 1 && day <= 5 && DEEPSEEK_PEAK.some(([start, end]) => hour >= start && hour < end);
}

/** The API model a spec runs: the named models' (at-*, oa-*, ds-*) or the model ID itself. */
export function apiModelOf({ modelId }: Pick<ModelInfo, "modelId">): string {
  return (anthropicModels[modelId] ?? openaiModels[modelId] ?? deepseekModels[modelId])?.apiModel ?? modelId;
}

/** What tokens cost in USD at `price`: uncached input, cache reads, cache writes and output each at their own rate. */
function tokensCost(price: Price, usage: Usage): number {
  const written = usage.cacheWriteInputTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens - written);
  return (uncached * price.input + usage.cachedInputTokens * price.cacheRead + written * price.cacheWrite + usage.outputTokens * price.output) / 1e6;
}

/**
 * What a model's tokens cost in USD at list prices, or null when the model
 * has no known price (Google models, or IDs not in PRICES).
 *
 * With `requests`, the usage of each model request and when it was made,
 * every request is priced on its own: at the long-prompt price when its
 * prompt is over the threshold, and for DeepSeek at the peak or off-peak price
 * of its time.
 *
 * Results recorded before requests were are priced from the case's `usage`
 * totals, at DeepSeek's price when the case finished (`finishedAt`; peak
 * when unknown). None of their requests came near a long-prompt threshold
 * (the largest was under 50,000 tokens), so the base prices are exact for
 * them. OpenAI didn't have its cache writes recorded then: they are taken as
 * the input not read from the cache, which automatic caching writes. Claude
 * results recorded before cache writes were counted get null: their input
 * leaves the cached tokens out and the writes are unknown.
 */
export function costOf(model: Pick<ModelInfo, "modelId">, usage: Usage, finishedAt?: string | null, requests?: RequestUsage[]): number | null {
  const apiModel = apiModelOf(model);
  const price = PRICES[apiModel];
  if (price === undefined) return null;
  const deepseek = apiModel.startsWith("deepseek-");
  const at = (when: Date) => (deepseek && !isDeepSeekPeak(when) ? 0.5 : 1);
  if (requests !== undefined && requests.length > 0) {
    const usd = requests.reduce((total, r) => {
      const long = price.longPrompt !== undefined && r.inputTokens > price.longPrompt.over;
      return total + tokensCost(long ? price.longPrompt! : price, r) * at(new Date(r.at));
    }, 0);
    return usd;
  }
  if (apiModel.startsWith("claude-") && usage.cacheWriteInputTokens === undefined) return null;
  const legacy = apiModel.startsWith("gpt-") && !usage.cacheWriteInputTokens
    ? { ...usage, cacheWriteInputTokens: usage.inputTokens - usage.cachedInputTokens }
    : usage;
  return tokensCost(price, legacy) * (deepseek && finishedAt != null ? at(new Date(finishedAt)) : 1);
}
