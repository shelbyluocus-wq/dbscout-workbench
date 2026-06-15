import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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
