import type { BaseModelConfig, Model } from "@strands-agents/sdk";

export interface BuildOptions {
  maxTokens?: number;
}

export interface ModelProviderConfig {
  /** Name used in model specs: `<name>:<model id>`. */
  name: string;
  /** Human-readable provider name. */
  label: string;
  /**
   * Model IDs this provider supports. Omit to accept any ID, for providers
   * whose catalog changes often (e.g. OpenAI, Google).
   */
  models?: readonly string[];
  /**
   * For a provider that accepts any ID: named models to list for selection
   * (in knownModelSpecs, regexes and the default run) all the same.
   */
  listedModels?: readonly string[];
  /** Environment variable (normally set in .env) holding the API key. */
  apiKeyEnv?: string;
  /**
   * Whether build() fails when the key isn't set. Leave false when the
   * provider SDK has other credential sources (AWS chain, login profiles).
   */
  requiresApiKey?: boolean;
  /**
   * Whether the reported input tokens leave out cache reads and writes, as
   * the Anthropic Messages API's `input_tokens` does; runAgent adds them back.
   */
  inputTokensExcludeCache?: boolean;
  /** max_tokens used when the caller doesn't set one. */
  defaultMaxTokens?: number;
  /** Creates the Strands model; `apiKey` is undefined when not set. */
  create(
    modelId: string,
    settings: { apiKey: string | undefined; maxTokens: number },
  ): Promise<Model<BaseModelConfig>>;
}

/** Models built by a provider whose input tokens leave out the cached ones; see reportsCacheApart. */
const cacheApart = new WeakSet<object>();

/**
 * Whether a model's reported input tokens leave out cache reads and writes
 * (built by a provider with inputTokensExcludeCache, e.g. Anthropic). Marked on
 * the model itself, so it holds however the model reaches the agent.
 */
export function reportsCacheApart(model: object): boolean {
  return cacheApart.has(model);
}

/**
 * A model provider the benchmark can run against: which models it supports,
 * where its API key comes from, and how to build a Strands model for it.
 *
 * API keys are read from process.env; call loadEnv() first to pick them up
 * from the repo's .env file (`npm run benchmark` does this at startup).
 */
export class ModelProvider {
  constructor(private readonly config: ModelProviderConfig) {}

  get name(): string {
    return this.config.name;
  }

  get label(): string {
    return this.config.label;
  }

  /** Supported model IDs, or undefined when any ID is accepted. */
  get models(): readonly string[] | undefined {
    return this.config.models;
  }

  /** The models listed for selection: the supported ones, or the named ones of a provider that accepts any ID. */
  get listed(): readonly string[] {
    return this.config.models ?? this.config.listedModels ?? [];
  }

  get apiKeyEnv(): string | undefined {
    return this.config.apiKeyEnv;
  }

  get inputTokensExcludeCache(): boolean {
    return this.config.inputTokensExcludeCache ?? false;
  }

  supports(modelId: string): boolean {
    return this.config.models === undefined || this.config.models.includes(modelId);
  }

  /** The API key from the environment, or undefined when unset or blank. */
  apiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const key = this.config.apiKeyEnv && env[this.config.apiKeyEnv];
    return key || undefined;
  }

  /** Builds a Strands model for `modelId`, checking support and credentials first. */
  async build(modelId: string, options: BuildOptions = {}): Promise<Model<BaseModelConfig>> {
    if (!this.supports(modelId)) {
      throw new Error(
        `${this.label} doesn't support model "${modelId}"; supported: ${this.config.models!.join(", ")}`,
      );
    }
    const apiKey = this.apiKey();
    if (this.config.requiresApiKey && apiKey === undefined) {
      throw new Error(`${this.label} needs an API key: set ${this.config.apiKeyEnv} in .env`);
    }
    const maxTokens = options.maxTokens ?? this.config.defaultMaxTokens ?? 16_000;
    const model = await this.config.create(modelId, { apiKey, maxTokens });
    if (this.inputTokensExcludeCache) cacheApart.add(model);
    return model;
  }
}
