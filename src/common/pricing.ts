import { anthropicModels, deepseekModels, openaiModels } from "./model.js";
import type { ModelInfo, Usage } from "../summary.js";

/** USD per million tokens. */
export interface Price {
  input: number;
  /** Input read from the prompt cache. */
  cacheRead: number;
  /** Input written to the prompt cache; the input price when the provider doesn't charge extra. */
  cacheWrite: number;
  output: number;
}

/**
 * List prices by API model ID, standard tier, checked 2026-10-09 against
 * platform.claude.com/docs/en/about-claude/pricing,
 * developers.openai.com/api/docs/pricing and
 * api-docs.deepseek.com/quick_start/pricing.
 *
 * Simplifications: Anthropic cache writes use the 5-minute rate (the one the
 * agent uses); Claude Haiku 5.5 (prompts over 100k tokens) and the OpenAI
 * models (over 272k) charge more for long prompts, but usage is only recorded
 * per case, so the base tier is used; DeepSeek is priced at peak or off-peak
 * by when the case finished (see DEEPSEEK_PEAK), ignoring Chinese holidays.
 */
export const PRICES: Readonly<Record<string, Price>> = {
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
  "claude-haiku-5-5": { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-6.1-sol": { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  // Peak prices; off-peak is half (see DEEPSEEK_PEAK).
  "deepseek-flash": { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2 },
  "deepseek-v4-pro": { input: 1.32, cacheRead: 0.044, cacheWrite: 1.32, output: 3.96 },
};

/** DeepSeek's peak hours, UTC, Monday to Friday: [start, end) hour ranges. Off-peak costs half. */
const DEEPSEEK_PEAK: readonly [number, number][] = [
  [1, 4],
  [6, 10],
];

function isDeepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return day >= 1 && day <= 5 && DEEPSEEK_PEAK.some(([start, end]) => hour >= start && hour < end);
}

/** The API model a spec runs: the named models' (at-*, oa-*, ds-*) or the model ID itself. */
export function apiModelOf({ modelId }: Pick<ModelInfo, "modelId">): string {
  return (anthropicModels[modelId] ?? openaiModels[modelId] ?? deepseekModels[modelId])?.apiModel ?? modelId;
}

/**
 * What a case's tokens cost in USD at list prices, or null when the model has
 * no known price (Bedrock and Google models, or IDs not in PRICES), or for
 * Claude results recorded before cache writes were counted: their usage leaves
 * the cached tokens out of the input and the writes unknown, so rerun them.
 * `finishedAt` picks DeepSeek's peak or off-peak price.
 */
export function costOf(model: Pick<ModelInfo, "modelId">, usage: Usage, finishedAt?: string | null): number | null {
  const apiModel = apiModelOf(model);
  const price = PRICES[apiModel];
  if (price === undefined) return null;
  if (apiModel.startsWith("claude-") && usage.cacheWriteInputTokens === undefined) return null;
  const written = usage.cacheWriteInputTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens - written);
  const usd =
    (uncached * price.input + usage.cachedInputTokens * price.cacheRead + written * price.cacheWrite + usage.outputTokens * price.output) / 1e6;
  const offPeak = apiModel.startsWith("deepseek-") && finishedAt != null && !isDeepSeekPeak(new Date(finishedAt));
  return offPeak ? usd / 2 : usd;
}
