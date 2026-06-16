import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadModule() {
  const searchParams = new URLSearchParams({ t: Date.now().toString() });
  const url = new URL(
    `./resolveNativeCli.mjs?${searchParams.toString()}`,
    import.meta.url
  );
  return import(url.href);
}

describe("resolveNativeCliPath", () => {
  const originalEnv = process.env.DBSCOUT_AGENT_NATIVE_CLI_PATH;

  after(async () => {
    if (originalEnv === undefined) {
      delete process.env.DBSCOUT_AGENT_NATIVE_CLI_PATH;
    } else {
      process.env.DBSCOUT_AGENT_NATIVE_CLI_PATH = originalEnv;
    }
  });

  it("prefers the DBSCOUT_AGENT_NATIVE_CLI_PATH environment variable when the file exists", async () => {
    const expected = join(__dirname, "resolve-native-cli-test-dummy");
    await writeFile(expected, "");
    process.env.DBSCOUT_AGENT_NATIVE_CLI_PATH = expected;

    try {
      const { resolveNativeCliPath } = await loadModule();
      const actual = resolveNativeCliPath();
      assert.equal(actual, expected);
    } finally {
      await rm(expected, { force: true });
    }
  });

  it("falls back to the bundled binary next to the sidecar module", async () => {
    delete process.env.DBSCOUT_AGENT_NATIVE_CLI_PATH;

    const bundledName =
      process.platform === "win32"
        ? "claude-code-native.exe"
        : "claude-code-native";
    const bundled = join(__dirname, bundledName);
    await writeFile(bundled, "");

    try {
      const { resolveNativeCliPath } = await loadModule();
      const actual = resolveNativeCliPath();
      assert.equal(actual, bundled);
    } finally {
      await rm(bundled, { force: true });
    }
  });

  it("falls back to the installed optional SDK package in node_modules", async () => {
    delete process.env.DBSCOUT_AGENT_NATIVE_CLI_PATH;

    // Ensure no bundled file interferes.
    const bundledName =
      process.platform === "win32"
        ? "claude-code-native.exe"
        : "claude-code-native";
    const bundled = join(__dirname, bundledName);
    const { resolveNativeCliPath } = await loadModule();

    let actual;
    try {
      await rm(bundled, { force: true });
      actual = resolveNativeCliPath();
    } finally {
      // restore is not needed; the file did not exist before.
    }

    assert.ok(actual, "expected a non-null path from node_modules");
    assert.match(actual, /claude-agent-sdk-/);
    const expectedBinary =
      process.platform === "win32" ? "claude.exe" : "claude";
    assert.ok(actual.endsWith(expectedBinary));
  });
});
