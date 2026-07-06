# Database Agent Local Auth Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefer a working local Claude Code configuration, fall back to UI-provided API configuration, and never direct the user to `/login`.

**Architecture:** The Sidecar selects its Claude config directory from the presence of explicit API authentication: local Claude state for the default path, isolated DB Scout state for UI overrides. Authentication-only SDK errors become a typed `auth_required` event that the existing Vue onboarding surface consumes.

**Tech Stack:** Node.js ESM + `node:test`, Vue 3 composable state, Rust/Tauri command bridge.

## Global Constraints

- Preserve the existing database read/write approval behavior.
- Keep Agent sessions under the DB Scout work directory.
- Do not persist or commit real API keys.
- Do not modify the user's global Claude files.

---

### Task 1: Select Local or Isolated Claude Configuration

**Files:**
- Modify: `sidecar/claudeState.mjs`
- Modify: `sidecar/agent-runner.mjs`
- Test: `sidecar/claudeState.test.mjs`

**Interfaces:**
- Produces: `resolveClaudeConfigEnv(providedEnv, isolatedConfigDir)` returning either `{}` or `{ CLAUDE_CONFIG_DIR: isolatedConfigDir }`.
- Consumes: the `op.env` authentication values already sent by the Rust host.

- [ ] Add a failing test showing empty auth uses `{}` while API Key, Anthropic auth token, or Claude OAuth token selects the isolated directory.
- [ ] Run `node --test sidecar/claudeState.test.mjs` and confirm the new test fails because `resolveClaudeConfigEnv` is missing.
- [ ] Implement `resolveClaudeConfigEnv` and use it when building the Sidecar environment.
- [ ] Run `node --test sidecar/claudeState.test.mjs sidecar/agent-runner-smoke.test.mjs` and confirm all tests pass.

### Task 2: Convert Claude Login Errors into Product Configuration State

**Files:**
- Modify: `sidecar/sdkMessageForwarder.mjs`
- Test: `sidecar/sdkMessageForwarder.test.mjs`

**Interfaces:**
- Produces: `{ ev: "auth_required", message: "请在助手设置中填写 API Key 和请求地址" }` through the existing `emit` handler.
- Consumes: SDK `error` and `auth_status` messages.

- [ ] Add a failing test for `Not logged in · Please run /login` and a control test for an unrelated network error.
- [ ] Run `node --test sidecar/sdkMessageForwarder.test.mjs` and confirm `auth_required` is not yet emitted.
- [ ] Add a narrow login-error classifier and emit `auth_required`; preserve normal error forwarding.
- [ ] Re-run the Sidecar forwarding tests and confirm they pass.

### Task 3: Open the Existing API Configuration Experience

**Files:**
- Modify: `src/workbench/composables/useAgent.js`
- Test: `src/workbench/composables/useAgent.test.js`

**Interfaces:**
- Consumes: Sidecar `auth_required` event.
- Produces: `onboardingComplete.value = false`, an idle/retryable Agent state, and a Chinese configuration message.

- [ ] Add a failing composable test that sends an `auth_required` event after session startup and asserts the onboarding/configuration surface is re-enabled.
- [ ] Run `node --test src/workbench/composables/useAgent.test.js` and confirm the new assertion fails.
- [ ] Handle `auth_required`, reset the failed session start, and retain the user's last prompt for retry.
- [ ] Re-run the composable and shell tests and confirm they pass.

### Task 4: Verify the Complete Product Flow

**Files:**
- Modify only if verification exposes a scoped defect.

- [ ] Run `node --test sidecar`.
- [ ] Run `node --test src/workbench`.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml agent`.
- [ ] Run `npm.cmd run build`.
- [ ] Launch the frontend/full app and verify the local-Claude path plus the API Key/Base URL fallback in the rendered Agent panel.
- [ ] Run `git diff --check` and inspect `git diff` to ensure the pre-existing `src-tauri/Cargo.toml` edit remains untouched.
