import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deepseekFetch } from "../src/common/deepseek-fetch.js";

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
});
