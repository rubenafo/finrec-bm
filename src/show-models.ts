// Entry point for `npm run show-models`: lists the model providers, the models
// each supports, and whether its API key is set. Key values are never printed.

import { loadEnv } from "./common/env.js";
import { DEFAULT_MODEL, formatModelSpec, modelProviders, parseModelSpec } from "./common/model.js";

loadEnv();
const defaultModel = formatModelSpec(parseModelSpec(process.env.FINREC_MODEL || DEFAULT_MODEL));

for (const provider of Object.values(modelProviders)) {
  const key = provider.apiKeyEnv
    ? `${provider.apiKeyEnv} ${provider.apiKey() ? "set" : "missing"}`
    : "AWS credential chain";
  console.log(`${provider.label} (${provider.name})  [${key}]`);

  if (provider.models === undefined) {
    console.log(`  any model ID: --model ${provider.name}:<model id>`);
  } else {
    for (const modelId of provider.models) {
      const spec = formatModelSpec({ provider: provider.name, modelId });
      console.log(`  ${spec}${spec === defaultModel ? "  (default)" : ""}`);
    }
  }
  console.log();
}
