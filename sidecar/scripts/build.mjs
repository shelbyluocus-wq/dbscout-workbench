import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeCliBinaryName,
  nativeSdkPackageName,
} from "../nativePlatform.mjs";
import { ensureNativeBinaryResource } from "./nativeBinaryResource.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outFile = "../src-tauri/resources/agent-runner.mjs";
const mcpOutFile = "../src-tauri/resources/mcp-server.mjs";

await mkdir(dirname(outFile), { recursive: true });

if (!process.argv.includes("--mcp-only")) await build({
  entryPoints: ["./agent-runner.mjs"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: outFile,
  external: [],
});

if (!process.argv.includes("--mcp-only")) console.log(`Bundled sidecar to ${outFile}`);

await build({
  entryPoints: ["./mcp-server.mjs"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: mcpOutFile,
  external: [],
  // xlsx loads Node built-ins through require(), so expose require inside the ESM bundle.
  banner: {
    js: 'import { createRequire as __dbscoutCreateRequire } from "node:module"; const require = __dbscoutCreateRequire(import.meta.url);',
  },
});

console.log(`Bundled external MCP server to ${mcpOutFile}`);

// The Claude Agent SDK requires a native CLI binary at runtime. When the
// sidecar is bundled into a single .mjs file, the SDK can no longer resolve the
// optional dependency from node_modules, so we copy the platform-specific
// binary into the local resources staging area. Development uses it directly,
// and `release:agent-runtime` packages it separately; Tauri intentionally does
// not include this large binary in the main installer.
const nativeBinarySource = process.argv.includes("--mcp-only") ? null : resolveNativeBinarySource();
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
} else if (!process.argv.includes("--mcp-only")) {
  console.warn(
    `No native CLI binary found for ${process.platform}-${process.arch}. ` +
      `Desktop development and AI runtime packaging require this binary.`
  );
}

function resolveNativeBinarySource() {
  const packageName = nativeSdkPackageName();
  if (!packageName) return null;

  const binaryName = nativeCliBinaryName();
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
