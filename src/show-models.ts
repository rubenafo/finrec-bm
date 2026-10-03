// Entry point for `npm run show-models`: lists the model providers, the models
// each supports, and whether its API key is set. Key values are never printed.

import { loadEnv } from "./common/env.js";
import { DEFAULT_JUDGE_MODEL } from "./common/judge.js";
import { DEFAULT_MODEL, formatModelSpec, modelProviders, parseModelSpec } from "./common/model.js";

loadEnv();
const defaultModel = formatModelSpec(parseModelSpec(process.env.FINREC_MODEL || DEFAULT_MODEL));
const judgeModel = formatModelSpec(parseModelSpec(process.env.FINREC_JUDGE_MODEL || DEFAULT_JUDGE_MODEL));

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
      const roles = [spec === defaultModel && "default", spec === judgeModel && "judge"].filter(Boolean);
      console.log(`  ${spec}${roles.length > 0 ? `  (${roles.join(", ")})` : ""}`);
    }
  }
  console.log();
}
