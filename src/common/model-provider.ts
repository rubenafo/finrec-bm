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
   * whose catalog varies by account or region (e.g. Bedrock).
   */
  models?: readonly string[];
  /** Environment variable (normally set in .env) holding the API key. */
  apiKeyEnv?: string;
  /**
   * Whether build() fails when the key isn't set. Leave false when the
   * provider SDK has other credential sources (AWS chain, login profiles).
   */
  requiresApiKey?: boolean;
  /** max_tokens used when the caller doesn't set one. */
  defaultMaxTokens?: number;
  /** Creates the Strands model; `apiKey` is undefined when not set. */
  create(
    modelId: string,
    settings: { apiKey: string | undefined; maxTokens: number },
  ): Promise<Model<BaseModelConfig>>;
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

  get apiKeyEnv(): string | undefined {
    return this.config.apiKeyEnv;
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
    return this.config.create(modelId, { apiKey, maxTokens });
  }
}
