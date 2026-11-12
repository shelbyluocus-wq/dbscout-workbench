import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { serveHttp } from "./mcpHttp.mjs";

const token = "a".repeat(64);

test("HTTP requires bearer authentication and rejects browser origins and unexpected hosts", async () => {
  const server = await serveHttp(() => new McpServer({ name: "test", version: "1" }), { port: 0, token });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(url, { headers: { authorization: `Bearer ${token}`, host: "evil.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(`${url}/other`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  } finally { await server.close(); }
});

for (const [label, ClientType, TransportType] of [["2025", Client, StreamableHTTPClientTransport], ["2026", ModernClient, ModernTransport]]) {
test(`Streamable HTTP supports ${label} initialize, discovery, and tools without changing handlers`, async () => {
  const server = await serveHttp(() => {
    const mcp = new McpServer({ name: "test", version: "1" });
    mcp.registerTool("hello", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "ok" }] }));
    return mcp;
  }, { port: 0, token });
  const client = new ClientType({ name: "http-test", version: "1" });
  try {
    await client.connect(new TransportType(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    assert.equal((await client.listTools()).tools[0].name, "hello");
    assert.equal((await client.callTool({ name: "hello", arguments: {} })).content[0].text, "ok");
  } finally { await client.close(); await server.close(); }
});
}

test("HTTP rejects invalid configuration", async () => {
  await assert.rejects(serveHttp(() => {}, { port: 0, token: "" }));
  await assert.rejects(serveHttp(() => {}, { port: -1, token }));
});
