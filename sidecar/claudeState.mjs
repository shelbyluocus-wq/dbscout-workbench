import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";

export function createDefaultClaudeCodeSettings() {
  return {
    skipDangerousModePermissionPrompt: true,
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    },
  };
}

export function resolveClaudeConfigEnv(providedEnv, isolatedConfigDir) {
  const env = providedEnv && typeof providedEnv === "object" ? providedEnv : {};
  const hasExplicitAuthentication = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ].some((key) => String(env[key] || "").trim());

  return hasExplicitAuthentication
    ? { CLAUDE_CONFIG_DIR: isolatedConfigDir }
    : {};
}

export function prepareAgentClaudeState(configDir) {
  mkdirSync(configDir, { recursive: true });

  const statePath = pathJoin(configDir, ".claude.json");
  let state = {};
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        state = parsed;
      }
    } catch {
      state = {};
    }
  }

  writeFileSync(
    statePath,
    JSON.stringify(
      {
        ...state,
        installMethod: state.installMethod || "dbscout-workbench",
        hasCompletedOnboarding: true,
      },
      null,
      2
    ),
    "utf8"
  );
}
