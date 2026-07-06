import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(__dirname, "agent-runner.mjs");

async function waitForLine(lines, predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (lines.some((line) => predicate(JSON.parse(line)))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForFile(path, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`expected file to exist: ${path}`);
}

describe("agent-runner stdio protocol", () => {
  it("prepares an isolated Claude Code state so first-run onboarding is already complete", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "dbscout-agent-home-"));
    const configDir = join(homeDir, "agent-claude");
    const statePath = join(configDir, ".claude.json");
    const child = spawn(process.execPath, [runnerPath], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        DBSCOUT_AGENT_CLAUDE_CONFIG_DIR: configDir,
      },
    });

    try {
      await waitForFile(statePath);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(state.hasCompletedOnboarding, true);
      assert.equal(state.installMethod, "dbscout-workbench");
    } finally {
      child.stdin.write(JSON.stringify({ op: "shutdown" }) + "\n");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      child.kill();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("emits startup progress before the SDK query begins", async () => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DBSCOUT_AGENT_NATIVE_CLI_PATH: join(__dirname, "missing-claude-code-native"),
      },
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
        }) + "\n"
      );

      await waitForLine(lines, (event) => event.ev === "startup_progress" && event.stage === "native_cli");

      const events = lines.map((line) => JSON.parse(line));
      const progressEvents = events.filter((event) => event.ev === "startup_progress");
      assert.ok(progressEvents.length >= 2, "expected multiple startup progress events");
      assert.equal(progressEvents[0].stage, "runtime");
      assert.ok(progressEvents.some((event) => event.stage === "native_cli"));
      assert.ok(progressEvents.every((event) => Number.isFinite(event.progress)));
    } finally {
      child.stdin.write(JSON.stringify({ op: "shutdown" }) + "\n");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      child.kill();
    }
  });

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
