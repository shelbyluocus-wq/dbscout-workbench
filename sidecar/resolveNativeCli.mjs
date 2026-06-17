import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the path to the native Claude Code CLI binary for the current
 * platform. The SDK needs this path explicitly when the sidecar is bundled
 * into a single file (esbuild removes the node_modules layout that the SDK
 * normally uses for its optional native dependency lookup).
 *
 * Resolution order:
 * 1. DBSCOUT_AGENT_NATIVE_CLI_PATH environment variable (set by the Rust host).
 * 2. A bundled binary next to the sidecar script: claude-code-native or
 *    claude-code-native.exe.
 * 3. The locally installed optional SDK package in development
 *    (node_modules/@anthropic-ai/claude-agent-sdk-<platform>/claude[.exe]).
 *
 * Returns null if no binary can be found so callers can surface a helpful
 * error instead of the SDK's generic message.
 */
export function resolveNativeCliPath() {
  const envPath = process.env.DBSCOUT_AGENT_NATIVE_CLI_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const bundled = resolveBundledBinary();
  if (bundled) {
    return bundled;
  }

  return resolveNodeModulesBinary();
}

function resolveBundledBinary() {
  const sidecarDir = sidecarDirectory();
  if (!sidecarDir) return null;

  // On Windows the executable must carry the .exe extension; prefer it.
  const candidates =
    process.platform === "win32"
      ? [
          join(sidecarDir, "claude-code-native.exe"),
          join(sidecarDir, "claude-code-native"),
        ]
      : [
          join(sidecarDir, "claude-code-native"),
          join(sidecarDir, "claude-code-native.exe"),
        ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveNodeModulesBinary() {
  const packageName = platformPackageName();
  if (!packageName) return null;

  try {
    const moduleDir = fileURLToPath(
      new URL(`./node_modules/@anthropic-ai/${packageName}`, import.meta.url)
    );
    const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
    const candidate = join(moduleDir, binaryName);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function sidecarDirectory() {
  try {
    const sidecarFile = fileURLToPath(import.meta.url);
    return dirname(sidecarFile);
  } catch {
    return null;
  }
}

function platformPackageName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    return arch === "arm64"
      ? "claude-agent-sdk-win32-arm64"
      : "claude-agent-sdk-win32-x64";
  }

  if (platform === "darwin") {
    return arch === "arm64"
      ? "claude-agent-sdk-darwin-arm64"
      : "claude-agent-sdk-darwin-x64";
  }

  if (platform === "linux") {
    if (arch === "arm64") {
      return isMusl()
        ? "claude-agent-sdk-linux-arm64-musl"
        : "claude-agent-sdk-linux-arm64";
    }
    return isMusl()
      ? "claude-agent-sdk-linux-x64-musl"
      : "claude-agent-sdk-linux-x64";
  }

  return null;
}

function isMusl() {
  try {
    const report =
      typeof process.report?.getReport === "function"
        ? process.report.getReport()
        : null;
    const libc = report?.header?.libc;
    if (libc) {
      return String(libc).toLowerCase().includes("musl");
    }
  } catch {
    // ignore
  }
  return false;
}
