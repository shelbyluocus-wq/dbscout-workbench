import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  for (const name of ["get_workbench_context", "get_mcp_capabilities", "list_connections", "scroll_table", "run_ui_actions"]) {
    assert.ok(names.includes(name), `${name} must be discoverable`);
  }
  const batch = tools.find((tool) => tool.name === "run_ui_actions");
  for (const name of ["get_relation_overview", "get_table_relations", "get_record_relations", "read_reference_rows", "get_relation_rules", "read_relation_code", "search_relation_code", "start_reference_scan", "get_reference_scan", "control_reference_scan", "preview_relation_rule", "test_relation_rule_page", "apply_relation_rule"]) {
    const relationTool = tools.find((tool) => tool.name === name);
    assert.ok(relationTool, name);
    assert.ok(relationTool.inputSchema.required.includes("connectionId"), name);
    assert.ok(relationTool.inputSchema.required.includes("database"), name);
  }
  assert.ok(tools.find((tool) => tool.name === "apply_relation_rule").inputSchema.required.includes("confirmed"));
  assert.equal(batch.inputSchema.properties.mode.default, "fast");
  assert.equal(batch.inputSchema.properties.detail.default, "compact");
  assert.ok(names.includes("export_table_xlsx"));
  assert.ok(names.includes("preview_import_xlsx"));
  assert.ok(names.includes("import_table_xlsx"));
  assert.ok(names.includes("run_read_query"));
  assert.ok(names.includes("read_table_page"));
  for (const name of ["run_write_query", "apply_table_design_change", "copy_tables", "rename_table", "drop_tables"]) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `${name} must be exposed`);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, true);
    assert.ok(tool.inputSchema.required.includes("confirmed"));
    assert.ok(tool.inputSchema.required.includes(name === "copy_tables" ? "targetDatabase" : "database"));
    assert.ok(tool.inputSchema.required.includes(name === "copy_tables" ? "targetConnectionId" : "connectionId"));
  }
  for (const name of ["get_table_design", "preview_table_design_change"]) {
    assert.equal(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true);
  }
  for (const name of ["preview_table_design_change", "apply_table_design_change"]) {
    const column = tools.find((tool) => tool.name === name).inputSchema.properties.draft.properties.columns.items;
    assert.equal(column.properties.unsigned.type, "boolean");
    assert.ok(!column.required.includes("unsigned"));
  }
  assert.ok(names.includes("refresh_table"));
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

test("mutation calls preserve explicit targets and reject missing confirmation before dispatch", async () => {
  const requests = [];
  const sockets = new Set();
  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (request.op === "hello") {
          socket.write(`${JSON.stringify({ ok: true, protocolVersion: 1 })}\n`);
        } else {
          requests.push(request);
          socket.write(`${JSON.stringify({ id: request.id, ok: true, data: { accepted: true } })}\n`);
        }
      }
    });
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const temp = await mkdtemp(path.join(os.tmpdir(), "blackcat-mcp-write-test-"));
  const discovery = path.join(temp, "endpoint.json");
  await writeFile(discovery, JSON.stringify({
    port: listener.address().port, token: "test", pid: process.pid, protocolVersion: 1,
  }));
  const client = new Client({ name: "write-routing-test", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({
      ...serverOptions,
      env: { ...process.env, DBSCOUT_CONTROL_ENDPOINT: discovery },
    }));
    const context = { connectionId: "mysql-explicit", database: "explicit_db" };
    const capabilities = await client.callTool({ name: "get_mcp_capabilities", arguments: {} });
    assert.notEqual(capabilities.isError, true);
    const capabilityCatalog = JSON.parse(capabilities.content[0].text);
    assert.ok(capabilityCatalog.tools.some((tool) => tool.name === "scroll_table" && tool.inputSchema.properties.direction));
    assert.equal(requests.at(-1).op, "get_context");
    await client.callTool({ name: "list_connections", arguments: {} });
    assert.equal(requests.at(-1).op, "get_connections");
    await client.callTool({ name: "scroll_table", arguments: { ...context, table: "items", direction: "down" } });
    assert.equal(requests.at(-1).action, "scroll_table");
    assert.equal(requests.at(-1).args.screens, 1);
    const calls = [
      ["run_write_query", { ...context, sql: "UPDATE items SET label='new' WHERE id=1" }],
      ["rename_table", { ...context, table: "items", newName: "items_old" }],
      ["drop_tables", { ...context, tables: ["items"] }],
      ["copy_tables", {
        sourceConnectionId: "source", sourceDatabase: "source_db", tables: ["items"],
        targetConnectionId: "target", targetDatabase: "target_db", mode: "overwrite",
      }],
      ["apply_table_design_change", {
        ...context, table: "items", schemaSignature: "schema", sourceSignature: "source",
        previewSignature: "preview",
        draft: { tableComment: "", columns: [{
          originalName: "id", name: "id", type: "int", nullable: false,
          primaryKey: true, defaultMode: "none", comment: "", unsigned: true,
        }] },
      }],
    ];
    for (const [name, args] of calls) {
      const before = requests.length;
      for (const confirmed of [undefined, false, "true"]) {
        const rejected = await client.callTool({ name, arguments: { ...args, confirmed } });
        assert.equal(rejected.isError, true);
      }
      assert.equal(requests.length, before);
      const result = await client.callTool({ name, arguments: { ...args, confirmed: true } });
      assert.notEqual(result.isError, true);
      assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1).op, "db_tool");
      assert.equal(requests.at(-1).func, name);
      assert.deepEqual(requests.at(-1).args, { ...args, confirmed: true });
    }
    const designArgs = calls.find(([name]) => name === "apply_table_design_change")[1];
    for (const unsigned of [true, false]) {
      const args = structuredClone(designArgs);
      args.draft.columns[0].unsigned = unsigned;
      for (const name of ["preview_table_design_change", "apply_table_design_change"]) {
        const result = await client.callTool({ name, arguments: { ...args, confirmed: true } });
        assert.notEqual(result.isError, true);
        assert.equal(requests.at(-1).args.draft.columns[0].unsigned, unsigned);
      }
    }
  } finally {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => listener.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
