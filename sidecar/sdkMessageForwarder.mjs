/**
 * Creates a stateful SDK message forwarder. Claude Code can emit both
 * streaming deltas and a complete assistant message for the same turn; when
 * deltas are present, assistant text blocks are only a fallback and should not
 * be emitted again.
 *
 * @param {{
 *   emit: (event: Record<string, any>) => void,
 *   emitError: (message: string, details?: Record<string, any>) => void,
 *   emitToolUse: (name: string, input: any) => void,
 *   emitToolResult: (name: string, input: any, result: any, isError?: boolean) => void,
 * }} handlers
 */
export function createSdkMessageForwarder(handlers) {
  let sawStreamedTextInTurn = false;
  let sawStreamedThinkingInTurn = false;

  return function forwardSdkMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    try {
      switch (msg.type) {
        case "system": {
          if (msg.subtype === "init") {
            handlers.emit({
              ev: "system_init",
              sessionId: msg.session_id ?? null,
              model: msg.model ?? null,
              permissionMode: msg.permissionMode ?? null,
            });
          }
          break;
        }

        case "stream_event": {
          const event = msg.event;
          if (!event || typeof event !== "object") break;
          if (event.type === "content_block_delta" && event.delta) {
            const delta = event.delta;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              sawStreamedTextInTurn = true;
              handlers.emit({ ev: "text_delta", text: delta.text });
            } else if (
              delta.type === "thinking_delta" &&
              typeof delta.thinking === "string"
            ) {
              sawStreamedThinkingInTurn = true;
              handlers.emit({ ev: "thinking_delta", text: delta.thinking });
            }
          }
          break;
        }

        case "assistant": {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === "text" && typeof block.text === "string") {
                if (!sawStreamedTextInTurn) {
                  handlers.emit({ ev: "text_delta", text: block.text });
                }
              } else if (
                block?.type === "thinking" &&
                typeof block.thinking === "string"
              ) {
                if (!sawStreamedThinkingInTurn) {
                  handlers.emit({ ev: "thinking_delta", text: block.thinking });
                }
              } else if (block?.type === "tool_use") {
                handlers.emitToolUse(block.name, block.input);
              } else if (block?.type === "tool_result") {
                handlers.emitToolResult(
                  block.name,
                  block.input,
                  block.content,
                  block.is_error
                );
              }
            }
          }
          break;
        }

        case "result": {
          handlers.emit({
            ev: "result",
            subtype: msg.subtype ?? null,
            costUsd: msg.total_cost_usd ?? 0,
            isError: msg.is_error ?? false,
            text: msg.result ?? null,
          });
          sawStreamedTextInTurn = false;
          sawStreamedThinkingInTurn = false;
          break;
        }

        case "error":
        case "auth_status": {
          if (msg.error) {
            handlers.emitError(msg.error, { sdkType: msg.type });
          }
          break;
        }
      }
    } catch (err) {
      handlers.emitError("Failed to forward SDK message", {
        inner: err?.message || String(err),
      });
    }
  };
}
