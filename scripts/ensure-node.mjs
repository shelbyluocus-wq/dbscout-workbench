// Ensures the portable Node runtime is present under
// `src-tauri/resources/node/` before Tauri touches the `resources/node/*`
// glob in tauri.conf.json. Without this, `cargo build` / `tauri dev` fail
// on a fresh clone with:
//   glob pattern resources/node/* path not found or didn't match any files.
//
// The directory is gitignored (it's a ~80MB binary), so it must be populated
// out of band. This script is the "out of band": if the binary is already
// there it returns immediately; otherwise it downloads it via fetch-node.
//
// Wired into both `tauri dev` (scripts/tauri-dev.mjs) and the release
// `beforeBuildCommand` so a fresh clone Just Works.
//
// Set DBSCOUT_SKIP_NODE_FETCH=1 to bypass (e.g. when iterating on pure Rust
// and you don't want the download, at the cost of the build failing on the
// resources glob — useful only with a matching tauri.conf override).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledNodeExists, fetchNode, hostPlatformKey } from "./fetch-node.mjs";

const SKIP = process.env.DBSCOUT_SKIP_NODE_FETCH === "1";

export async function ensureNode() {
  if (SKIP) {
    console.log("[ensure-node] DBSCOUT_SKIP_NODE_FETCH=1, skipping");
    return;
  }
  if (bundledNodeExists()) {
    return;
  }
  console.log("[ensure-node] Bundled Node missing, fetching…");
  await fetchNode(hostPlatformKey());
}

// When invoked directly (`node scripts/ensure-node.mjs`) run immediately.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  ensureNode().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
