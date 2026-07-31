import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
  DEFAULT_DEV_HOST,
  DEFAULT_DEV_PORT,
  buildDevServerUrl,
  findAvailablePort,
} from "./dev-port.mjs";
import { ensureNode } from "./ensure-node.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overlayPath = path.join(rootDir, ".dev-server.tauri.json");
const host = process.env.VITE_DEV_HOST || process.env.TAURI_DEV_HOST || DEFAULT_DEV_HOST;
const requestedPort = Number(process.env.VITE_DEV_PORT || process.env.PORT || DEFAULT_DEV_PORT);
const port = await findAvailablePort({ start: requestedPort, host });
const devUrl = buildDevServerUrl(host, port);

// Development keeps using the gitignored local Node runtime even though
// production installers obtain it from the separately published AI package.
await ensureNode();

writeFileSync(
  overlayPath,
  `${JSON.stringify({ build: { devUrl } }, null, 2)}\n`,
  "utf8",
);

if (port !== requestedPort) {
  console.log(`[tauri dev] Port ${requestedPort} is in use, using ${devUrl}`);
} else {
  console.log(`[tauri dev] Using dev server at ${devUrl}`);
}

const tauriBin = path.join(rootDir, "node_modules", "@tauri-apps", "cli", "tauri.js");
const tauriArgs = ["dev", "-c", ".dev-server.tauri.json", ...process.argv.slice(2)];
const child = spawn(process.execPath, [tauriBin, ...tauriArgs], {
  stdio: "inherit",
  cwd: rootDir,
  env: {
    ...process.env,
    VITE_DEV_PORT: String(port),
    VITE_DEV_HOST: host,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
