import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSdkMessageForwarder } from "./sdkMessageForwarder.mjs";

function createCollector() {
  const events = [];
  const forward = createSdkMessageForwarder({
    emit: (event) => events.push(event),
    emitError: (message, details) => events.push({ ev: "error", message, details }),
    emitToolUse: (name, input) => events.push({ ev: "tool_use", name, input }),
    emitToolResult: (name, input, result, isError) =>
      events.push({ ev: "tool_result", name, input, result, isError }),
  });
  return { events, forward };
}

describe("SDK message forwarding", () => {
  it("does not duplicate assistant text that already arrived as stream deltas", () => {
    const { events, forward } = createCollector();

    forward({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "OK" },
      },
    });
    forward({
      type: "assistant",
      message: { content: [{ type: "text", text: "OK" }] },
    });

    assert.deepEqual(events, [{ ev: "text_delta", text: "OK" }]);
  });

  it("still forwards assistant text when no stream deltas were emitted", () => {
    const { events, forward } = createCollector();

    forward({
      type: "assistant",
      message: { content: [{ type: "text", text: "fallback" }] },
    });

    assert.deepEqual(events, [{ ev: "text_delta", text: "fallback" }]);
  });

  it("resets duplicate suppression after a result event", () => {
    const { events, forward } = createCollector();

    forward({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "first" },
      },
    });
    forward({
      type: "result",
      subtype: "success",
      total_cost_usd: 0,
      is_error: false,
      result: "first",
    });
    forward({
      type: "assistant",
      message: { content: [{ type: "text", text: "second" }] },
    });

    assert.equal(events.filter((event) => event.ev === "text_delta").length, 2);
    assert.deepEqual(events.at(-1), { ev: "text_delta", text: "second" });
  });
});
