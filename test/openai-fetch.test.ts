import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Message, TextBlock, type ModelStreamEvent } from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { cacheWriteRecorder } from "../src/common/openai-fetch.js";

/** A Responses API stream: one text reply, then `response.completed` with the given usage. */
const responsesStream = (usage: object) =>
  new Response(
    [
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
      { type: "response.completed", response: { id: "resp_1", status: "completed", usage } },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

/** The usage event of one request through Strands' OpenAI model, wrapped as model.ts wraps it. */
async function usageOf(response: Response) {
  const writes = cacheWriteRecorder((async () => response) as typeof fetch);
  class Model extends OpenAIModel {
    override stream(...args: Parameters<OpenAIModel["stream"]>) {
      return writes.withCacheWrites(super.stream(...args));
    }
  }
  const model = new Model({ modelId: "gpt-6-luna", apiKey: "k", clientConfig: { baseURL: "http://localhost", fetch: writes.fetch } });
  let usage: Extract<ModelStreamEvent, { type: "modelMetadataEvent" }>["usage"];
  for await (const event of model.stream([new Message({ role: "user", content: [new TextBlock("hi")] })])) {
    if (event.type === "modelMetadataEvent") usage = event.usage;
  }
  return usage;
}

describe("cacheWriteRecorder", () => {
  it("adds the cache writes OpenAI reports to the response's usage", async () => {
    const usage = await usageOf(
      responsesStream({ input_tokens: 5000, output_tokens: 40, total_tokens: 5040, input_tokens_details: { cached_tokens: 3000, cache_write_tokens: 1900 } }),
    );
    assert.equal(usage?.inputTokens, 5000);
    assert.equal(usage?.cacheReadInputTokens, 3000);
    assert.equal(usage?.cacheWriteInputTokens, 1900);
  });

  it("leaves usage without cache writes as it is", async () => {
    const usage = await usageOf(responsesStream({ input_tokens: 500, output_tokens: 4, total_tokens: 504 }));
    assert.equal(usage?.inputTokens, 500);
    assert.equal(usage?.cacheWriteInputTokens, undefined);
  });
});
