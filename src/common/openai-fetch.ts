import type { ModelStreamEvent } from "@strands-agents/sdk";

/**
 * Records the prompt-cache writes the OpenAI Responses API reports, which
 * Strands leaves out of its usage. OpenAI bills cache writes at 1.25x the
 * input price (gpt-6 models) and reports them as
 * `usage.input_tokens_details.cache_write_tokens`, part of `input_tokens`;
 * Strands only reads `cached_tokens`.
 *
 * `fetch` passes every request through and notes the write count of each
 * streamed response (on `response.completed`, or `response.incomplete` when it
 * stopped at the token limit). `withCacheWrites` wraps the model's stream() and
 * adds that count to the response's usage event as `cacheWriteInputTokens`.
 * One recorder serves one model instance, whose requests run one at a time.
 */
export function cacheWriteRecorder(baseFetch: typeof fetch = fetch) {
  let written: number | undefined;

  function note(line: string): void {
    if (!line.startsWith("data:") || !line.includes('"usage"')) return;
    try {
      const event = JSON.parse(line.slice(5));
      const tokens = event?.response?.usage?.input_tokens_details?.cache_write_tokens;
      if (typeof tokens === "number") written = tokens;
    } catch {
      // not JSON: leave it to the SDK
    }
  }

  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    if (!response.ok || response.body === null || !response.headers.get("content-type")?.includes("text/event-stream")) {
      return response;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(bytes, controller) {
          buffer += decoder.decode(bytes, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          lines.forEach(note);
          controller.enqueue(bytes);
        },
        flush() {
          note(buffer + decoder.decode());
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  async function* withCacheWrites(events: AsyncIterable<ModelStreamEvent>): AsyncGenerator<ModelStreamEvent> {
    written = undefined;
    for await (const event of events) {
      if (event.type === "modelMetadataEvent" && event.usage && written !== undefined) {
        yield { ...event, usage: { ...event.usage, cacheWriteInputTokens: written } };
        written = undefined;
        continue;
      }
      yield event;
    }
  }

  return { fetch: recordingFetch, withCacheWrites };
}
