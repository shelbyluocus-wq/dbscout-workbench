const CONTEXT_MARKER = "DBSCOUT_CONTEXT_JSON:";

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
        const replay = parseReplayUserText(content);
        if (replay.content) result.push({ id: `replay-user-${entry.uuid}`, role: "user", ...replay });
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
          const replay = parseReplayUserText(textParts.join("\n\n"));
          if (replay.content) result.push({ id: `replay-user-${entry.uuid}`, role: "user", ...replay });
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

function parseReplayUserText(text) {
  const { contextText, userText } = splitTurnContext(text);
  const context = extractContextSnapshot(contextText);
  const message = { content: userText };
  const contextLabel = formatContextLabel(context);
  const projectLabel = formatProjectLabel(context?.project);
  if (contextLabel) message.contextLabel = contextLabel;
  if (projectLabel) message.projectLabel = projectLabel;
  if (context && Object.keys(context).length) message.context = context;
  return message;
}

function splitTurnContext(text) {
  if (typeof text !== "string") return { contextText: "", userText: "" };
  const marker = "\n\n用户问题:\n";
  const idx = text.indexOf(marker);
  if (idx >= 0) {
    return {
      contextText: text.slice(0, idx).trim(),
      userText: text.slice(idx + marker.length).trim(),
    };
  }
  return { contextText: "", userText: text.trim() };
}

function extractContextSnapshot(contextText) {
  if (typeof contextText !== "string" || !contextText) return null;
  const markerIndex = contextText.indexOf(CONTEXT_MARKER);
  if (markerIndex >= 0) {
    const jsonText = contextText.slice(markerIndex + CONTEXT_MARKER.length).split(/\r?\n/)[0]?.trim() || "";
    try {
      const parsed = JSON.parse(jsonText);
      return normalizeContext(parsed);
    } catch {
      // Fall through to label parsing below for old transcripts.
    }
  }
  return normalizeContext(parseLegacyContextLines(contextText));
}

function parseLegacyContextLines(contextText) {
  const context = {};
  for (const line of contextText.split(/\r?\n/)) {
    const text = line.trim();
    if (text.startsWith("当前连接:")) context.connectionLabel = text.slice("当前连接:".length).trim();
    else if (text.startsWith("当前数据库:")) context.database = text.slice("当前数据库:".length).trim();
    else if (text.startsWith("当前活动表:")) context.activeTableName = text.slice("当前活动表:".length).trim();
    else if (text.startsWith("当前项目:")) {
      const projectName = text.slice("当前项目:".length).replace(/\s*\(只读\)\s*$/, "").trim();
      if (projectName) context.project = { ...(context.project || {}), name: projectName, readOnly: true, available: true };
    } else if (text.startsWith("项目路径:")) {
      const rootPath = text.slice("项目路径:".length).trim();
      if (rootPath) context.project = { ...(context.project || {}), rootPath, shortPath: rootPath, readOnly: true, available: true };
    }
  }
  return context;
}

function normalizeContext(raw) {
  if (!raw || typeof raw !== "object") return null;
  const context = {};
  for (const key of [
    "connectionId",
    "connectionLabel",
    "database",
    "activeTableName",
    "selectedColumn",
    "selectedRowKey",
    "selectedCellValuePreview",
  ]) {
    if (raw[key] != null && String(raw[key]).trim()) context[key] = String(raw[key]);
  }
  const project = raw.project;
  if (project && typeof project === "object") {
    const rootPath = String(project.rootPath || project.path || "").trim();
    const name = String(project.name || "").trim();
    if (rootPath && name) {
      context.project = {
        id: String(project.id || rootPath),
        name,
        rootPath,
        shortPath: String(project.shortPath || rootPath),
        readOnly: true,
        available: project.available !== false,
      };
    }
  }
  return Object.keys(context).length ? context : null;
}

function formatContextLabel(context) {
  if (!context || typeof context !== "object") return "";
  const database = String(context.database || "").trim();
  const table = String(context.activeTableName || "").trim();
  if (database && table) return `${database}.${table}`;
  return table || database || "";
}

function formatProjectLabel(project) {
  if (!project || typeof project !== "object") return "";
  const name = String(project.name || "").trim();
  return name ? `项目：${name}` : "";
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
