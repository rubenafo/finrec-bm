import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadEnv } from "../src/common/env.js";
import { availableModelSpecs, createModel, deepseekModels, formatModelSpec, knownModelSpecs, modelProviders, parseModelSpec, providers, resolveModelList, resolveModels } from "../src/common/model.js";
import { matchNames } from "../src/common/pattern.js";

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "AWS_REGION"];
let saved: NodeJS.ProcessEnv;

// Tests control the API keys themselves; the real .env is never loaded here.
beforeEach(() => {
  saved = { ...process.env };
  for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
  process.env = saved;
});

describe("model specs", () => {
  it("lists the providers", () => {
    assert.deepEqual(providers, ["anthropic", "bedrock", "openai", "google", "deepseek"]);
  });

  it("parses provider and model ID, keeping colons in the ID", () => {
    assert.deepEqual(parseModelSpec("anthropic:claude-opus-5"), { provider: "anthropic", modelId: "claude-opus-5" });
    assert.deepEqual(parseModelSpec("bedrock:vendor.model-v1:0"), { provider: "bedrock", modelId: "vendor.model-v1:0" });
    assert.deepEqual(parseModelSpec("ds-v4p-reasoning-max"), { provider: "deepseek", modelId: "ds-v4p-reasoning-max" });
    assert.deepEqual(parseModelSpec("deepseek:ds-v4p-reasoning-max"), { provider: "deepseek", modelId: "ds-v4p-reasoning-max" });
  });

  it("defaults to every listed model whose API key is set", () => {
    assert.deepEqual(availableModelSpecs({}), []);
    assert.deepEqual(availableModelSpecs({ DEEPSEEK_API_KEY: "k", OPENAI_API_KEY: "k" }), Object.keys(deepseekModels));
    const both = availableModelSpecs({ ANTHROPIC_API_KEY: "k", DEEPSEEK_API_KEY: "k" });
    assert.deepEqual(both, knownModelSpecs());
    assert.ok(both.includes("anthropic:claude-opus-5") && both.includes("ds-flash-reasoning-off"));
    assert.deepEqual(availableModelSpecs({ ANTHROPIC_API_KEY: "", DEEPSEEK_API_KEY: "k" }).length, 8, "blank keys are unset");
  });

  it("formats DeepSeek models without the provider prefix", () => {
    assert.equal(formatModelSpec({ provider: "deepseek", modelId: "ds-flash-reasoning-off" }), "ds-flash-reasoning-off");
    assert.equal(formatModelSpec({ provider: "anthropic", modelId: "claude-opus-5" }), "anthropic:claude-opus-5");
  });

  it("rejects unknown providers, missing IDs and unsupported models", () => {
    for (const spec of ["claude-opus-5", "acme:model", "openai:", ":gpt"]) {
      assert.throws(() => parseModelSpec(spec), /expected <provider>:<model id>/, spec);
    }
    assert.throws(() => parseModelSpec("deepseek:deepseek-flash"), /DeepSeek supports ds-flash-reasoning-off, ds-flash-reasoning-low/);
    assert.throws(() => parseModelSpec("anthropic:claude-2"), /Anthropic supports claude-fable-5-1/);
  });
});

describe("model selection", () => {
  const ids = (pattern: string) => resolveModels(pattern).map(formatModelSpec);

  it("selects one model for a valid spec, including providers without a model list", () => {
    assert.deepEqual(ids("ds-flash-reasoning-high"), ["ds-flash-reasoning-high"]);
    assert.deepEqual(ids("openai:gpt-5"), ["openai:gpt-5"]);
  });

  it("matches anything else as a regex over the listed models", () => {
    assert.deepEqual(ids("ds-flash"), ["ds-flash-reasoning-off", "ds-flash-reasoning-low", "ds-flash-reasoning-high", "ds-flash-reasoning-max"]);
    assert.deepEqual(ids("ds-v4p"), ["ds-v4p-reasoning-off", "ds-v4p-reasoning-low", "ds-v4p-reasoning-high", "ds-v4p-reasoning-max"]);
    assert.deepEqual(ids("ds-.*-(high|max)$"), ["ds-flash-reasoning-high", "ds-flash-reasoning-max", "ds-v4p-reasoning-high", "ds-v4p-reasoning-max"]);
    assert.deepEqual(ids("anthropic:claude-opus-5"), ["anthropic:claude-opus-5"]);
    assert.deepEqual(ids("opus-5"), ["anthropic:claude-opus-5-5", "anthropic:claude-opus-5"]);
  });

  it("selects a family's models: ds-flash, ds-v4pro and its short form ds-v4p", () => {
    const v4pro = ["ds-v4p-reasoning-off", "ds-v4p-reasoning-low", "ds-v4p-reasoning-high", "ds-v4p-reasoning-max"];
    assert.deepEqual(ids("ds-v4pro"), v4pro);
    assert.deepEqual(ids("DS-V4PRO"), v4pro);
    assert.deepEqual(ids("ds-v4p"), v4pro);
  });

  it("selects the same families under their dp- names: dp-flash, dp-v4pro and dp-v4p", () => {
    assert.deepEqual(ids("dp-flash"), ids("ds-flash"));
    assert.deepEqual(ids("dp-flash").length, 4);
    assert.deepEqual(ids("dp-v4p"), ids("ds-v4p"));
    assert.deepEqual(ids("DP-V4PRO"), ids("ds-v4p"));
  });

  it("takes a comma-separated list of families, names and patterns, each model once", () => {
    const list = (value: string) => resolveModelList(value).map(formatModelSpec);
    assert.deepEqual(list("ds-flash, ds-v4pro").length, 8);
    assert.deepEqual(list("ds-flash-reasoning-low,anthropic:claude-opus-5"), ["ds-flash-reasoning-low", "anthropic:claude-opus-5"]);
    assert.deepEqual(list("ds-flash-reasoning-max,ds-flash,"), ["ds-flash-reasoning-max", "ds-flash-reasoning-off", "ds-flash-reasoning-low", "ds-flash-reasoning-high"]);
    assert.throws(() => resolveModelList(" , "), /no model given/);
    assert.throws(() => resolveModelList("ds-flash,gpt"), /matches none of/);
  });

  it("fails when the pattern matches no listed model", () => {
    assert.throws(() => resolveModels("gpt"), /matches none of: anthropic:claude-fable-5-1/);
    assert.throws(() => resolveModels("ds-(flash"), /invalid pattern/);
  });

  it("lists every model with a model list", () => {
    assert.ok(knownModelSpecs().includes("anthropic:claude-opus-5"));
    assert.ok(knownModelSpecs().includes("ds-v4p-reasoning-low"));
  });
});

describe("matchNames", () => {
  const tests = ["csv-matching", "txt-matching"];

  it("prefers an exact name, else matches a case-insensitive regex", () => {
    assert.deepEqual(matchNames("txt-matching", tests), ["txt-matching"]);
    assert.deepEqual(matchNames("MATCHING", tests), tests);
    assert.deepEqual(matchNames("csv", tests), ["csv-matching"]);
    assert.deepEqual(matchNames("pdf", tests), []);
  });
});

describe("ModelProvider", () => {
  it("describes DeepSeek's models and API key", () => {
    const deepseek = modelProviders.deepseek!;
    assert.equal(deepseek.label, "DeepSeek");
    assert.deepEqual(deepseek.models, [
      "ds-flash-reasoning-off",
      "ds-flash-reasoning-low",
      "ds-flash-reasoning-high",
      "ds-flash-reasoning-max",
      "ds-v4p-reasoning-off",
      "ds-v4p-reasoning-low",
      "ds-v4p-reasoning-high",
      "ds-v4p-reasoning-max",
    ]);
    assert.equal(deepseek.apiKeyEnv, "DEEPSEEK_API_KEY");
  });

  it("reads the API key from the environment, treating blank as unset", () => {
    const openai = modelProviders.openai!;
    assert.equal(openai.apiKey({ OPENAI_API_KEY: "" }), undefined);
    assert.equal(openai.apiKey({ OPENAI_API_KEY: "k" }), "k");
    assert.equal(modelProviders.bedrock!.apiKey({}), undefined);
  });

  it("builds a Strands model for every provider without calling it", async () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "test",
      OPENAI_API_KEY: "test",
      GEMINI_API_KEY: "test",
      DEEPSEEK_API_KEY: "test",
      AWS_REGION: "us-east-1",
    });
    for (const spec of [
      "anthropic:claude-opus-5",
      "bedrock:any-model",
      "openai:any-model",
      "google:any-model",
    ]) {
      const model = await createModel(spec);
      assert.equal(model.getConfig().modelId, parseModelSpec(spec).modelId, spec);
    }
  });

  it("maps DeepSeek names to the API model and reasoning setting", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const cases: [string, string, unknown][] = [
      ["ds-flash-reasoning-off", "deepseek-flash", { thinking: { type: "disabled" } }],
      ["ds-flash-reasoning-low", "deepseek-flash", { thinking: { type: "enabled" }, reasoning_effort: "low" }],
      ["ds-flash-reasoning-high", "deepseek-flash", { thinking: { type: "enabled" }, reasoning_effort: "high" }],
      ["ds-flash-reasoning-max", "deepseek-flash", { thinking: { type: "enabled" }, reasoning_effort: "max" }],
      ["ds-v4p-reasoning-off", "deepseek-v4-pro", { thinking: { type: "disabled" } }],
      ["ds-v4p-reasoning-low", "deepseek-v4-pro", { thinking: { type: "enabled" }, reasoning_effort: "low" }],
      ["ds-v4p-reasoning-high", "deepseek-v4-pro", { thinking: { type: "enabled" }, reasoning_effort: "high" }],
      ["ds-v4p-reasoning-max", "deepseek-v4-pro", { thinking: { type: "enabled" }, reasoning_effort: "max" }],
    ];
    for (const [name, apiModel, params] of cases) {
      const config = (await createModel(name)).getConfig() as { modelId: string; params?: unknown };
      assert.equal(config.modelId, apiModel, name);
      assert.deepEqual(config.params, params, name);
    }
  });

  it("fails clearly when a required API key is missing", async () => {
    await assert.rejects(createModel("ds-flash-reasoning-high"), /DeepSeek needs an API key: set DEEPSEEK_API_KEY in \.env/);
    await assert.rejects(createModel("openai:any-model"), /set OPENAI_API_KEY in \.env/);
    await assert.rejects(createModel("anthropic:claude-opus-5"), /set ANTHROPIC_API_KEY in \.env/);
  });

  it("doesn't require a key for Bedrock, which uses the AWS credential chain", async () => {
    await createModel("bedrock:any-model");
  });

  it("picks up keys from a .env file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "finrec-env-"));
    try {
      writeFileSync(join(dir, ".env"), "DEEPSEEK_API_KEY=from-file\nOPENAI_API_KEY=\n");
      loadEnv(join(dir, ".env"));
      assert.equal(modelProviders.deepseek!.apiKey(), "from-file");
      assert.equal(modelProviders.openai!.apiKey(), undefined);
      await createModel("ds-v4p-reasoning-high");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
