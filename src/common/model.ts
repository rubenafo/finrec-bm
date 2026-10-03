import type { BaseModelConfig, Model } from "@strands-agents/sdk";
import { deepseekFetch } from "./deepseek-fetch.js";
import { ModelProvider, type BuildOptions } from "./model-provider.js";
import { matchNames } from "./pattern.js";

// Provider modules are imported on demand so only the chosen SDK is loaded.

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
  ],
  apiKeyEnv: "ANTHROPIC_API_KEY",
  requiresApiKey: true,
  async create(modelId, { apiKey, maxTokens }) {
    const { AnthropicModel } = await import("@strands-agents/sdk/models/anthropic");
    return new AnthropicModel({ modelId, maxTokens, apiKey: apiKey! });
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

const openai = new ModelProvider({
  name: "openai",
  label: "OpenAI",
  apiKeyEnv: "OPENAI_API_KEY",
  requiresApiKey: true,
  async create(modelId, { apiKey, maxTokens }) {
    const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
    return new OpenAIModel({ modelId, maxTokens, apiKey: apiKey! });
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
  // DeepSeek serves an OpenAI-compatible Chat Completions API.
  async create(modelId, { apiKey, maxTokens, thinking }) {
    const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
    const { apiModel, reasoning } = deepseekModels[modelId]!;
    // The caller can still force thinking off (the judge does).
    const params =
      !thinking || reasoning === "off"
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

/** Used when neither `--model` nor FINREC_MODEL is given. */
export const DEFAULT_MODEL = "anthropic:claude-opus-5";

/**
 * Parses `<provider>:<model id>` and checks the provider supports the model.
 * DeepSeek models are named on their own (`ds-flash-reasoning-high`); a
 * `deepseek:` prefix is accepted too. Only the first colon separates provider
 * and ID, so Bedrock IDs that contain colons (`...-v1:0`) work as-is.
 */
export function parseModelSpec(spec: string): ModelSpec {
  if (spec.trim() in deepseekModels) return { provider: deepseek.name, modelId: spec.trim() };
  const sep = spec.indexOf(":");
  const provider = modelProviders[spec.slice(0, sep)];
  const modelId = spec.slice(sep + 1).trim();
  if (sep <= 0 || modelId === "" || provider === undefined) {
    throw new Error(
      `invalid model "${spec}": expected <provider>:<model id> with provider one of ${providers.join(", ")}, or a DeepSeek model such as ds-flash-reasoning-high`,
    );
  }
  if (!provider.supports(modelId)) {
    throw new Error(`invalid model "${spec}": ${provider.label} supports ${provider.models!.join(", ")}`);
  }
  return { provider: provider.name, modelId };
}

/** `<provider>:<model id>`, or just the name for DeepSeek models. */
export function formatModelSpec({ provider, modelId }: ModelSpec): string {
  return provider === deepseek.name ? modelId : `${provider}:${modelId}`;
}

/** Every listed model as a spec, e.g. `anthropic:claude-opus-5`, `ds-flash-reasoning-high`. Bedrock, OpenAI and Google list none. */
export function knownModelSpecs(): string[] {
  return Object.values(modelProviders).flatMap((p) =>
    (p.models ?? []).map((modelId) => formatModelSpec({ provider: p.name, modelId })),
  );
}

/**
 * Named groups of models for `--model`: `ds-flash` is every
 * ds-flash-reasoning-* model, `ds-v4pro` (or `ds-v4p`) every ds-v4p-reasoning-* one.
 */
export const modelFamilies: Readonly<Record<string, string[]>> = (() => {
  const family = (prefix: string) => Object.keys(deepseekModels).filter((m) => m.startsWith(`${prefix}-`));
  return { "ds-flash": family("ds-flash"), "ds-v4pro": family("ds-v4p"), "ds-v4p": family("ds-v4p") };
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
