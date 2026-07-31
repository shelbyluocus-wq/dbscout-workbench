import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.env.DBSCOUT_MCP_SERVER_PATH
  ? path.resolve(process.env.DBSCOUT_MCP_SERVER_PATH)
  : path.join(directory, "mcp-server.mjs");
const serverOptions = {
  command: process.execPath,
  args: [serverPath],
  stderr: "pipe",
};

function assertCuratedTools(tools) {
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
}

test("external MCP remains compatible with a 2025-era client", async () => {
  const transport = new StdioClientTransport(serverOptions);
  const client = new Client({ name: "blackcat-legacy-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assertCuratedTools(tools);
  } finally {
    await client.close();
  }
});

test("external MCP supports a client pinned to the 2026-07-28 protocol", async () => {
  const transport = new ModernStdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    stderr: "pipe",
  });
  const client = new ModernClient(
    { name: "blackcat-modern-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), "modern");
    const { tools } = await client.listTools();
    assertCuratedTools(tools);
  } finally {
    await client.close();
  }
});

test("external MCP is selected as modern during automatic protocol negotiation", async () => {
  const transport = new ModernStdioClientTransport(serverOptions);
  const client = new ModernClient(
    { name: "blackcat-auto-negotiation-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), "modern");
    const { tools } = await client.listTools();
    assertCuratedTools(tools);
  } finally {
    await client.close();
  }
});
