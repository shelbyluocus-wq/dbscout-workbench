import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const viteBin = require.resolve("vite/bin/vite.js");

import {
  DEFAULT_DEV_HOST,
  DEFAULT_DEV_PORT,
  buildDevServerUrl,
  findAvailablePort,
} from "./dev-port.mjs";

const host = process.env.VITE_DEV_HOST || process.env.TAURI_DEV_HOST || DEFAULT_DEV_HOST;
const requestedPort = Number(process.env.VITE_DEV_PORT || process.env.PORT || DEFAULT_DEV_PORT);
const port = await findAvailablePort({ start: requestedPort, host });
const devUrl = buildDevServerUrl(host, port);

if (port !== requestedPort) {
  console.log(`[dev] Port ${requestedPort} is in use, using ${devUrl}`);
} else {
  console.log(`[dev] Starting dev server at ${devUrl}`);
}

const viteArgs = ["--host", host, "--port", String(port), "--strictPort"];
const child = spawn(process.execPath, [viteBin, ...viteArgs], {
  stdio: "inherit",
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