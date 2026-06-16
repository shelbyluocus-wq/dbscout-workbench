import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(__dirname, "agent-runner.mjs");

describe("agent-runner stdio protocol", () => {
  it("serializes start before an immediately queued user_message", async () => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const lines = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      lines.push(...chunk.split(/\r?\n/).filter(Boolean));
    });

    try {
      child.stdin.write(
        JSON.stringify({
          op: "start",
          context: {},
          permissionMode: "plan",
        }) +
          "\n" +
          JSON.stringify({ op: "user_message", text: "hello" }) +
          "\n"
      );

      await new Promise((resolve) => setTimeout(resolve, 1200));

      const errors = lines.map((line) => JSON.parse(line)).filter((event) => event.ev === "error");
      assert.equal(
        errors.some((event) => event.message === "No active session"),
        false
      );
    } finally {
      child.stdin.write(JSON.stringify({ op: "shutdown" }) + "\n");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      child.kill();
    }
  });
});
