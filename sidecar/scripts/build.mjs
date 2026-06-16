import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureNativeBinaryResource } from "./nativeBinaryResource.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outFile = "../src-tauri/resources/agent-runner.mjs";

await mkdir(dirname(outFile), { recursive: true });

await build({
  entryPoints: ["./agent-runner.mjs"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: outFile,
  external: [],
});

console.log(`Bundled sidecar to ${outFile}`);

// The Claude Agent SDK requires a native CLI binary at runtime. When the
// sidecar is bundled into a single .mjs file, the SDK can no longer resolve the
// optional dependency from node_modules, so we copy the platform-specific
// binary next to the bundled sidecar as a Tauri resource.
const nativeBinarySource = resolveNativeBinarySource();
if (nativeBinarySource) {
  const destName =
    process.platform === "win32"
      ? "claude-code-native.exe"
      : "claude-code-native";
  const destPath = join(dirname(outFile), destName);
  const result = await ensureNativeBinaryResource(nativeBinarySource, destPath);
  console.log(
    `${result.action === "skipped" ? "Kept existing" : "Copied"} native CLI binary (${(result.size / 1024 / 1024).toFixed(1)} MB) at ${destPath}`
  );
} else {
  console.warn(
    `No native CLI binary found for ${process.platform}-${process.arch}. ` +
      `The agent will not work in the bundled app unless the binary is provided manually.`
  );
}

function resolveNativeBinarySource() {
  const packageName = platformPackageName();
  if (!packageName) return null;

  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  const candidate = join(
    __dirname,
    "..",
    "node_modules",
    "@anthropic-ai",
    packageName,
    binaryName
  );

  return existsSync(candidate) ? candidate : null;
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
