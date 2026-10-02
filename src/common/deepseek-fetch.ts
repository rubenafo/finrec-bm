/**
 * A fetch wrapper that adapts DeepSeek's OpenAI-compatible streaming API to
 * what Strands' OpenAI chat adapter expects. It fixes two gaps:
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
 */
export function deepseekFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  const reasoningByToolCall = new Map<string, string>();
  const pending = new Set<Promise<void>>();

  /** Rewrites one SSE stream: records reasoning per tool call and splits usage into its own chunk. */
  function adapt(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let reasoning = "";
    const toolCallIds: string[] = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    pending.add(done);

    const rewrite = (line: string): string => {
      if (!line.startsWith("data:")) return line;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") return line;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return line;
      }
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      for (const call of delta.tool_calls ?? []) if (typeof call.id === "string") toolCallIds.push(call.id);
      if (chunk.usage && Array.isArray(chunk.choices) && chunk.choices.length > 0) {
        const { usage, ...rest } = chunk;
        return `data: ${JSON.stringify(rest)}\n\ndata: ${JSON.stringify({ ...rest, choices: [], usage })}`;
      }
      return line;
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
