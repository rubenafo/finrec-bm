import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJudge, DEFAULT_JUDGE_MODEL, judgeModelSpec, parseVerdict } from "../src/common/judge.js";
import { ScriptedModel } from "./helpers/scripted-model.js";

const request = { task: "Validate 100.00.", reference: "A + B = 100.00", candidate: "A and B add up to 100." };

describe("parseVerdict", () => {
  it("reads the verdict JSON, also inside prose or a code fence", () => {
    assert.deepEqual(parseVerdict('{"score": 1, "rationale": "same"}'), { score: 1, rationale: "same" });
    assert.deepEqual(parseVerdict('Verdict:\n```json\n{"score": 0.5, "rationale": " partly "}\n```'), { score: 0.5, rationale: "partly" });
  });

  it("rejects missing JSON, scores other than 0, 0.5 or 1, and a missing rationale", () => {
    assert.throws(() => parseVerdict("looks right to me"), /no JSON object/);
    assert.throws(() => parseVerdict('{"score": 0.7, "rationale": "x"}'), /0, 0.5 or 1/);
    assert.throws(() => parseVerdict('{"score": "1", "rationale": "x"}'), /0, 0.5 or 1/);
    assert.throws(() => parseVerdict('{"score": 1}'), /rationale/);
  });
});

describe("createJudge", () => {
  it("sends the task, reference and candidate, and returns the verdict", async () => {
    const model = new ScriptedModel([{ text: '{"score": 1, "rationale": "Same records and sum."}' }]);
    const judge = await createJudge(model);
    assert.deepEqual(await judge(request), {
      score: 1,
      rationale: "Same records and sum.",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 6 },
    });
    const sent = JSON.stringify(model.received[0]);
    for (const part of Object.values(request)) assert.ok(sent.includes(part), part);
  });

  it("retries once when the reply isn't a valid verdict", async () => {
    const model = new ScriptedModel([{ text: "I think it's fine." }, { text: '{"score": 0, "rationale": "Wrong sum."}' }]);
    assert.deepEqual(await (await createJudge(model))(request), {
      score: 0,
      rationale: "Wrong sum.",
      usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 12 },
    });
    assert.equal(model.calls, 2);
  });

  it("fails after two invalid replies", async () => {
    const model = new ScriptedModel([{ text: '{"score": 2, "rationale": "x"}' }]);
    await assert.rejects((await createJudge(model))(request), /judge failed: .*0, 0.5 or 1/);
    assert.equal(model.calls, 2);
  });

  it("answers an identical request from the cache, at no token cost", async () => {
    const model = new ScriptedModel([{ text: '{"score": 1, "rationale": "ok"}' }]);
    const judge = await createJudge(model);
    await judge(request);
    assert.deepEqual(await judge({ ...request }), { score: 1, rationale: "ok", usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } });
    assert.equal(model.calls, 1);
    await judge({ ...request, candidate: "different" });
    assert.equal(model.calls, 2);
  });

  it("starts a fresh conversation for every request", async () => {
    const model = new ScriptedModel([{ text: '{"score": 1, "rationale": "ok"}' }]);
    const judge = await createJudge(model);
    await judge(request);
    await judge({ ...request, candidate: "something else" });
    assert.equal(model.received[1]!.length, 1, "the second request carries no earlier messages");
  });
});

describe("judge model", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    delete process.env.FINREC_JUDGE_MODEL;
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterEach(() => {
    process.env = saved;
  });

  it("defaults to DeepSeek flash, overridable with FINREC_JUDGE_MODEL", () => {
    assert.equal(DEFAULT_JUDGE_MODEL, "ds-flash-reasoning-off");
    assert.deepEqual(judgeModelSpec(), { provider: "deepseek", modelId: "ds-flash-reasoning-off" });
    assert.deepEqual(judgeModelSpec({ FINREC_JUDGE_MODEL: "anthropic:claude-opus-5" }), { provider: "anthropic", modelId: "claude-opus-5" });
  });

  it("needs the DeepSeek key for the default judge", async () => {
    await assert.rejects(createJudge(), /set DEEPSEEK_API_KEY in \.env/);
    process.env.DEEPSEEK_API_KEY = "test";
    await createJudge();
  });
});
