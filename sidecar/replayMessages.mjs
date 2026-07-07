/**
 * @param {Array<{ type: 'user' | 'assistant' | 'system', uuid: string, message: any }>} transcript
 */
export function buildReplayMessages(transcript) {
  if (!Array.isArray(transcript)) return [];
  const result = [];
  let assistantCounter = 0;

  for (const entry of transcript) {
    if (!entry || typeof entry !== "object") continue;
    const sdkMessage = entry.message;
    if (!sdkMessage || typeof sdkMessage !== "object") continue;

    if (entry.type === "user") {
      const content = sdkMessage.content;
      if (typeof content === "string") {
        const text = stripTurnContextPrefix(content);
        if (text) result.push({ id: `replay-user-${entry.uuid}`, role: "user", content: text });
      } else if (Array.isArray(content)) {
        const textParts = [];
        const toolResults = [];
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block.type === "tool_result") {
            toolResults.push({
              id: block.tool_use_id || null,
              summary: summarizeToolResult(block.content),
              result: block.content ?? null,
              isError: block.is_error === true,
            });
          }
        }
        if (textParts.length > 0) {
          const text = stripTurnContextPrefix(textParts.join("\n\n"));
          if (text) result.push({ id: `replay-user-${entry.uuid}`, role: "user", content: text });
        }
        if (toolResults.length > 0) {
          const lastAssistant = findLastAssistant(result);
          if (lastAssistant) {
            if (!lastAssistant.toolResults) lastAssistant.toolResults = [];
            lastAssistant.toolResults.push(...toolResults);
          }
        }
      }
    } else if (entry.type === "assistant") {
      const content = sdkMessage.content;
      if (!Array.isArray(content)) continue;
      const aggregate = {
        id: `replay-assistant-${entry.uuid}-${assistantCounter++}`,
        role: "assistant",
        content: "",
        thinking: "",
        toolUses: [],
        toolResults: [],
        done: true,
      };
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          aggregate.content += block.text;
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          aggregate.thinking += block.thinking;
        } else if (block.type === "tool_use") {
          aggregate.toolUses.push({
            id: block.id || null,
            name: block.name,
            input: block.input,
          });
        }
      }
      if (aggregate.toolUses.length === 0) delete aggregate.toolUses;
      if (aggregate.toolResults.length === 0) delete aggregate.toolResults;
      if (!aggregate.thinking) delete aggregate.thinking;
      if (aggregate.content || aggregate.toolUses) result.push(aggregate);
    }
  }
  return result;
}

function findLastAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return null;
}

function stripTurnContextPrefix(text) {
  if (typeof text !== "string") return "";
  const marker = "\n\n用户问题:\n";
  const idx = text.indexOf(marker);
  if (idx >= 0) return text.slice(idx + marker.length).trim();
  return text.trim();
}

function summarizeToolResult(content) {
  if (typeof content === "string") {
    return truncate(content, 400);
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === "object" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return truncate(parts.join("\n"), 400);
  }
  return "";
}

function truncate(text, max) {
  if (typeof text !== "string") return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
