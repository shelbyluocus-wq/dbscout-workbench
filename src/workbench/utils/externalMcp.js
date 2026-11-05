// Shared helpers for the external MCP (黑猫 MCP) setup snippets shown in
// AgentSettings and the 黑猫 MCP dialog.

// Generic stdio MCP client config (the shape most non-Codex/Claude clients
// accept), built from the resolved runtime paths in the backend status.
export function genericMcpConfigJson(status) {
  return JSON.stringify(
    {
      command: status?.nodePath || "node",
      args: [
        status?.serverPath || "mcp-server.mjs",
        "--app-executable",
        status?.appPath || "blackcat",
      ],
    },
    null,
    2,
  );
}
