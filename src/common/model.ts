import { randomUUID } from "node:crypto";
import type { BaseModelConfig, Model } from "@strands-agents/sdk";
import { deepseekFetch } from "./deepseek-fetch.js";
import { ModelProvider, type BuildOptions } from "./model-provider.js";
import { matchNames } from "./pattern.js";

// Provider modules are imported on demand so only the chosen SDK is loaded.

/** Anthropic effort levels, sent as the Messages API's `output_config.effort`. */
type AnthropicEffort = "low" | "medium" | "high" | "max";

/**
 * Named Anthropic models as `at-<model>-<effort>`, each an API model plus an
 * effort level: "haiku" is claude-haiku-5-5, "sonnet" is claude-sonnet-5-5.
 */
export const anthropicModels: Readonly<Record<string, { apiModel: string; effort: AnthropicEffort }>> = Object.fromEntries(
  (
    [
      ["haiku", "claude-haiku-5-5"],
      ["sonnet", "claude-sonnet-5-5"],
    ] as const
  ).flatMap(([short, apiModel]) =>
    (["low", "medium", "high", "max"] as const).map((effort) => [`at-${short}-${effort}`, { apiModel, effort }]),
  ),
);

const anthropic = new ModelProvider({
  name: "anthropic",
  label: "Anthropic",
  models: [
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    ...Object.keys(anthropicModels),
  ],
  apiKeyEnv: "ANTHROPIC_API_KEY",
  requiresApiKey: true,
  inputTokensExcludeCache: true,
  async create(modelId, { apiKey, maxTokens }) {
    const { AnthropicModel } = await import("@strands-agents/sdk/models/anthropic");
    // Prompt caching: cache points on the tools, the system prompt and the last
    // user message, so each turn reads the conversation so far from the cache.
    const cacheConfig = { strategy: "auto" } as const;
    const named = anthropicModels[modelId];
    if (named === undefined) return new AnthropicModel({ modelId, maxTokens, apiKey: apiKey!, cacheConfig });
    return new AnthropicModel({
      modelId: named.apiModel,
      maxTokens,
      apiKey: apiKey!,
      cacheConfig,
      params: { output_config: { effort: named.effort } },
    });
  },
});

const bedrock = new ModelProvider({
  name: "bedrock",
  label: "Amazon Bedrock",
  // Any model or inference profile ID; availability depends on account and region.
  // Credentials come from the AWS credential chain, region from AWS_REGION.
  async create(modelId, { maxTokens }) {
    const { BedrockModel } = await import("@strands-agents/sdk/models/bedrock");
    return new BedrockModel({ modelId, maxTokens, ...(process.env.AWS_REGION && { region: process.env.AWS_REGION }) });
  },
});

/** OpenAI reasoning efforts, sent as the Responses API's `reasoning.effort`. */
type OpenAIReasoning = "none" | "low" | "medium" | "high" | "xhigh";

/**
 * Named OpenAI models as `oa-<model>-reasoning-<level>`, each an API model
 * plus a reasoning effort: "luna" is gpt-6-luna, "sol" is gpt-6.1-sol.
 */
export const openaiModels: Readonly<Record<string, { apiModel: string; reasoning: OpenAIReasoning }>> = Object.fromEntries(
  (
    [
      ["luna", "gpt-6-luna", ["none", "low", "medium", "high", "xhigh"]],
      ["sol", "gpt-6.1-sol", ["low", "medium", "high", "xhigh"]],
    ] as const
  ).flatMap(([short, apiModel, levels]) =>
    levels.map((reasoning) => [`oa-${short}-reasoning-${reasoning}`, { apiModel, reasoning }]),
  ),
);

const openai = new ModelProvider({
  name: "openai",
  label: "OpenAI",
  // Any model ID works as openai:<id>; the named oa-* models are listed for selection.
  listedModels: Object.keys(openaiModels),
  apiKeyEnv: "OPENAI_API_KEY",
  requiresApiKey: true,
  async create(modelId, { apiKey, maxTokens }) {
    const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
    // OpenAI caches prompt prefixes automatically. A prompt_cache_key per model
    // instance, so per case, keeps each conversation's requests on one cache
    // instead of spreading concurrent cases that share the same opening prefix.
    const cacheConfig = { cacheKey: `finrec-${randomUUID()}` };
    const named = openaiModels[modelId];
    if (named === undefined) return new OpenAIModel({ modelId, maxTokens, apiKey: apiKey!, cacheConfig });
    return new OpenAIModel({
      modelId: named.apiModel,
      maxTokens,
      apiKey: apiKey!,
      cacheConfig,
      params: { reasoning: { effort: named.reasoning } },
    });
  },
});

const google = new ModelProvider({
  name: "google",
  label: "Google Gemini",
  apiKeyEnv: "GEMINI_API_KEY",
  requiresApiKey: true,
  async create(modelId, { apiKey, maxTokens }) {
    const { GoogleModel } = await import("@strands-agents/sdk/models/google");
    return new GoogleModel({ modelId, maxTokens, apiKey: apiKey! });
  },
});

/** DeepSeek reasoning settings: thinking off, or on at the given `reasoning_effort`. */
type DeepSeekReasoning = "off" | "low" | "high" | "max";

/**
 * DeepSeek models as `ds-<model>-reasoning-<level>`, each an API model plus a
 * reasoning setting. "flash" is deepseek-flash, "v4p" is deepseek-v4-pro.
 */
export const deepseekModels: Readonly<Record<string, { apiModel: string; reasoning: DeepSeekReasoning }>> =
  Object.fromEntries(
    (
      [
        ["flash", "deepseek-flash"],
        ["v4p", "deepseek-v4-pro"],
      ] as const
    ).flatMap(([short, apiModel]) =>
      (["off", "low", "high", "max"] as const).map((reasoning) => [
        `ds-${short}-reasoning-${reasoning}`,
        { apiModel, reasoning },
      ]),
    ),
  );

const deepseek = new ModelProvider({
  name: "deepseek",
  label: "DeepSeek",
  models: Object.keys(deepseekModels),
  apiKeyEnv: "DEEPSEEK_API_KEY",
  requiresApiKey: true,
  defaultMaxTokens: 8_192,
  // DeepSeek serves an OpenAI-compatible Chat Completions API. It caches
  // repeated prompt prefixes automatically; there is no setting for it.
  async create(modelId, { apiKey, maxTokens }) {
    const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
    const { apiModel, reasoning } = deepseekModels[modelId]!;
    const params =
      reasoning === "off"
        ? { thinking: { type: "disabled" } }
        : { thinking: { type: "enabled" }, reasoning_effort: reasoning };
    return new OpenAIModel({
      api: "chat",
      params,
      modelId: apiModel,
      maxTokens,
      apiKey: apiKey!,
      // deepseekFetch passes thinking back on tool-call turns, which DeepSeek requires.
      clientConfig: { baseURL: "https://api.deepseek.com", fetch: deepseekFetch() },
    });
  },
});

/** Every provider the benchmark can run against, keyed by name. */
export const modelProviders: Record<string, ModelProvider> = Object.fromEntries(
  [anthropic, bedrock, openai, google, deepseek].map((p) => [p.name, p]),
);

export const providers = Object.keys(modelProviders);

/** A model chosen as `<provider>:<model id>`, e.g. `anthropic:claude-opus-5`. */
export interface ModelSpec {
  provider: string;
  modelId: string;
}

/**
 * Parses `<provider>:<model id>` and checks the provider supports the model.
 * DeepSeek and named OpenAI and Anthropic models go by their name alone
 * (`ds-flash-reasoning-high`, `oa-luna-reasoning-xhigh`, `at-sonnet-high`); a
 * `deepseek:`, `openai:` or `anthropic:` prefix is accepted too. Only the first colon separates provider
 * and ID, so Bedrock IDs that contain colons (`...-v1:0`) work as-is.
 */
export function parseModelSpec(spec: string): ModelSpec {
  if (spec.trim() in deepseekModels) return { provider: deepseek.name, modelId: spec.trim() };
  if (spec.trim() in openaiModels) return { provider: openai.name, modelId: spec.trim() };
  if (spec.trim() in anthropicModels) return { provider: anthropic.name, modelId: spec.trim() };
  const sep = spec.indexOf(":");
  const provider = modelProviders[spec.slice(0, sep)];
  const modelId = spec.slice(sep + 1).trim();
  if (sep <= 0 || modelId === "" || provider === undefined) {
    throw new Error(
      `invalid model "${spec}": expected <provider>:<model id> with provider one of ${providers.join(", ")}, or a named model such as ds-flash-reasoning-high, oa-luna-reasoning-high or at-sonnet-high`,
    );
  }
  if (!provider.supports(modelId)) {
    throw new Error(`invalid model "${spec}": ${provider.label} supports ${provider.models!.join(", ")}`);
  }
  return { provider: provider.name, modelId };
}

/** `<provider>:<model id>`, or just the name for DeepSeek and named OpenAI and Anthropic models. */
export function formatModelSpec({ provider, modelId }: ModelSpec): string {
  const named =
    provider === deepseek.name ||
    (provider === openai.name && modelId in openaiModels) ||
    (provider === anthropic.name && modelId in anthropicModels);
  return named ? modelId : `${provider}:${modelId}`;
}

/**
 * Every listed model as a spec, e.g. `anthropic:claude-opus-5`,
 * `ds-flash-reasoning-high`, `oa-sol-reasoning-low`. Bedrock and Google list
 * none; OpenAI lists its named models.
 */
export function knownModelSpecs(): string[] {
  return Object.values(modelProviders).flatMap((p) => p.listed.map((modelId) => formatModelSpec({ provider: p.name, modelId })));
}

/**
 * Every listed model whose provider has its API key set: what runs when
 * neither `--model` nor FINREC_MODEL is given. Providers that list no models
 * (Bedrock, Google) are left out, since they need a model ID.
 */
export function availableModelSpecs(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.values(modelProviders)
    .filter((p) => hasApiKey({ provider: p.name, modelId: "" }, env))
    .flatMap((p) => p.listed.map((modelId) => formatModelSpec({ provider: p.name, modelId })));
}

/** Whether a model's provider has the API key it needs (Bedrock uses the AWS credential chain, so always does). */
export function hasApiKey({ provider }: ModelSpec, env: NodeJS.ProcessEnv = process.env): boolean {
  const p = modelProviders[provider]!;
  return p.apiKeyEnv === undefined || p.apiKey(env) !== undefined;
}

/**
 * Named groups of models for `--model`: `ds-flash` (or `dp-flash`) is every
 * ds-flash-reasoning-* model, `ds-v4pro` (or `ds-v4p`, `dp-v4pro`, `dp-v4p`)
 * every ds-v4p-reasoning-* one, `oa-luna` every oa-luna-reasoning-* one,
 * `oa-sol` every oa-sol-reasoning-* one, `at-haiku` every at-haiku-* one and
 * `at-sonnet` every at-sonnet-* one.
 */
export const modelFamilies: Readonly<Record<string, string[]>> = (() => {
  const family = (prefix: string) => [...Object.keys(deepseekModels), ...Object.keys(openaiModels), ...Object.keys(anthropicModels)].filter((m) => m.startsWith(`${prefix}-`));
  const flash = family("ds-flash");
  const v4pro = family("ds-v4p");
  return {
    "ds-flash": flash,
    "ds-v4pro": v4pro,
    "ds-v4p": v4pro,
    "dp-flash": flash,
    "dp-v4pro": v4pro,
    "dp-v4p": v4pro,
    "oa-luna": family("oa-luna"),
    "oa-sol": family("oa-sol"),
    "at-haiku": family("at-haiku"),
    "at-sonnet": family("at-sonnet"),
  };
})();

/**
 * Resolves one `--model` item: a valid spec selects that model, a family name
 * (see modelFamilies) its models, and anything else is a case-insensitive
 * regex over the listed models.
 */
export function resolveModels(pattern: string): ModelSpec[] {
  pattern = pattern.trim();
  const family = modelFamilies[pattern.toLowerCase()];
  if (family) return family.map(parseModelSpec);
  try {
    return [parseModelSpec(pattern)];
  } catch (err) {
    const matches = matchNames(pattern, knownModelSpecs());
    if (matches.length === 0) {
      throw new Error(`${err instanceof Error ? err.message : err}; as a pattern it matches none of: ${knownModelSpecs().join(", ")}`);
    }
    return matches.map(parseModelSpec);
  }
}

/**
 * Resolves a comma-separated `--model` list, e.g. `ds-flash,ds-v4pro` or
 * `ds-flash-reasoning-low,anthropic:claude-opus-5`; each model once, in order.
 */
export function resolveModelList(list: string): ModelSpec[] {
  const items = list.split(",").map((item) => item.trim()).filter((item) => item !== "");
  if (items.length === 0) throw new Error("no model given");
  const seen = new Map<string, ModelSpec>();
  for (const spec of items.flatMap(resolveModels)) seen.set(formatModelSpec(spec), spec);
  return [...seen.values()];
}

/** Creates the Strands model for a spec through its ModelProvider. */
export async function createModel(spec: string | ModelSpec, options: BuildOptions = {}): Promise<Model<BaseModelConfig>> {
  const { provider, modelId } = typeof spec === "string" ? parseModelSpec(spec) : spec;
  return modelProviders[provider]!.build(modelId, options);
}
