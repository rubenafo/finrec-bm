import type { BaseModelConfig, Model } from "@strands-agents/sdk";
import { deepseekFetch } from "./deepseek-fetch.js";
import { ModelProvider, type BuildOptions } from "./model-provider.js";

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

const deepseek = new ModelProvider({
  name: "deepseek",
  label: "DeepSeek",
  models: ["deepseek-flash", "deepseek-v4-pro"],
  apiKeyEnv: "DEEPSEEK_API_KEY",
  requiresApiKey: true,
  defaultMaxTokens: 8_192,
  // DeepSeek serves an OpenAI-compatible Chat Completions API.
  async create(modelId, { apiKey, maxTokens, thinking }) {
    const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
    return new OpenAIModel({
      api: "chat",
      ...(!thinking && { params: { thinking: { type: "disabled" } } }),
      modelId,
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
 * Only the first colon separates the two, so Bedrock IDs that contain colons
 * (`...-v1:0`) work as-is.
 */
export function parseModelSpec(spec: string): ModelSpec {
  const sep = spec.indexOf(":");
  const provider = modelProviders[spec.slice(0, sep)];
  const modelId = spec.slice(sep + 1).trim();
  if (sep <= 0 || modelId === "" || provider === undefined) {
    throw new Error(
      `invalid model "${spec}": expected <provider>:<model id> with provider one of ${providers.join(", ")}`,
    );
  }
  if (!provider.supports(modelId)) {
    throw new Error(`invalid model "${spec}": ${provider.label} supports ${provider.models!.join(", ")}`);
  }
  return { provider: provider.name, modelId };
}

export function formatModelSpec({ provider, modelId }: ModelSpec): string {
  return `${provider}:${modelId}`;
}

/** Creates the Strands model for a spec through its ModelProvider. */
export async function createModel(spec: string | ModelSpec, options: BuildOptions = {}): Promise<Model<BaseModelConfig>> {
  const { provider, modelId } = typeof spec === "string" ? parseModelSpec(spec) : spec;
  return modelProviders[provider]!.build(modelId, options);
}
