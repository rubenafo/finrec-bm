import {
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  ModelMetadataEvent,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
} from "@strands-agents/sdk";

export type Step = { tool: string; input: Record<string, unknown> } | { text: string };

/**
 * A model that replays a fixed script: one step per model call, the last step
 * repeating. `received` keeps the messages of every call, for assertions.
 */
export class ScriptedModel extends Model<BaseModelConfig> {
  calls = 0;
  readonly received: Message[][] = [];
  constructor(private readonly steps: Step[]) {
    super();
  }
  updateConfig(): void {}
  getConfig(): BaseModelConfig {
    return { modelId: "scripted" };
  }
  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.received.push([...messages]);
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)]!;
    this.calls++;
    yield new ModelMessageStartEvent({ type: "modelMessageStartEvent", role: "assistant" });
    if ("tool" in step) {
      yield new ModelContentBlockStartEvent({
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: step.tool, toolUseId: `call-${this.calls}` },
      });
      yield new ModelContentBlockDeltaEvent({
        type: "modelContentBlockDeltaEvent",
        delta: { type: "toolUseInputDelta", input: JSON.stringify(step.input) },
      });
    } else {
      yield new ModelContentBlockStartEvent({ type: "modelContentBlockStartEvent" });
      yield new ModelContentBlockDeltaEvent({
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: step.text },
      });
    }
    yield new ModelContentBlockStopEvent({ type: "modelContentBlockStopEvent" });
    yield new ModelMessageStopEvent({ type: "modelMessageStopEvent", stopReason: "tool" in step ? "toolUse" : "endTurn" });
    yield new ModelMetadataEvent({
      type: "modelMetadataEvent",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 6 },
    });
  }
}
