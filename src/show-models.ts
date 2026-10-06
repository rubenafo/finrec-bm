// Entry point for `npm run show-models`: lists the model providers, the models
// each supports, and whether its API key is set. Key values are never printed.

import { loadEnv } from "./common/env.js";
import { availableModelSpecs, formatModelSpec, modelProviders, resolveModelList } from "./common/model.js";

loadEnv();
// What `npm run benchmark` runs without --model: FINREC_MODEL, else every
// listed model whose API key is set.
const defaults = new Set(
  process.env.FINREC_MODEL ? resolveModelList(process.env.FINREC_MODEL).map(formatModelSpec) : availableModelSpecs(),
);

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
      console.log(`  ${spec}${defaults.has(spec) ? "  (default)" : ""}`);
    }
  }
  console.log();
}
