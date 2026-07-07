const READ_ONLY_DB_TOOLS = new Set([
  "list_databases",
  "list_tables",
  "describe_table",
  "sample_rows",
  "search_schema",
  "search_values",
  "get_database_profile",
  "refresh_database_profile",
  "search_database_profile",
  "find_related_tables",
  "run_read_query",
  "open_table",
  "focus_column",
  "focus_row",
  "focus_cell",
]);

const READ_ONLY_PROJECT_TOOLS = new Set([
  "list_project_files",
  "search_project_files",
  "read_project_file",
]);

const MCP_PREFIXES = [
  "mcp__dbscout-db__",
  "mcp__dbscout-project__",
];

export function normalizeToolName(toolName) {
  if (typeof toolName !== "string") return "";
  for (const prefix of MCP_PREFIXES) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return toolName;
}

export function isAutoApprovedReadOnlyTool(toolName) {
  const normalized = normalizeToolName(toolName);
  return READ_ONLY_DB_TOOLS.has(normalized) || READ_ONLY_PROJECT_TOOLS.has(normalized);
}

export function isAutoApprovedReadOnlyDbTool(toolName) {
  return isAutoApprovedReadOnlyTool(toolName);
}

export function createPermissionResult(behavior, input, options = {}) {
  if (behavior === "allow") {
    return {
      behavior: "allow",
      // Claude Code 2.1.177 validates allowed stdio permission responses with
      // a required updatedInput record, even when the input is unchanged.
      updatedInput: input && typeof input === "object" ? input : {},
    };
  }

  return {
    behavior: "deny",
    message: options.message || "denied",
  };
}
