import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { createMcpHandler } from "@modelcontextprotocol/server";

export async function serveHttp(factory, { port, token }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("Invalid HTTP MCP configuration");
  }
  const handler = createMcpHandler(factory);
  const expected = Buffer.from(`Bearer ${token}`);
  const server = http.createServer(async (request, response) => {
    const reject = (status) => { response.writeHead(status); response.end(); };
    const authority = `127.0.0.1:${server.address().port}`;
    if (request.headers.host !== authority || request.headers.origin) return reject(403);
    if (request.url !== "/mcp") return reject(404);
    const supplied = Buffer.from(request.headers.authorization || "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reject(401);
    if (!["POST", "GET", "DELETE"].includes(request.method)) return reject(405);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) return reject(413);
        chunks.push(chunk);
      }
      const abort = new AbortController();
      response.on("close", () => abort.abort());
      const result = await handler.fetch(new Request(`http://${authority}/mcp`, {
        method: request.method,
        headers: request.headers,
        signal: abort.signal,
        ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) Readable.fromWeb(result.body).on("error", () => response.destroy()).pipe(response);
      else response.end();
    } catch {
      if (!response.headersSent) reject(500);
      else response.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
