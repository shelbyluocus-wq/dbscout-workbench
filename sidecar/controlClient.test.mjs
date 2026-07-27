import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appExecutableFromArgs,
  ControlClient,
  controlEndpointCandidates,
  readOrStartControlEndpoint,
} from "./controlClient.mjs";

test("uses the Tauri app-data discovery path on Windows", () => {
  assert.deepEqual(
    controlEndpointCandidates({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "win32"),
    ["C:\\Users\\test\\AppData\\Roaming\\com.dbscout.workbench\\control-endpoint.json"]
  );
});

test("reads the blackcat executable from MCP arguments before the environment", () => {
  assert.equal(
    appExecutableFromArgs(
      ["--app-executable", "C:\\Blackcat\\blackcat.exe"],
      { DBSCOUT_APP_EXECUTABLE: "C:\\Other\\blackcat.exe" }
    ),
    "C:\\Blackcat\\blackcat.exe"
  );
  assert.equal(
    appExecutableFromArgs(["--app-executable=/Applications/Blackcat.app"], {}),
    "/Applications/Blackcat.app"
  );
});

test("starts a hidden host and waits for discovery when blackcat is not running", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "blackcat-autostart-test-"));
  const discovery = path.join(temp, "control-endpoint.json");
  let launches = 0;
  try {
    const endpoint = await readOrStartControlEndpoint({
      candidates: [discovery],
      hostStartTimeoutMs: 1_000,
      hostStartPollMs: 10,
      launchWorkbench: async () => {
        launches += 1;
        await writeFile(discovery, JSON.stringify({
          port: 43125,
          token: "started-token",
          pid: process.pid,
          version: "test",
          protocolVersion: 1,
        }));
      },
    });
    assert.equal(launches, 1);
    assert.equal(endpoint.token, "started-token");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("authenticates and correlates JSON-line requests", async () => {
  const token = "test-token";
  const listener = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.op === "hello") {
          socket.write(`${JSON.stringify({ ok: message.token === token, protocolVersion: 1 })}\n`);
        } else {
          socket.write(`${JSON.stringify({ id: message.id, ok: true, data: { echoed: message.op } })}\n`);
        }
      }
    });
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const temp = await mkdtemp(path.join(os.tmpdir(), "blackcat-control-test-"));
  const discovery = path.join(temp, "control-endpoint.json");
  await writeFile(discovery, JSON.stringify({
    port: listener.address().port,
    token,
    pid: process.pid,
    version: "test",
    protocolVersion: 1,
  }));
  const client = new ControlClient({ candidates: [discovery], requestTimeoutMs: 2_000 });
  try {
    assert.deepEqual(await client.request("get_context"), { echoed: "get_context" });
  } finally {
    client.close();
    await new Promise((resolve) => listener.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
