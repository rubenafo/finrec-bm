import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Message, TextBlock, ToolUseBlock } from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { deepseekFetch, oneBlockAtATime } from "../src/common/deepseek-fetch.js";

const sse = (...chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });

/** A fake DeepSeek: replies with the given responses in order and keeps every request body. */
function fakeApi(...responses: Response[]) {
  const bodies: any[] = [];
  const base = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return responses.shift()!;
  }) as typeof fetch;
  return { base, bodies };
}

/** A tool-call chunk; the first chunk of a call has its id and name. */
const call = (index: number, args: string, id?: string) => ({
  choices: [{ delta: { tool_calls: [{ index, ...(id && { id, type: "function" }), function: { ...(id && { name: "query_ledger" }), arguments: args } }] } }],
});

const events = async (response: Response) =>
  (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));

describe("deepseekFetch", () => {
  it("passes the reasoning back on the assistant message of a later request", async () => {
    const { base, bodies } = fakeApi(
      sse(
        { choices: [{ delta: { role: "assistant", reasoning_content: "Need the " } }] },
        { choices: [{ delta: { reasoning_content: "file." } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_text_file", arguments: "{}" } }] } }] },
      ),
      sse({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
    );
    const wrapped = deepseekFetch(base);

    await (await wrapped("u", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) })).text();
    const assistant = { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_text_file", arguments: "{}" } }] };
    await (await wrapped("u", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }, assistant, { role: "tool", tool_call_id: "call_1", content: "x" }] }) })).text();

    assert.equal(bodies[0].messages.length, 1);
    assert.equal(bodies[1].messages[1].reasoning_content, "Need the file.");
  });

  it("splits usage on a chunk with choices into a separate usage-only chunk", async () => {
    const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
    const { base } = fakeApi(sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage }));
    const out = await events(await deepseekFetch(base)("u", { method: "POST", body: JSON.stringify({ messages: [] }) }));

    assert.deepEqual(out, [
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      { choices: [], usage },
    ]);
  });

  it("leaves error responses and non-streaming replies untouched", async () => {
    const error = new Response('{"error":"bad"}', { status: 400, headers: { "content-type": "application/json" } });
    const { base } = fakeApi(error);
    const response = await deepseekFetch(base)("u", { method: "POST", body: JSON.stringify({ messages: [] }) });
    assert.equal(response.status, 400);
    assert.equal(await response.text(), '{"error":"bad"}');
  });

  it("sends interleaved tool calls whole, in index order, before the finish chunk", async () => {
    const { base } = fakeApi(sse(call(0, '{"queries":["a"', "call_a"), call(1, '{"queries":["b"', "call_b"), call(0, "]}"), call(1, "]}"), { choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
    const out = await events(await deepseekFetch(base)("u", { method: "POST", body: JSON.stringify({ messages: [] }) }));

    // The held-back chunks stay, emptied of their tool calls; the calls follow, then the finish.
    assert.deepEqual(out.slice(0, 4).map((c) => c.choices[0].delta), [{}, {}, {}, {}]);
    assert.deepEqual(out.slice(4, 6).map((c) => c.choices[0].delta.tool_calls[0]), [
      { index: 0, id: "call_a", type: "function", function: { name: "query_ledger", arguments: '{"queries":["a"]}' } },
      { index: 1, id: "call_b", type: "function", function: { name: "query_ledger", arguments: '{"queries":["b"]}' } },
    ]);
    assert.equal(out.length, 7);
    assert.equal(out[6].choices[0].finish_reason, "tool_calls");
  });
});

describe("DeepSeek tool calls through Strands", () => {
  // As model.ts builds it: Strands' Chat Completions model, deepseekFetch and oneBlockAtATime.
  class DeepSeekModel extends OpenAIModel {
    override stream(...args: Parameters<OpenAIModel["stream"]>) {
      return oneBlockAtATime(super.stream(...args));
    }
  }
  const reply = async (...chunks: unknown[]) => {
    const { base } = fakeApi(sse({ choices: [{ delta: { role: "assistant", content: "" } }] }, ...chunks, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
    const model = new DeepSeekModel({ api: "chat", modelId: "m", apiKey: "k", clientConfig: { baseURL: "http://localhost", fetch: deepseekFetch(base) } });
    const stream = model.streamAggregated([new Message({ role: "user", content: [new TextBlock("hi")] })]);
    let next;
    while (!(next = await stream.next()).done);
    return next.value.message.content;
  };

  it("keeps every tool call of a reply, and the text before them", async () => {
    const content = await reply({ choices: [{ delta: { content: "Checking." } }] }, call(0, '{"queries":["a"]}', "call_a"), call(1, '{"queries":["b"]}', "call_b"));
    assert.deepEqual(
      content.map((b) => (b instanceof ToolUseBlock ? [b.toolUseId, b.input] : (b as TextBlock).text)),
      ["Checking.", ["call_a", { queries: ["a"] }], ["call_b", { queries: ["b"] }]],
    );
  });

  it("parses tool calls whose argument chunks interleave", async () => {
    const content = await reply(call(0, '{"queries":["a"', "call_a"), call(1, '{"queries":["b"', "call_b"), call(0, "]}"), call(1, "]}"));
    assert.deepEqual(
      content.map((b) => (b as ToolUseBlock).input),
      [{ queries: ["a"] }, { queries: ["b"] }],
    );
  });
});
