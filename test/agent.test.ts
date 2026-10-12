import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  ModelMetadataEvent,
  ModelThrottledError,
  type Message,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import { buildScreenshot } from "../scripts/screenshot-writer.js";
import { runAgent, strandsLogger, toUsage } from "../src/common/agent.js";
import { tools, type CaseContext } from "../src/tools/index.js";
import { ScriptedModel } from "./helpers/scripted-model.js";

const tmp = mkdtempSync(join(tmpdir(), "finrec-agent-"));
let ctx: CaseContext & { close(): void };

before(async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const ledger = await instance.connect();
  await ledger.run("CREATE TABLE ledger AS SELECT 'L-001' AS entry_id, 100.00::DECIMAL(18,2) AS amount");
  mkdirSync(join(tmp, "evidence"));
  writeFileSync(join(tmp, "evidence", "bank_statement.csv"), "id,amount\nB-001,100.00\n");
  ctx = {
    test: "t",
    caseId: "c1",
    evidenceDir: join(tmp, "evidence"),
    db: ledger,
    close() {
      ledger.closeSync();
      instance.closeSync();
    },
  };
});

after(() => {
  ctx.close();
  rmSync(tmp, { recursive: true, force: true });
});

const answer = JSON.stringify({ matches: [{ source: ["B-001"], ledger: ["L-001"] }], unmatched: [] });
const allTools = Object.values(tools);

describe("runAgent", () => {
  it("runs tools against the case and returns the final answer", async () => {
    const model = new ScriptedModel([
      { tool: "read_text_file", input: { paths: ["bank_statement.csv"] } },
      { tool: "query_ledger", input: { queries: ["SELECT * FROM ledger", "SELECT nope"] } },
      { tool: "read_text_file", input: { paths: ["../secret.txt"] } },
      { text: answer },
    ]);
    const run = await runAgent({ model, systemPrompt: "sys", prompt: "go", tools: allTools, ctx, maxTurns: 10 });

    assert.equal(run.text, answer);
    assert.equal(run.turns, 4);
    assert.equal(run.turnLimitReached, false);
    assert.deepEqual(
      run.toolCalls.map((c) => [c.name, c.error === undefined, c.failedItems]),
      [
        ["read_text_file", true, undefined],
        ["query_ledger", true, [2]], // the batch returned, with its second query failed in place
        ["read_text_file", false, undefined],
      ],
    );
    assert.deepEqual(run.usage, { inputTokens: 40, outputTokens: 20, cachedInputTokens: 24, cacheWriteInputTokens: 0 });
  });

  it("sends an image a tool returns to the model, after the tool's text", async () => {
    const png = buildScreenshot({ sheet: { name: "s", rows: [["x"]] } });
    writeFileSync(join(tmp, "evidence", "shot.png"), png);
    const model = new ScriptedModel([{ tool: "read_image_file", input: { path: "evidence/shot.png" } }, { text: answer }]);
    const run = await runAgent({ model, systemPrompt: "sys", prompt: "go", tools: allTools, ctx, maxTurns: 10 });

    assert.deepEqual(run.toolCalls, [{ name: "read_image_file", input: { path: "evidence/shot.png" } }]);
    const result = model.received[1]!.flatMap((m) => m.content).find((b) => b.type === "toolResultBlock");
    assert.ok(result?.type === "toolResultBlock");
    assert.deepEqual(result.content.map((c) => c.type), ["textBlock", "imageBlock"]);
    const [text, image] = result.content;
    assert.match(text?.type === "textBlock" ? text.text : "", /^evidence\/shot\.png: image file, PNG, \d+x\d+ pixels$/);
    assert.ok(image?.type === "imageBlock" && image.format === "png" && image.source.type === "imageSourceBytes");
    assert.ok(Buffer.from(image.source.bytes).equals(png));
  });

  it("keeps Strands' warnings, but for the one about moving a tool result's images to a user message", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    strandsLogger.warn("tool_call_id=<call_01> | moving images from tool result to separate user message for openai compatibility");
    strandsLogger.warn("something else");
    assert.deepEqual(warn.mock.calls.map((c) => c.arguments), [["something else"]]);
  });

  it("shows Strands' note that it dropped a server-side tool block, and no other debug output", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    strandsLogger.debug("block_type=<server_tool_use> | skipping server-side tool block");
    strandsLogger.debug("anything else");
    assert.deepEqual(warn.mock.calls.map((c) => c.arguments), [["block_type=<server_tool_use> | skipping server-side tool block"]]);
  });

  it("counts cached tokens as part of the input, adding them back for providers that report them apart", () => {
    const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadInputTokens: 800, cacheWriteInputTokens: 50 };
    assert.deepEqual(toUsage(usage, true), { inputTokens: 950, outputTokens: 20, cachedInputTokens: 800, cacheWriteInputTokens: 50 });
    assert.deepEqual(toUsage(usage, false), { inputTokens: 100, outputTokens: 20, cachedInputTokens: 800, cacheWriteInputTokens: 50 });
    assert.deepEqual(toUsage(undefined, true), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
  });

  it("records each request's usage and time, and keeps them when the run fails", async () => {
    // The second request reports its usage, then fails as at the token limit.
    class FailingModel extends ScriptedModel {
      override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
        if (this.calls === 1) {
          this.calls++;
          yield new ModelMetadataEvent({ type: "modelMetadataEvent", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
          throw new Error("Model reached maximum token limit");
        }
        yield* super.stream(messages);
      }
    }
    const model = new FailingModel([{ tool: "query_ledger", input: { queries: ["SELECT 1"] } }]);
    const run = await runAgent({ model, systemPrompt: "sys", prompt: "go", tools: allTools, ctx, maxTurns: 10 });

    assert.equal(run.error, "Model reached maximum token limit");
    assert.equal(run.text, "");
    assert.equal(run.toolCalls.length, 1);
    assert.deepEqual(
      run.requests.map(({ at, ...usage }) => (assert.ok(!Number.isNaN(Date.parse(at)), at), usage)),
      [
        { inputTokens: 10, outputTokens: 5, cachedInputTokens: 6, cacheWriteInputTokens: 0 },
        { inputTokens: 7, outputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      ],
    );
    assert.deepEqual(run.usage, { inputTokens: 17, outputTokens: 8, cachedInputTokens: 6, cacheWriteInputTokens: 0 });
    assert.equal(model.stream, FailingModel.prototype.stream, "the model's own stream is back");
  });

  it("doesn't count a throttled request that Strands retries as a turn", { timeout: 30_000 }, async () => {
    class ThrottledOnceModel extends ScriptedModel {
      throttled = false;
      override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
        if (!this.throttled) {
          this.throttled = true;
          throw new ModelThrottledError("429 rate limit");
        }
        yield* super.stream(messages);
      }
    }
    const model = new ThrottledOnceModel([{ tool: "query_ledger", input: { queries: ["SELECT 1"] } }, { text: answer }]);
    const run = await runAgent({ model, systemPrompt: "sys", prompt: "go", tools: allTools, ctx, maxTurns: 2 });

    assert.equal(run.error, undefined);
    assert.equal(run.turnLimitReached, false, "the retry didn't use up one of the 2 turns");
    assert.equal(run.turns, 2);
    assert.equal(run.text, answer);
  });

  /** A model whose first `bad` replies stop for tool use but carry only text, as Claude Sonnet 5.5 once did. */
  class EmptyToolUseModel extends ScriptedModel {
    constructor(steps: ConstructorParameters<typeof ScriptedModel>[0], private bad: number) {
      super(steps);
    }
    override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
      if (this.bad === 0) return yield* super.stream(messages);
      this.bad--;
      yield new ModelMessageStartEvent({ type: "modelMessageStartEvent", role: "assistant" });
      yield new ModelContentBlockStartEvent({ type: "modelContentBlockStartEvent" });
      yield new ModelContentBlockDeltaEvent({ type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text: "Let me add these." } });
      yield new ModelContentBlockStopEvent({ type: "modelContentBlockStopEvent" });
      yield new ModelMessageStopEvent({ type: "modelMessageStopEvent", stopReason: "toolUse" });
      yield new ModelMetadataEvent({ type: "modelMetadataEvent", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    }
  }

  it("asks again after a reply that stops for tool use without a tool call", async (t) => {
    t.mock.method(console, "warn", () => {});
    const model = new EmptyToolUseModel([{ tool: "query_ledger", input: { queries: ["SELECT 1"] } }, { text: answer }], 1);
    const run = await runAgent({ model, systemPrompt: "sys", prompt: "go", tools: allTools, ctx, maxTurns: 10 });

    assert.equal(run.error, undefined);
    assert.equal(run.text, answer);
    assert.equal(run.toolCalls.length, 1);
    assert.equal(run.turns, 3, "the dropped reply was a model call");
    assert.equal(run.requests.length, 3);
  });

  it("gives up after two such replies in a run", async (t) => {
    t.mock.method(console, "warn", () => {});
    const model = new EmptyToolUseModel([{ text: answer }], 3);
    const run = await runAgent({ model, systemPrompt: "sys", prompt: "go", tools: allTools, ctx, maxTurns: 10 });

    assert.match(run.error ?? "", /no tool use blocks found/);
    assert.equal(run.turns, 3);
  });

  it("stops at maxTurns", async () => {
    const model = new ScriptedModel([{ tool: "query_ledger", input: { queries: ["SELECT 1"] } }]);
    const run = await runAgent({ model, systemPrompt: "sys", prompt: "go", tools: allTools, ctx, maxTurns: 3 });

    assert.equal(run.turnLimitReached, true);
    assert.equal(run.turns, 3);
    assert.equal(model.calls, 3);
  });
});
