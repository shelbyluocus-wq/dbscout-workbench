import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDefaultClaudeCodeSettings,
  prepareAgentClaudeState,
  resolveClaudeConfigEnv,
} from "./claudeState.mjs";

describe("Claude Code state isolation", () => {
  it("marks the workbench-owned Claude state as already onboarded", () => {
    const dir = mkdtempSync(join(tmpdir(), "dbscout-claude-state-"));
    try {
      const statePath = join(dir, ".claude.json");
      writeFileSync(statePath, JSON.stringify({ custom: "keep" }), "utf8");

      prepareAgentClaudeState(dir);

      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(state.hasCompletedOnboarding, true);
      assert.equal(state.installMethod, "dbscout-workbench");
      assert.equal(state.custom, "keep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("provides SDK settings that skip supported Claude Code confirmation prompts", () => {
    const settings = createDefaultClaudeCodeSettings();

    assert.equal(settings.skipDangerousModePermissionPrompt, true);
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
  });

  it("uses local Claude config by default and isolates explicit API authentication", () => {
    const isolatedDir = "C:/dbscout/claude";

    assert.deepEqual(resolveClaudeConfigEnv({}, isolatedDir), {});
    assert.deepEqual(
      resolveClaudeConfigEnv({ ANTHROPIC_BASE_URL: "https://proxy.example.com" }, isolatedDir),
      {},
    );

    for (const [key, value] of [
      ["ANTHROPIC_API_KEY", "sk-test"],
      ["ANTHROPIC_AUTH_TOKEN", "managed-token"],
      ["CLAUDE_CODE_OAUTH_TOKEN", "oauth-token"],
    ]) {
      assert.deepEqual(resolveClaudeConfigEnv({ [key]: value }, isolatedDir), {
        CLAUDE_CONFIG_DIR: isolatedDir,
      });
    }
  });
});
