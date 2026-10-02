import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadEnv } from "../src/common/env.js";
import { DEFAULT_MODEL, createModel, modelProviders, parseModelSpec, providers } from "../src/common/model.js";

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
    assert.deepEqual(parseModelSpec(DEFAULT_MODEL), { provider: "anthropic", modelId: "claude-opus-5" });
    assert.deepEqual(parseModelSpec("bedrock:vendor.model-v1:0"), { provider: "bedrock", modelId: "vendor.model-v1:0" });
    assert.deepEqual(parseModelSpec("deepseek:deepseek-v4-pro"), { provider: "deepseek", modelId: "deepseek-v4-pro" });
  });

  it("rejects unknown providers, missing IDs and unsupported models", () => {
    for (const spec of ["claude-opus-5", "acme:model", "openai:", ":gpt"]) {
      assert.throws(() => parseModelSpec(spec), /expected <provider>:<model id>/, spec);
    }
    assert.throws(() => parseModelSpec("deepseek:deepseek-chat"), /DeepSeek supports deepseek-flash, deepseek-v4-pro/);
    assert.throws(() => parseModelSpec("anthropic:claude-2"), /Anthropic supports claude-fable-5-1/);
  });
});

describe("ModelProvider", () => {
  it("describes DeepSeek's models and API key", () => {
    const deepseek = modelProviders.deepseek!;
    assert.equal(deepseek.label, "DeepSeek");
    assert.deepEqual(deepseek.models, ["deepseek-flash", "deepseek-v4-pro"]);
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
      "deepseek:deepseek-flash",
      "deepseek:deepseek-v4-pro",
    ]) {
      const model = await createModel(spec);
      assert.equal(model.getConfig().modelId, parseModelSpec(spec).modelId, spec);
    }
  });

  it("fails clearly when a required API key is missing", async () => {
    await assert.rejects(createModel("deepseek:deepseek-flash"), /DeepSeek needs an API key: set DEEPSEEK_API_KEY in \.env/);
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
      await createModel("deepseek:deepseek-v4-pro");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
