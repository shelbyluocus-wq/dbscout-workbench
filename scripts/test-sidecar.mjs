import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { collectTestFiles } from "./test-files.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const files = await collectTestFiles(path.resolve(scriptsDirectory, "../sidecar"), {
  ignoredDirectories: new Set(["node_modules", "resources"]),
});

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
