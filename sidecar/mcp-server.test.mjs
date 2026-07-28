import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("external MCP exposes curated tools and no arbitrary database write tool", async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(directory, "mcp-server.mjs")],
    stderr: "pipe",
  });
  const client = new Client({ name: "blackcat-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("open_table"));
    assert.ok(names.includes("export_table_xlsx"));
    assert.ok(names.includes("preview_import_xlsx"));
    assert.ok(names.includes("import_table_xlsx"));
    assert.ok(names.includes("run_read_query"));
    assert.ok(names.includes("read_table_page"));
    assert.ok(!names.includes("run_write_query"));
    assert.equal(
      tools.find((tool) => tool.name === "import_table_xlsx")?.annotations?.destructiveHint,
      true
    );
    const pageTool = tools.find((tool) => tool.name === "read_table_page");
    assert.equal(pageTool?.inputSchema?.properties?.limit?.maximum, 1000);
    assert.equal(pageTool?.inputSchema?.properties?.offset?.minimum, 0);
  } finally {
    await client.close();
  }
});
