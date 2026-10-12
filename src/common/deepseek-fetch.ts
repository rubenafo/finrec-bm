import type { ModelStreamEvent } from "@strands-agents/sdk";

/**
 * A fetch wrapper that adapts DeepSeek's OpenAI-compatible streaming API to
 * what Strands' OpenAI chat adapter expects. It fixes three gaps:
 *
 * 1. Thinking on tool-call turns. In thinking mode DeepSeek streams
 *    `reasoning_content` with each reply, and rejects a follow-up request
 *    ("The `reasoning_content` in the thinking mode must be passed back to the
 *    API") when an assistant tool-call message comes back without it. Strands
 *    ignores that field, so the wrapper records it from each response, keyed
 *    by tool-call ID, and adds it to the matching assistant messages of later
 *    requests.
 * 2. Token usage. DeepSeek puts `usage` on the final chunk, next to its
 *    choices; Strands only reads usage from a chunk with no choices. The
 *    wrapper splits such a chunk into the chunk itself plus a usage-only one.
 * 3. Several tool calls in one reply. Strands appends every tool-call
 *    argument chunk to the latest call, whatever its `index`, so calls whose
 *    chunks interleave come out as one broken JSON string ("unable to parse
 *    tool input JSON"). The wrapper holds each call's chunks back and sends
 *    the call as one chunk, in index order, just before the reply finishes.
 *    Strands still keeps only the last of several calls; see oneBlockAtATime.
 */
export function deepseekFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  const reasoningByToolCall = new Map<string, string>();
  const pending = new Set<Promise<void>>();

  /**
   * Rewrites one SSE stream: records reasoning per tool call, sends each tool
   * call whole and splits usage into its own chunk.
   */
  function adapt(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let reasoning = "";
    const toolCallIds: string[] = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    pending.add(done);

    /** This reply's tool calls by index, held back until it finishes. */
    const toolCalls = new Map<number, { id?: string; type?: string; name?: string; arguments: string }>();
    /** One chunk per held tool call, in index order; empties the hold. */
    const releaseToolCalls = (): string[] => {
      const lines = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => {
          const toolCall = { index, id: call.id, type: call.type ?? "function", function: { name: call.name, arguments: call.arguments } };
          return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }] })}`;
        });
      toolCalls.clear();
      return lines;
    };

    const rewrite = (line: string): string => {
      if (!line.startsWith("data:")) return line;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return [...releaseToolCalls(), line].join("\n\n");
      if (data === "") return line;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return line;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      const holdsToolCalls = Array.isArray(delta.tool_calls);
      for (const call of holdsToolCalls ? delta.tool_calls : []) {
        if (typeof call.id === "string") toolCallIds.push(call.id);
        const index = typeof call.index === "number" ? call.index : 0;
        const held = toolCalls.get(index) ?? { arguments: "" };
        held.id ??= call.id;
        held.type ??= call.type;
        held.name ??= call.function?.name;
        held.arguments += call.function?.arguments ?? "";
        toolCalls.set(index, held);
      }
      if (holdsToolCalls) delete delta.tool_calls;

      const lines = choice?.finish_reason ? releaseToolCalls() : [];
      if (chunk.usage && Array.isArray(chunk.choices) && chunk.choices.length > 0) {
        const { usage, ...rest } = chunk;
        lines.push(`data: ${JSON.stringify(rest)}`, `data: ${JSON.stringify({ ...rest, choices: [], usage })}`);
      } else {
        lines.push(holdsToolCalls ? `data: ${JSON.stringify(chunk)}` : line);
      }
      return lines.join("\n\n");
    };

    const finishRecording = () => {
      for (const id of toolCallIds) reasoningByToolCall.set(id, reasoning);
      pending.delete(done);
      finish();
    };

    return body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(bytes, controller) {
          buffer += decoder.decode(bytes, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          if (lines.length > 0) controller.enqueue(encoder.encode(lines.map(rewrite).join("\n") + "\n"));
        },
        flush(controller) {
          buffer += decoder.decode();
          if (buffer !== "") controller.enqueue(encoder.encode(rewrite(buffer)));
          // A stream cut short of its finish chunk and [DONE] still gets its tool calls.
          if (toolCalls.size > 0) controller.enqueue(encoder.encode(`\n${releaseToolCalls().join("\n\n")}\n\n`));
          finishRecording();
        },
      }),
    );
  }

  return async (input, init) => {
    // Wait until earlier responses have been read, so their reasoning is known.
    // A response abandoned mid-stream never finishes, so don't wait forever.
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 2_000))]);

    if (typeof init?.body === "string") {
      const body = JSON.parse(init.body);
      let changed = false;
      for (const message of body.messages ?? []) {
        if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.reasoning_content !== undefined) continue;
        const id = message.tool_calls.map((call: { id?: string }) => call.id).find((id: string | undefined) => id && reasoningByToolCall.has(id));
        if (id !== undefined) {
          message.reasoning_content = reasoningByToolCall.get(id);
          changed = true;
        }
      }
      if (changed) init = { ...init, body: JSON.stringify(body) };
    }

    const response = await baseFetch(input, init);
    if (!response.ok || response.body === null || !response.headers.get("content-type")?.includes("text/event-stream")) {
      return response;
    }
    return new Response(adapt(response.body), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/**
 * Closes each content block before the next one opens. Strands' Chat
 * Completions adapter opens a block per tool call but closes them all only
 * when the reply finishes, so its aggregator keeps just the last tool call of
 * a reply, and drops text that came before a tool call. This closes the open
 * block when another starts or the reply finishes, and drops the closes left
 * over at the end. Wrap the model's stream() with it; deepseekFetch already
 * sends each tool call whole, so a call's chunks never straddle another's.
 */
export async function* oneBlockAtATime(events: AsyncIterable<ModelStreamEvent>): AsyncGenerator<ModelStreamEvent> {
  let open = false;
  for await (const event of events) {
    if (event.type === "modelContentBlockStartEvent" || event.type === "modelMessageStopEvent") {
      if (open) yield { type: "modelContentBlockStopEvent" };
      open = event.type === "modelContentBlockStartEvent";
    } else if (event.type === "modelContentBlockStopEvent") {
      if (!open) continue;
      open = false;
    }
    yield event;
  }
}
