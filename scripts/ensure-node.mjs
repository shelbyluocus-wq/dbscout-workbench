// Ensures the portable development/runtime-packaging Node binary is present
// under `src-tauri/resources/node/`. The production app no longer bundles
// this directory; `tauri dev` still uses it directly so developers can run the
// built-in assistant without installing the separately published AI runtime.
//
// The directory is gitignored, so this helper fetches the pinned binary only
// when the development or agent-runtime packaging workflow needs it.
// Set DBSCOUT_SKIP_NODE_FETCH=1 to bypass the fetch for non-AI development.
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
  console.log("[ensure-node] Local portable Node missing, fetching…");
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
